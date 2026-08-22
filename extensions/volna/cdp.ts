/**
 * Минимальный клиент Chrome DevTools Protocol: тот же транспорт, которым пользуется расширение
 * pi-chrome-devtools (HTTP-маршруты /json/* и WebSocket на страницу).
 *
 * Своя реализация вместо зависимости на playwright и вместо импорта чужого пакета: браузер
 * поднимает и настраивает расширение pi-chrome-devtools, а «Волне» нужен только тот же endpoint.
 * Ставить второй движок браузера ради сбора ошибок консоли не за что.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";

export interface DevToolsPage {
	id: string;
	type: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

/**
 * Откуда взялся endpoint: настройка pi-chrome-devtools, переменные окружения, значение по
 * умолчанию. Источник печатается в отчёте - иначе непонятно, к какому браузеру мы подключились.
 */
export interface EndpointInfo {
	endpoint: string;
	source: "профиль «Волны»" | "переменные окружения" | "настройки pi-chrome-devtools" | "значение по умолчанию";
	autoLaunchEnabled: boolean;
}

/** Каталог настроек pi: тот же, что читает pi-chrome-devtools. */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Endpoint браузера. Приоритет как у самого pi-chrome-devtools: переменные окружения, затем файл
 * настроек, затем 127.0.0.1:9222. Строка профиля «Волны» бьёт всё - это осознанный выбор проекта.
 */
export function resolveEndpoint(profileEndpoint?: string): EndpointInfo {
	let autoLaunchEnabled = true;
	let fileEndpoint = "";
	const settingsPath = join(agentDir(), "pi-chrome-devtools.json");
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
			const browser = parsed?.browser ?? {};
			if (typeof browser.endpoint === "string") fileEndpoint = browser.endpoint;
			if (browser.autoLaunch === false) autoLaunchEnabled = false;
		} catch {
			// битый файл настроек - не наша забота: работаем со значением по умолчанию
		}
	}
	if (process.env.PI_CHROME_DEVTOOLS_AUTO_LAUNCH === "false") autoLaunchEnabled = false;

	if (profileEndpoint?.trim()) {
		return { endpoint: normalize(profileEndpoint.trim()), source: "профиль «Волны»", autoLaunchEnabled };
	}
	const envHost = process.env.PI_CHROME_DEVTOOLS_HOST;
	const envPort = process.env.PI_CHROME_DEVTOOLS_PORT;
	if (envHost || envPort) {
		const host = envHost || "127.0.0.1";
		const port = envPort || "9222";
		return { endpoint: `http://${host}:${port}`, source: "переменные окружения", autoLaunchEnabled };
	}
	if (fileEndpoint) {
		return { endpoint: normalize(fileEndpoint), source: "настройки pi-chrome-devtools", autoLaunchEnabled };
	}
	return { endpoint: DEFAULT_ENDPOINT, source: "значение по умолчанию", autoLaunchEnabled };
}

function normalize(endpoint: string): string {
	return endpoint.replace(/\/+$/, "");
}

/** Отвечает ли браузер по этому endpoint. Ответ - строка версии либо null. */
export async function probeEndpoint(endpoint: string, timeoutMs = 3000): Promise<string | null> {
	try {
		const version = await fetchJson<{ Browser?: string }>(`${endpoint}/json/version`, timeoutMs);
		return version.Browser ?? "неизвестная сборка";
	} catch {
		return null;
	}
}

export async function listPages(endpoint: string, timeoutMs = 5000): Promise<DevToolsPage[]> {
	const pages = await fetchJson<DevToolsPage[]>(`${endpoint}/json/list`, timeoutMs);
	return pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl);
}

/** Новая страница в том же браузере: PUT /json/new, как это делает pi-chrome-devtools. */
export async function createPage(endpoint: string, url: string, timeoutMs = 10000): Promise<DevToolsPage> {
	const page = await fetchJson<DevToolsPage>(`${endpoint}/json/new?${encodeURIComponent(url)}`, timeoutMs, "PUT");
	if (page.type !== "page" || !page.webSocketDebuggerUrl) {
		throw new Error("браузер создал цель, которая не является страницей");
	}
	return page;
}

/** Закрыть страницу. Закрываем только то, что открыли сами: браузер чужой. */
export async function closePage(endpoint: string, pageId: string): Promise<void> {
	try {
		await fetchText(`${endpoint}/json/close/${pageId}`, 3000);
	} catch {
		// не закрылась - не беда: лишняя вкладка дешевле упавшей проверки
	}
}

async function fetchJson<T>(url: string, timeoutMs: number, method = "GET"): Promise<T> {
	return JSON.parse(await fetchText(url, timeoutMs, method)) as T;
}

async function fetchText(url: string, timeoutMs: number, method = "GET"): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { method, signal: controller.signal });
		if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status}`);
		return await response.text();
	} finally {
		clearTimeout(timer);
	}
}

export type CdpEventHandler = (method: string, params: any) => void;

/**
 * Соединение со страницей. Вызовы и события идут по одному сокету: события нужны затем, что именно
 * в них приходят ошибки консоли, исключения страницы и коды ответов - то, за чем этап и затевался.
 */
export class CdpSession {
	private readonly socket: WebSocket;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly handlers: CdpEventHandler[] = [];
	private closed = false;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			let message: any;
			try {
				message = JSON.parse(String((event as MessageEvent).data));
			} catch {
				return;
			}
			if (typeof message.id === "number") {
				const pending = this.pending.get(message.id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(message.id);
				if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
				else pending.resolve(message.result);
				return;
			}
			if (typeof message.method === "string") {
				for (const handler of this.handlers) handler(message.method, message.params ?? {});
			}
		});
		socket.addEventListener("close", () => {
			this.closed = true;
			this.rejectAll(new Error("соединение с браузером закрыто"));
		});
		socket.addEventListener("error", () => {
			this.rejectAll(new Error("ошибка соединения с браузером"));
		});
	}

	static connect(webSocketUrl: string, timeoutMs = 10000): Promise<CdpSession> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(webSocketUrl);
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error(`не дождался соединения с браузером: ${webSocketUrl}`));
			}, timeoutMs);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				resolve(new CdpSession(socket));
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error(`не удалось подключиться к странице: ${webSocketUrl}`));
			});
		});
	}

	on(handler: CdpEventHandler): void {
		this.handlers.push(handler);
	}

	send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
		if (this.closed) return Promise.reject(new Error("соединение с браузером уже закрыто"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`не дождался ответа браузера на ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		this.closed = true;
		try {
			this.socket.close();
		} catch {
			// сокет мог уже закрыться сам
		}
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}
