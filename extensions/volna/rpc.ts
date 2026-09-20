/**
 * Сеанс pi отдельным процессом в режиме rpc: подача заданий, поток событий, ответы на диалоги.
 *
 * Отличие от `piagent.ts` в том, ради чего режим и выбран: процесс живёт между заданиями, и ход
 * можно прервать командой `abort`, а потом попросить продолжения - контекст при этом остаётся.
 * Одноразовый прогон `--mode json -p` такого рычага не имеет: там на молчащую модель есть только
 * снятие дерева процессов, то есть потеря всей работы хода.
 *
 * Диалоги расширений в этом режиме идут по тому же потоку (`extension_ui_request`), и отвечает на
 * них клиент. Неотвеченный диалог держит сессию молча до сторожа простоя, поэтому ответ даётся
 * всегда - и всегда отрицательный: согласия человека у прогона нет, и выдавать его за данное
 * нельзя. Сам вопрос уходит в итог хода: он и есть развилка, ради которой прогон останавливается.
 */
import { spawn } from "node:child_process";
import type { Usage } from "@earendil-works/pi-ai";
import { emptyUsage, killTree, piInvocation } from "./piagent.ts";

/** Чем толкать молчащую модель. Просьба короткая: длинная сама съедает остаток хода. */
export const NUDGE =
	"Прошлый ход прерван по таймауту: ответа не было слишком долго. Скажи одной строкой, на чём встал, и продолжай с этого места.";

/** Методы, которые ждут ответа клиента. Остальные - уведомления, их можно не замечать. */
const DIALOG_METHODS = ["select", "confirm", "input", "editor"];

/** О чём сессия спросила человека. Вопрос любого вида останавливает прогон. */
export interface RpcAsk {
	method: string;
	title: string;
	message: string;
}

export interface RpcTurnResult {
	/** Ответы модели по порядку: итогом хода считается последний. */
	texts: string[];
	usage: Usage;
	toolCalls: number;
	/** Вопросы человеку, на которые прогон ответил отказом. */
	asks: RpcAsk[];
	/** Предупреждения и ошибки, которые сессия показала бы человеку. */
	notes: string[];
	/** Сколько раз сторож прерывал молчание и просил продолжить. */
	nudges: number;
	/** Ход прерван сторожем и продолжения не получил: работа хода неполная. */
	aborted: boolean;
	/** Процесс pi умер до конца хода. */
	exited: boolean;
	/** Сессия не начала ход: признаков работы не пришло вовсе. */
	stalled: boolean;
	/** Ход прерван наблюдением по ходу: причина словами вызывающего. */
	stoppedBy: string;
	stderr: string;
}

export interface RpcSessionOptions {
	cwd: string;
	/** Аргументы поверх `--mode rpc`: модель, провайдер и прочее. */
	args?: string[];
	/** Сколько миллисекунд молчания считать зависанием. Ноль или отсутствие - сторожа нет. */
	idleMs?: number;
	/**
	 * Сколько ждать первого признака хода. Порог отдельный от `idleMs` потому, что сессия, которая
	 * не начала ход (нет модели, отказ провайдера), молчит навсегда, и ждать её десять минут значит
	 * узнать о неудачном запуске через десять минут.
	 */
	startMs?: number;
	/** Чем толкать молчащую модель после прерывания хода. */
	nudge?: string;
	/** Сколько раз толкать, прежде чем считать ход потерянным. */
	maxNudges?: number;
	/** Ход прогона наружу: строка события на каждое событие потока. */
	onEvent?: (event: RpcEvent) => void;
	/**
	 * Наблюдение по ходу: зовётся тем же таймером, что и сторож простоя. Непустая строка -
	 * причина прервать ход. Нужно потому, что после хода разбирать нечего, пока ход идёт:
	 * сессия, работающая без остановки, управления не возвращает.
	 */
	watch?: (state: { toolCalls: number; elapsedMs: number; repeats: number; lastCall: string }) => string | null;
	signal?: AbortSignal;
	/** Чем поднимать сессию вместо самого pi. Нужно тесту протокола: живой pi требует модели. */
	exec?: { command: string; args: string[] };
}

export interface RpcEvent {
	type?: string;
	[key: string]: unknown;
}

export interface RpcSession {
	/** Подать задание и дождаться, пока сессия осядет. */
	prompt(text: string): Promise<RpcTurnResult>;
	/** Снять процесс вместе с детьми. Возвращает код возврата, если он успел прийти. */
	close(): Promise<number | null>;
	/** Процесс ещё жив. */
	alive(): boolean;
}

/**
 * Разобрать поток на записи JSONL. Делить можно только по `\n`: готовые построчные читалки Node
 * режут ещё и по U+2028 и U+2029, а те - законные символы внутри строки JSON.
 */
export function splitJsonl(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter((line) => line.trim() !== "");
	return { lines, rest };
}

/**
 * Ответ на диалог расширения: отказ в любом виде, какого бы вида вопрос ни был. Не диалог - null,
 * такие запросы ответа не ждут.
 */
export function answerToAsk(request: RpcEvent): { type: string; id: string; confirmed?: boolean; cancelled?: boolean } | null {
	const method = String(request.method ?? "");
	const id = String(request.id ?? "");
	if (!id || !DIALOG_METHODS.includes(method)) return null;
	if (method === "confirm") return { type: "extension_ui_response", id, confirmed: false };
	return { type: "extension_ui_response", id, cancelled: true };
}

/** Описание вопроса для итога хода. Поля у разных методов разные, годится любое непустое. */
function askFromRequest(request: RpcEvent): RpcAsk {
	const title = String(request.title ?? request.message ?? request.placeholder ?? "");
	const message = String(request.message ?? request.prefill ?? "");
	return { method: String(request.method ?? ""), title, message };
}

/** Текст ответа модели из события `message_end`. */
function assistantText(message: any): string {
	const content = Array.isArray(message?.content) ? message.content : [];
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

/**
 * Поднять pi в режиме rpc. Сессии не отключаются намеренно: остановленный прогон человек
 * открывает через `/resume` и видит, на чём сессия встала, а не только итог драйвера.
 */
export function startRpcSession(options: RpcSessionOptions): RpcSession {
	const invocation = options.exec ?? piInvocation(["--mode", "rpc", ...(options.args ?? [])]);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: options.cwd,
		shell: false,
		// Своя группа процессов: по ней снимается всё дерево, а не один pi.
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stderr = "";
	let exitCode: number | null = null;
	let running = true;
	proc.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	proc.on("exit", (code) => {
		running = false;
		exitCode = code ?? 0;
	});
	proc.on("error", (error) => {
		running = false;
		stderr += `не удалось запустить ${invocation.command}: ${String(error)}`;
	});

	// Отправленное драйвером идёт в тот же поток событий пометкой `driver:`. Иначе в стенограмме
	// видно только половину разговора: ответы сессии есть, а на что она отвечала - нет.
	const send = (command: Record<string, unknown>): void => {
		if (!running) return;
		options.onEvent?.({ ...command, type: `driver:${String(command.type ?? "?")}` });
		try {
			proc.stdin?.write(`${JSON.stringify(command)}\n`);
		} catch {}
	};

	let buffer = "";
	let onLine: ((event: RpcEvent) => void) | null = null;
	proc.stdout?.on("data", (chunk) => {
		buffer += String(chunk);
		const { lines, rest } = splitJsonl(buffer);
		buffer = rest;
		for (const line of lines) {
			let event: RpcEvent;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			options.onEvent?.(event);
			onLine?.(event);
		}
	});

	const prompt = (text: string): Promise<RpcTurnResult> =>
		new Promise<RpcTurnResult>((resolve) => {
			const result: RpcTurnResult = {
				texts: [],
				usage: emptyUsage(),
				toolCalls: 0,
				asks: [],
				notes: [],
				nudges: 0,
				aborted: false,
				exited: false,
				stalled: false,
				stoppedBy: "",
				stderr: "",
			};
			if (!running) {
				result.exited = true;
				result.stderr = stderr;
				resolve(result);
				return;
			}

			const idleMs = options.idleMs ?? 0;
			const startMs = options.startMs ?? 0;
			const maxNudges = options.maxNudges ?? 0;
			let last = Date.now();
			let started = false;
			let interrupted = false;
			let done = false;
			let watch: ReturnType<typeof setInterval> | null = null;
			let lastCall = "";
			let repeats = 0;

			const finish = (): void => {
				if (done) return;
				done = true;
				if (watch) clearInterval(watch);
				proc.off("exit", onExit);
				options.signal?.removeEventListener("abort", onSignal);
				onLine = null;
				result.stderr = stderr;
				resolve(result);
			};

			const onExit = (): void => {
				result.exited = true;
				finish();
			};
			const onSignal = (): void => {
				result.aborted = true;
				killTree(proc);
				finish();
			};
			proc.on("exit", onExit);
			options.signal?.addEventListener("abort", onSignal, { once: true });

			onLine = (event) => {
				last = Date.now();
				if (event.type === "agent_start") started = true;
				if (event.type === "extension_ui_request") {
					const answer = answerToAsk(event);
					if (answer) {
						result.asks.push(askFromRequest(event));
						send(answer);
						return;
					}
					const kind = String((event as any).notifyType ?? "");
					if (event.method === "notify" && (kind === "error" || kind === "warning")) {
						result.notes.push(String((event as any).message ?? ""));
					}
					return;
				}
				if (event.type === "tool_execution_start") {
					result.toolCalls++;
					// Подпись вызова: имя инструмента и его аргументы. По ней считается, сколько раз
					// подряд повторён один и тот же вызов - повтор не ловится ни сторожем простоя
					// (сессия не молчит), ни потолком вызовов (он срабатывает много позже).
					const signature = `${String((event as any).toolName ?? "")} ${JSON.stringify((event as any).args ?? {})}`;
					if (signature === lastCall) repeats++;
					else {
						repeats = 1;
						lastCall = signature;
					}
					return;
				}
				// Отвергнутая команда иначе выглядит молчанием: ответа нет, ход не идёт, и причина
				// известна только pi.
				if (event.type === "response" && (event as any).success === false) {
					result.notes.push(`команда ${String((event as any).command ?? "")} отклонена: ${String((event as any).error ?? "")}`);
					return;
				}
				if (event.type === "message_end") {
					const message: any = (event as any).message;
					if (message?.role !== "assistant") return;
					const usage = message.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.totalTokens = usage.totalTokens || result.usage.totalTokens;
						result.usage.cost.total += usage.cost?.total || 0;
					}
					const text = assistantText(message);
					if (text) result.texts.push(text);
					return;
				}
				if (event.type !== "agent_settled") return;
				// Оседание после прерывания - это не конец работы, а место, где можно попросить
				// продолжения: контекст хода цел, и модель дописывает начатое, а не начинает заново.
				if (interrupted && result.nudges < maxNudges) {
					interrupted = false;
					result.nudges++;
					last = Date.now();
					send({ type: "prompt", message: options.nudge ?? NUDGE });
					return;
				}
				if (interrupted) result.aborted = true;
				finish();
			};

			// До первого признака хода сторож считает по своему порогу: не начавшуюся сессию нечего
			// прерывать, её надо признать несостоявшейся и отдать человеку.
			const tick = Math.max(100, Math.min(15000, Math.floor(Math.min(idleMs || startMs, startMs || idleMs) / 4)));
			const began = Date.now();
			watch =
				idleMs || startMs || options.watch
					? setInterval(() => {
							if (done || interrupted) return;
							// Наблюдение идёт по ходу, а не после него: сессия, которая работает без
							// остановки, до разбора итога не доходит никогда - управление возвращается
							// только на оседании. Политику решает вызывающий, сеанс лишь прерывает.
							const verdict = options.watch?.({ toolCalls: result.toolCalls, elapsedMs: Date.now() - began, repeats, lastCall });
							if (verdict) {
								result.stoppedBy = verdict;
								interrupted = true;
								last = Date.now();
								send({ type: "abort" });
								return;
							}
							const quiet = Date.now() - last;
							if (!started && startMs) {
								if (quiet < startMs) return;
								result.stalled = true;
								finish();
								return;
							}
							if (!idleMs || quiet < idleMs) return;
							interrupted = true;
							last = Date.now();
							send({ type: "abort" });
						}, tick)
					: null;
			watch?.unref?.();

			send({ type: "prompt", message: text });
		});

	return {
		prompt,
		alive: () => running,
		close: async () => {
			if (running) killTree(proc);
			// Ожидание конца процесса ограничено: снятое дерево иногда отчитывается не сразу, и
			// вечное ожидание здесь остановило бы весь прогон.
			for (let i = 0; i < 50 && running; i++) await new Promise((r) => setTimeout(r, 100));
			return exitCode;
		},
	};
}
