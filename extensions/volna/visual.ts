/**
 * Визуальная проверка веб-выхода через Chrome DevTools Protocol: ошибки консоли, необработанные
 * исключения, ответы 4xx/5xx, скриншот.
 *
 * Браузер берётся тот, которым уже управляет расширение pi-chrome-devtools: его endpoint, его
 * настройки, его автозапуск. Своего движка «Волна» не поднимает - два браузера в одном проекте
 * означают две разные картинки и спор о том, какая из них правда.
 *
 * Автоматический критерий здесь настоящий: ошибка в консоли или ответ 4xx это красный результат.
 * Соответствие макету автоматика не проверяет - для этого в отчёте есть путь к скриншоту.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CdpSession, closePage, createPage, type DevToolsPage, listPages, probeEndpoint, resolveEndpoint } from "./cdp.ts";
import { stamp } from "./journal.ts";
import { volnaPaths } from "./paths.ts";

export interface VisualStep {
	type: string;
	selector?: string;
	value?: string;
	key?: string;
	url?: string;
	ms?: number;
	y?: number;
}

export interface VisualInput {
	volnaDir: string;
	task: string;
	url: string;
	steps?: VisualStep[];
	waitFor?: string;
	waitMs?: number;
	viewport?: { width: number; height: number };
	timeoutMs?: number;
	/** Endpoint из профиля проекта: перебивает настройки pi-chrome-devtools. */
	endpoint?: string;
	/** Работать в уже открытой вкладке, а не в новой: полезно, когда состояние набрано руками. */
	reusePage?: boolean;
}

export interface VisualProblem {
	kind: "консоль" | "исключение" | "ответ" | "запрос";
	text: string;
}

export interface VisualReport {
	ok: boolean;
	verdict: "чисто" | "ошибки" | "не выполнено";
	summary: string;
	screenshotPath: string | null;
	problems: VisualProblem[];
	details: Record<string, unknown>;
}

/** Отчёт «проверка не состоялась»: причина плюс что с этим делать. Без вердикта о качестве кода. */
function notRun(summary: string, details: Record<string, unknown> = {}): VisualReport {
	return { ok: false, verdict: "не выполнено", summary, screenshotPath: null, problems: [], details };
}

export async function runVisualCheck(input: VisualInput, signal?: AbortSignal): Promise<VisualReport> {
	const timeoutMs = input.timeoutMs ?? 30000;
	const endpointInfo = resolveEndpoint(input.endpoint);
	const version = await probeEndpoint(endpointInfo.endpoint);
	if (!version) {
		return notRun(
			[
				`Браузер по адресу ${endpointInfo.endpoint} не отвечает (источник адреса: ${endpointInfo.source}).`,
				"Проверка идёт в том браузере, которым управляет расширение pi-chrome-devtools.",
				endpointInfo.autoLaunchEnabled
					? "Подними его инструментом chrome_devtools_navigate (он запускает браузер сам) и повтори volna_visual."
					: "Автозапуск выключен в pi-chrome-devtools.json - запусти браузер сам: chrome --remote-debugging-port=9222.",
				"Другой адрес - строка «endpoint браузера» в .volna/project.md.",
			].join(" "),
			{ endpoint: endpointInfo.endpoint, source: endpointInfo.source },
		);
	}

	let page: DevToolsPage;
	let createdPage = false;
	try {
		if (input.reusePage) {
			const pages = await listPages(endpointInfo.endpoint);
			const existing = pages[0];
			if (!existing) return notRun(`В браузере (${endpointInfo.endpoint}) нет открытых страниц, а reuse_page просит работать в открытой.`);
			page = existing;
		} else {
			page = await createPage(endpointInfo.endpoint, "about:blank");
			createdPage = true;
		}
	} catch (error) {
		return notRun(`Не удалось получить страницу в браузере: ${String((error as Error).message ?? error)}`);
	}

	const problems: VisualProblem[] = [];
	const warnings: string[] = [];
	let session: CdpSession | null = null;
	try {
		session = await CdpSession.connect(page.webSocketDebuggerUrl!, timeoutMs);
		const events = collectEvents(session, problems, warnings);

		await session.send("Runtime.enable");
		await session.send("Log.enable");
		await session.send("Network.enable");
		await session.send("Page.enable");
		if (input.viewport) {
			await session.send("Emulation.setDeviceMetricsOverride", {
				width: input.viewport.width,
				height: input.viewport.height,
				deviceScaleFactor: 1,
				mobile: false,
			});
		}

		await navigate(session, input.url, timeoutMs, signal);
		for (const step of input.steps ?? []) {
			await runStep(session, step, timeoutMs, signal);
		}
		if (input.waitFor) await waitForSelector(session, input.waitFor, timeoutMs, signal);
		if (input.waitMs) await sleep(input.waitMs, signal);
		await sleep(300, signal);

		const paths = volnaPaths(input.volnaDir);
		mkdirSync(paths.visualDir, { recursive: true });
		const screenshotPath = join(paths.visualDir, `${input.task}-${stamp().replace(/[^\d]/g, "")}.png`);
		const shot = await session.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
		writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));

		const info = await session.send<{ result?: { value?: { title?: string; url?: string } } }>("Runtime.evaluate", {
			expression: "({ title: document.title, url: location.href })",
			returnByValue: true,
		});
		const title = info.result?.value?.title ?? "";
		const finalUrl = info.result?.value?.url ?? input.url;

		return report({
			endpoint: endpointInfo.endpoint,
			endpointSource: endpointInfo.source,
			browser: version,
			url: finalUrl,
			title,
			screenshotPath,
			problems,
			warnings,
			counts: events.counts(),
		});
	} catch (error) {
		return notRun(
			[
				`Проверка прервалась: ${String((error as Error).message ?? error)}.`,
				problems.length ? `До этого успели собраться ошибки: ${problems.length}.` : "",
			]
				.filter(Boolean)
				.join(" "),
			{ problems },
		);
	} finally {
		session?.close();
		if (createdPage) await closePage(endpointInfo.endpoint, page.id);
	}
}

/** Скриншот как содержимое для модели. Возвращается только когда профиль это разрешил. */
export function screenshotContent(path: string): { type: "image"; data: string; mimeType: string } | null {
	try {
		return { type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/png" };
	} catch {
		return null;
	}
}

/**
 * Подписка на события страницы. Предупреждения консоли собираются отдельно от ошибок: они не
 * должны красить вердикт, но видеть их полезно.
 */
function collectEvents(session: CdpSession, problems: VisualProblem[], warnings: string[]) {
	let requests = 0;
	let responses = 0;
	session.on((method, params) => {
		if (method === "Runtime.consoleAPICalled") {
			const type = String(params.type ?? "");
			const text = formatConsoleArgs(params.args ?? []);
			if (type === "error" || type === "assert") problems.push({ kind: "консоль", text });
			else if (type === "warning") warnings.push(text);
			return;
		}
		if (method === "Runtime.exceptionThrown") {
			const details = params.exceptionDetails ?? {};
			const text = String(details.exception?.description ?? details.text ?? "необработанное исключение");
			problems.push({ kind: "исключение", text: text.split("\n").slice(0, 3).join(" ") });
			return;
		}
		if (method === "Log.entryAdded") {
			const entry = params.entry ?? {};
			if (entry.level !== "error") return;
			// сетевые ошибки этот канал дублирует: коды ответов и так собираются из Network
			if (entry.source === "network") return;
			const text = `${entry.source ?? "browser"}: ${entry.text ?? ""}`.trim();
			if (!problems.some((problem) => problem.text === text)) problems.push({ kind: "консоль", text });
			return;
		}
		if (method === "Network.requestWillBeSent") {
			requests++;
			return;
		}
		if (method === "Network.responseReceived") {
			responses++;
			const status = Number(params.response?.status ?? 0);
			if (status >= 400) problems.push({ kind: "ответ", text: `${status} ${params.response?.url ?? ""}` });
			return;
		}
		if (method === "Network.loadingFailed") {
			const text = String(params.errorText ?? "запрос не выполнен");
			// отменённые запросы - обычное дело при переходах, ошибкой их считать нельзя
			if (text === "net::ERR_ABORTED") return;
			problems.push({ kind: "запрос", text });
		}
	});
	return { counts: () => ({ requests, responses }) };
}

function formatConsoleArgs(args: any[]): string {
	return args
		.map((arg) => {
			if (arg?.value !== undefined) return String(arg.value);
			if (arg?.description) return String(arg.description);
			if (arg?.preview?.description) return String(arg.preview.description);
			return arg?.type ? `[${arg.type}]` : "";
		})
		.join(" ")
		.trim()
		.slice(0, 300);
}

/** Переход с ожиданием загрузки: без ожидания скриншот снимается с пустой страницы. */
async function navigate(session: CdpSession, url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const loaded = waitForEvent(session, "Page.loadEventFired", timeoutMs);
	const result = await session.send<{ errorText?: string }>("Page.navigate", { url }, timeoutMs);
	if (result.errorText) throw new Error(`переход на ${url} не удался: ${result.errorText}`);
	await loaded;
	await sleep(200, signal);
}

function waitForEvent(session: CdpSession, method: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		session.on((eventMethod) => {
			if (eventMethod !== method) return;
			clearTimeout(timer);
			resolve();
		});
	});
}

/**
 * Шаги сценария. Набор намеренно узкий: страница проверяется, а не автоматизируется целиком.
 * Клик и ввод идут через JS в странице - это работает для любой вёрстки и не требует координат.
 */
async function runStep(session: CdpSession, step: VisualStep, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const type = String(step.type ?? "").toLowerCase();
	if (type === "goto") {
		if (!step.url) throw new Error("шаг goto без url");
		return navigate(session, step.url, timeoutMs, signal);
	}
	if (type === "wait") return sleep(Number(step.ms) || 500, signal);
	if (type === "waitfor") {
		if (!step.selector) throw new Error("шаг waitfor без селектора");
		return waitForSelector(session, step.selector, timeoutMs, signal);
	}
	if (type === "scroll") {
		await evaluate(session, `window.scrollBy(0, ${Number(step.y) || 600}); true`);
		return sleep(200, signal);
	}
	if (type === "click") {
		if (!step.selector) throw new Error("шаг click без селектора");
		await evaluate(
			session,
			`(() => { const el = document.querySelector(${JSON.stringify(step.selector)});
			  if (!el) throw new Error("не нашёл элемент: " + ${JSON.stringify(step.selector)});
			  el.click(); return true; })()`,
		);
		return sleep(300, signal);
	}
	if (type === "fill") {
		if (!step.selector) throw new Error("шаг fill без селектора");
		await evaluate(
			session,
			`(() => { const el = document.querySelector(${JSON.stringify(step.selector)});
			  if (!el) throw new Error("не нашёл элемент: " + ${JSON.stringify(step.selector)});
			  el.focus(); el.value = ${JSON.stringify(step.value ?? "")};
			  el.dispatchEvent(new Event("input", { bubbles: true }));
			  el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
		);
		return sleep(150, signal);
	}
	if (type === "press") {
		const key = step.key || "Enter";
		if (step.selector) {
			await evaluate(
				session,
				`(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); if (el) el.focus(); return true; })()`,
			);
		}
		await session.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: keyCode(key) });
		await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: keyCode(key) });
		return sleep(300, signal);
	}
	throw new Error(`неизвестный шаг: ${step.type}`);
}

/** Код клавиши для тех клавиш, которым он нужен: без него Enter в формах не срабатывает. */
function keyCode(key: string): number {
	const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38 };
	return codes[key] ?? 0;
}

async function evaluate(session: CdpSession, expression: string): Promise<void> {
	const result = await session.send<{ exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	const failure = result.exceptionDetails;
	if (failure) throw new Error(failure.exception?.description ?? failure.text ?? "шаг не выполнился");
}

async function waitForSelector(session: CdpSession, selector: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await session.send<{ result?: { value?: boolean } }>("Runtime.evaluate", {
			expression: `!!document.querySelector(${JSON.stringify(selector)})`,
			returnByValue: true,
		});
		if (result.result?.value === true) return;
		await sleep(200, signal);
	}
	throw new Error(`не дождался элемента: ${selector}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("проверка отменена"));
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("проверка отменена"));
			},
			{ once: true },
		);
	});
}

function report(input: {
	endpoint: string;
	endpointSource: string;
	browser: string;
	url: string;
	title: string;
	screenshotPath: string;
	problems: VisualProblem[];
	warnings: string[];
	counts: { requests: number; responses: number };
}): VisualReport {
	const lines: string[] = [];
	lines.push(`Страница: ${input.url}${input.title ? ` — «${input.title}»` : ""}`);
	lines.push(`Браузер: ${input.browser} (${input.endpoint}, адрес из: ${input.endpointSource})`);
	lines.push(`Запросов: ${input.counts.requests}, ответов: ${input.counts.responses}`);

	const byKind = (kind: VisualProblem["kind"]) => input.problems.filter((problem) => problem.kind === kind);
	for (const kind of ["консоль", "исключение", "ответ", "запрос"] as const) {
		const items = byKind(kind);
		if (!items.length) continue;
		lines.push(`${label(kind)} (${items.length}):`);
		for (const item of items.slice(0, 15)) lines.push(`  - ${item.text}`);
		if (items.length > 15) lines.push(`  … и ещё ${items.length - 15}`);
	}
	if (input.warnings.length) lines.push(`Предупреждения консоли: ${input.warnings.length} (на вердикт не влияют)`);
	if (!input.problems.length) lines.push("Ошибок консоли и сети нет.");
	lines.push(`Скриншот: ${input.screenshotPath}`);
	lines.push(
		input.problems.length
			? "Вердикт автоматики: ошибки. Это находки для журнала и новой итерации implement."
			: "Вердикт автоматики: чисто. Соответствие макету и смысл картинки автоматика не проверяет - смотрит человек.",
	);

	return {
		ok: true,
		verdict: input.problems.length ? "ошибки" : "чисто",
		summary: lines.join("\n"),
		screenshotPath: input.screenshotPath,
		problems: input.problems,
		details: {
			endpoint: input.endpoint,
			browser: input.browser,
			url: input.url,
			title: input.title,
			problems: input.problems,
			warnings: input.warnings.length,
			counts: input.counts,
		},
	};
}

function label(kind: VisualProblem["kind"]): string {
	if (kind === "консоль") return "Ошибки консоли";
	if (kind === "исключение") return "Необработанные исключения страницы";
	if (kind === "ответ") return "Ответы 4xx/5xx";
	return "Неудавшиеся запросы";
}
