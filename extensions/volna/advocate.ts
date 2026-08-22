/**
 * Адвокат дьявола отдельным процессом pi.
 *
 * В одном контексте адвокат вырождается в «перечитал свой вывод и согласился»: та же модель,
 * та же история, те же слепые зоны. Поэтому проверка идёт в отдельном процессе с чистым
 * контекстом, своим системным промптом и правами только на чтение - он не видел, как писался
 * этот код, и судит по диффу, а не по намерению.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import { stamp } from "./journal.ts";
import { packageRoot, volnaPaths, workspaceRoot } from "./paths.ts";

export type Verdict = "чисто" | "дефекты" | "нужен человек" | "не определён";

export interface AdvocateInput {
	volnaDir: string;
	task: string;
	/** С чем сравнивать рабочее дерево. По умолчанию HEAD. */
	base?: string;
	/** На что смотреть в первую очередь: находки прошлой итерации, конкретная ветвь, риск. */
	focus?: string;
	/** Критерии приёмки и решения из журнала: адвокат сверяет дифф с ними, а не с догадками. */
	journalContext?: string;
	model?: string;
	timeoutMs?: number;
	/** Оставить расширения pi включёнными: нужно, когда провайдер модели регистрируется расширением. */
	keepExtensions?: boolean;
}

export interface AdvocateResult {
	verdict: Verdict;
	report: string;
	diffPath: string;
	diffStat: string;
	filesChanged: number;
	exitCode: number;
	stderr: string;
	usage: Usage;
	toolCalls: number;
	model?: string;
}

export interface ExecLike {
	(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<{
		stdout: string;
		stderr: string;
		code: number;
	}>;
}

/** Пустая метрика: адвокат мог не сделать ни одного вызова, а поле usage обязано быть валидным. */
function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/**
 * Дифф в файл, а не в промпт: размер диффа не должен решать, поместится ли проверка в контекст.
 * Родительская сессия дифф не читает вовсе - она за него и так заплатила при правках.
 */
export async function collectDiff(
	exec: ExecLike,
	volnaDir: string,
	task: string,
	base: string,
	signal?: AbortSignal,
): Promise<{ path: string; stat: string; filesChanged: number; empty: boolean }> {
	const root = workspaceRoot(volnaDir);
	const paths = volnaPaths(volnaDir);
	const dir = join(paths.root, "advocate");
	mkdirSync(dir, { recursive: true });

	const diff = await exec("git", ["-C", root, "diff", base], { signal });
	const stat = await exec("git", ["-C", root, "diff", "--stat", base], { signal });
	const untracked = await exec("git", ["-C", root, "ls-files", "--others", "--exclude-standard"], { signal });

	const newFiles = untracked.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith(".volna/"));

	let body = diff.stdout;
	for (const file of newFiles) {
		body += `\n\n=== новый файл, ещё не в индексе: ${file} ===\n${newFileContent(join(root, file))}`;
	}

	const path = join(dir, `${task}-${stamp().replace(/[^\d]/g, "")}.diff`);
	writeFileSync(path, body || "(изменений нет)", "utf8");
	const filesChanged = (stat.stdout.match(/\|/g) || []).length + newFiles.length;
	return {
		path,
		stat: [stat.stdout.trim(), newFiles.length ? `новые файлы: ${newFiles.join(", ")}` : ""].filter(Boolean).join("\n"),
		filesChanged,
		empty: !body.trim() && newFiles.length === 0,
	};
}

/** Больше этого файл в дифф не вставляется: адвокат прочитает его сам, если понадобится. */
const MAX_NEW_FILE_BYTES = 256 * 1024;

/**
 * Содержимое ещё не проиндексированного файла для диффа. Крупные и бинарные файлы заменяются
 * строкой с путём: дифф читает модель с ограниченным контекстом, и один забытый в дереве архив
 * вытеснил бы из проверки всё остальное.
 */
function newFileContent(absolute: string): string {
	let size = 0;
	try {
		size = statSync(absolute).size;
	} catch {
		return "(файл недоступен)";
	}
	if (size > MAX_NEW_FILE_BYTES) {
		return `(файл ${Math.round(size / 1024)} КБ - в дифф не вставлен, читай его сам: ${absolute})`;
	}
	let buffer: Buffer;
	try {
		buffer = readFileSync(absolute);
	} catch {
		return "(файл недоступен)";
	}
	if (buffer.subarray(0, 8192).includes(0)) {
		return `(бинарный файл, ${Math.round(size / 1024)} КБ: ${absolute})`;
	}
	return buffer.toString("utf8");
}

/**
 * Похож ли путь на CLI самого pi. Проверка нужна потому, что расширение может исполняться не
 * только внутри pi (SDK в чужом приложении, прогон модуля обычным node), и тогда argv[1] - чужой
 * скрипт: запустить его с флагами pi значит запустить не адвоката, а что попало.
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
 * задание адвокату.
 */
function piInvocation(args: string[]): { command: string; args: string[] } {
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

export interface RunProgress {
	(update: { toolCalls: number; lastText: string }): void;
}

/** Запустить адвоката и вернуть его вердикт. Промпт лежит в скилле пакета, а не в коде. */
export async function runAdvocate(
	exec: ExecLike,
	input: AdvocateInput,
	signal?: AbortSignal,
	onProgress?: RunProgress,
): Promise<AdvocateResult> {
	const base = input.base?.trim() || "HEAD";
	const diff = await collectDiff(exec, input.volnaDir, input.task, base, signal);

	const systemPromptPath = join(packageRoot(), "skills", "volna-flow", "agents", "advocate.md");
	const systemPrompt = readFileSync(systemPromptPath, "utf8");
	const tmpPromptPath = join(tmpdir(), `volna-advocate-${process.pid}-${Date.now()}.md`);
	writeFileSync(tmpPromptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });

	const args = ["--mode", "json", "-p", "--no-session"];
	// Расширения выключены по умолчанию: адвокату не нужны ни инструменты «Волны», ни чужие
	// хуки. Но провайдер модели может приходить именно из расширения - тогда keepExtensions.
	if (!input.keepExtensions) args.push("--no-extensions");
	args.push(
		"--no-skills",
		"--no-prompt-templates",
		"--tools",
		"read,grep,find,ls,bash",
		"--append-system-prompt",
		tmpPromptPath,
	);
	if (input.model) args.push("--model", input.model);

	const prompt = [
		`Задача ${input.task}. Проверь изменения против HEAD-базы ${base}.`,
		"",
		`Дифф целиком лежит в файле: ${diff.path}`,
		"Читай его инструментом read (файл может быть большим - читай частями), при необходимости",
		"смотри исходники в рабочем дереве и историю через bash git.",
		"",
		"Сводка изменений:",
		diff.stat || "(пусто)",
		"",
		input.focus ? `На что смотреть в первую очередь: ${input.focus}` : "",
		"",
		input.journalContext ? `Контекст из журнала задачи (постановка, решения, критерии):\n\n${input.journalContext}` : "",
	]
		.filter((part) => part !== "")
		.join("\n");
	args.push(prompt);

	const result: AdvocateResult = {
		verdict: "не определён",
		report: "",
		diffPath: diff.path,
		diffStat: diff.stat,
		filesChanged: diff.filesChanged,
		exitCode: 0,
		stderr: "",
		usage: emptyUsage(),
		toolCalls: 0,
		model: input.model,
	};

	if (diff.empty) {
		result.verdict = "нужен человек";
		result.report = "Изменений против базы нет - проверять нечего. Убедись, что правки сделаны и база указана верно.";
		try {
			unlinkSync(tmpPromptPath);
		} catch {}
		return result;
	}

	const texts: string[] = [];
	let aborted = false;

	const exitCode = await new Promise<number>((resolveExit) => {
		const invocation = piInvocation(args);
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(invocation.command, invocation.args, {
				cwd: workspaceRoot(input.volnaDir),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			result.stderr += `не удалось запустить ${invocation.command}: ${String(error)}`;
			resolveExit(1);
			return;
		}
		let buffer = "";
		const timer = input.timeoutMs
			? setTimeout(() => {
					aborted = true;
					proc.kill("SIGTERM");
				}, input.timeoutMs)
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
				onProgress?.({ toolCalls: result.toolCalls, lastText: texts.at(-1) ?? "" });
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
				texts.push(text);
				onProgress?.({ toolCalls: result.toolCalls, lastText: text });
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
		if (signal) {
			const kill = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	try {
		unlinkSync(tmpPromptPath);
	} catch {}

	result.exitCode = exitCode;
	result.report = texts.at(-1) ?? "";
	if (aborted) {
		result.verdict = "нужен человек";
		result.report = `Адвокат прерван${input.timeoutMs ? " (таймаут или отмена)" : ""}. Частичный вывод:\n\n${result.report}`;
		return result;
	}
	if (exitCode !== 0 && !result.report) {
		result.verdict = "нужен человек";
		result.report = `Адвокат завершился с кодом ${exitCode}. stderr:\n${result.stderr.trim().slice(-2000) || "(пусто)"}`;
		return result;
	}
	result.verdict = parseVerdict(result.report);
	return result;
}

/** Вердикт из последней строки отчёта. Не нашли - «не определён»: догадываться о вердикте нельзя. */
export function parseVerdict(report: string): Verdict {
	const match = /ВЕРДИКТ\s*:\s*(чисто|дефекты|нужен человек)/i.exec(report);
	if (!match) return "не определён";
	const value = match[1].toLowerCase();
	if (value === "чисто") return "чисто";
	if (value === "дефекты") return "дефекты";
	return "нужен человек";
}
