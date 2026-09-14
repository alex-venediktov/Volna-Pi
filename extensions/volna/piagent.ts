/**
 * Запуск pi отдельным процессом: как позвать сам pi и как прочитать его поток событий.
 *
 * Отдельным модулем, потому что подпроцессов у «Волны» два и они разные по смыслу: адвокат с
 * правами только на чтение и прогон части с правами на запись. Одинаково в них ровно одно - как
 * найти исполняемый файл pi и как собрать из потока json текст, счёт вызовов и метрику.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";

/** Пустая метрика: подпроцесс мог не сделать ни одного вызова, а поле usage обязано быть валидным. */
export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Похож ли путь на CLI самого pi. Проверка нужна потому, что расширение может исполняться не
 * только внутри pi (SDK в чужом приложении, прогон модуля обычным node), и тогда argv[1] - чужой
 * скрипт: запустить его с флагами pi значит запустить не подагента, а что попало.
 */
function looksLikePiCli(scriptPath: string): boolean {
	const norm = scriptPath.split("\\").join("/").toLowerCase();
	if (/\/pi-coding-agent\/dist\/(bun\/)?cli\.js$/.test(norm)) return true;
	const name = basename(norm);
	return name === "pi" || name === "pi.js" || name === "cli.js";
}

/**
 * Как позвать pi: тем же исполняемым файлом, которым запущен родитель, иначе - модулем cli.js из
 * установленного пакета pi. Обёртки вида pi.cmd не годятся: Node на Windows отказывается запускать
 * .cmd без оболочки, а оболочка ломает длинный аргумент с переводами строк, каким и является
 * задание подагенту.
 */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && looksLikePiCli(currentScript) && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	const cli = resolvePiCli();
	if (cli) return { command: process.execPath, args: [cli, ...args] };
	return { command: "pi", args };
}

/**
 * cli.js установленного pi. Обычный resolve тут не работает: pi - ESM-пакет, и его exports не
 * отдаются require, поэтому идём тремя путями - штатный import.meta.resolve, подъём по node_modules
 * от этого модуля и рабочего каталога, глобальные каталоги npm из окружения.
 */
function resolvePiCli(): string | null {
	const relative = join("dist", "cli.js");
	try {
		const resolver = (import.meta as unknown as { resolve?: (specifier: string) => string }).resolve;
		if (resolver) {
			const entry = fileURLToPath(resolver("@earendil-works/pi-coding-agent"));
			const cli = join(dirname(entry), "cli.js");
			if (existsSync(cli)) return cli;
		}
	} catch {}

	const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
	for (const start of starts) {
		let dir = start;
		for (let i = 0; i < 12; i++) {
			const cli = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", relative);
			if (existsSync(cli)) return cli;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const globals = [
		process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : "",
		process.env.npm_config_prefix ? join(process.env.npm_config_prefix, "lib", "node_modules") : "",
		process.env.npm_config_prefix ? join(process.env.npm_config_prefix, "node_modules") : "",
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	];
	for (const root of globals) {
		if (!root) continue;
		const cli = join(root, "@earendil-works", "pi-coding-agent", relative);
		if (existsSync(cli)) return cli;
	}
	return null;
}

/**
 * Снять подпроцесс вместе с его детьми. Обычный kill бьёт только сам pi, а работу в это время
 * делают его дети: оболочка и то, что она запустила (на Windows это ещё и MSYS-утилиты вроде
 * find.exe, по ядру на каждую). После снятого по таймауту прогона они остаются жить, копятся от
 * прогона к прогону и забирают машину у следующего - поэтому снимается дерево, а не процесс.
 */
function killTree(proc: ReturnType<typeof spawn>): void {
	const pid = proc.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true }).unref();
		} catch {}
		try {
			proc.kill("SIGKILL");
		} catch {}
		return;
	}
	// Группа процессов есть потому, что подпроцесс запущен detached: без неё сигнал получил бы
	// только сам pi, а оболочка с её детьми осталась бы работать.
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			proc.kill("SIGTERM");
		} catch {}
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}
	}, 5000).unref();
}

export interface RunProgress {
	(update: { toolCalls: number; lastText: string }): void;
}

export interface PiRunResult {
	/** Тексты ответов подпроцесса по порядку: отчётом считается последний. */
	texts: string[];
	usage: Usage;
	toolCalls: number;
	exitCode: number;
	stderr: string;
	/** Процесс сняли по таймауту или по отмене хода - вывод частичный. */
	aborted: boolean;
	model?: string;
}

/**
 * Прогон pi в режиме json и разбор его потока событий. Наружу отдаётся всё, что успело прийти:
 * прерванный подпроцесс тоже несёт полезный вывод, и выбрасывать его молча нельзя.
 */
export async function runPiAgent(
	args: string[],
	options: { cwd: string; timeoutMs?: number; signal?: AbortSignal; onProgress?: RunProgress },
): Promise<PiRunResult> {
	const result: PiRunResult = {
		texts: [],
		usage: emptyUsage(),
		toolCalls: 0,
		exitCode: 0,
		stderr: "",
		aborted: false,
	};

	result.exitCode = await new Promise<number>((resolveExit) => {
		const invocation = piInvocation(args);
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				// Своя группа процессов: по ней снимается всё дерево подпроцесса, а не один pi.
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			result.stderr += `не удалось запустить ${invocation.command}: ${String(error)}`;
			resolveExit(1);
			return;
		}
		let buffer = "";
		const timer = options.timeoutMs
			? setTimeout(() => {
					result.aborted = true;
					killTree(proc);
				}, options.timeoutMs)
			: null;

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "tool_execution_start") {
				result.toolCalls++;
				options.onProgress?.({ toolCalls: result.toolCalls, lastText: result.texts.at(-1) ?? "" });
				return;
			}
			if (event.type !== "message_end" || !event.message) return;
			const message = event.message;
			if (message.role !== "assistant") return;
			const usage = message.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.totalTokens = usage.totalTokens || result.usage.totalTokens;
				result.usage.cost.total += usage.cost?.total || 0;
			}
			if (!result.model && message.model) result.model = message.model;
			const text = (Array.isArray(message.content) ? message.content : [])
				.filter((block: any) => block?.type === "text")
				.map((block: any) => block.text)
				.join("\n")
				.trim();
			if (text) {
				result.texts.push(text);
				options.onProgress?.({ toolCalls: result.toolCalls, lastText: text });
			}
		};

		proc.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		proc.stderr?.on("data", (data) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) handleLine(buffer);
			if (timer) clearTimeout(timer);
			resolveExit(code ?? 0);
		});
		proc.on("error", (error) => {
			result.stderr += `\n${String(error)}`;
			if (timer) clearTimeout(timer);
			resolveExit(1);
		});
		if (options.signal) {
			const kill = () => {
				result.aborted = true;
				killTree(proc);
			};
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
	});

	return result;
}
