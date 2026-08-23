/**
 * Адвокат дьявола отдельным процессом pi.
 *
 * В одном контексте адвокат вырождается в «перечитал свой вывод и согласился»: та же модель,
 * та же история, те же слепые зоны. Поэтому проверка идёт в отдельном процессе с чистым
 * контекстом, своим системным промптом и правами только на чтение - он не видел, как писался
 * этот код, и судит по диффу, а не по намерению.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import { collectChanges } from "./changes.ts";
import { stamp } from "./journal.ts";
import { advocateDiffDir, packageRoot, workspaceRoot } from "./paths.ts";

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
	/** Профиль проекта: из него берётся источник изменений (команда проекта, игнор). */
	profile?: Record<string, string>;
}

export interface AdvocateResult {
	verdict: Verdict;
	report: string;
	diffPath: string;
	diffStat: string;
	/** Откуда взялись изменения: git, svn, hg, команда проекта, снимок «Волны». */
	changeSource: string;
	changeBase: string;
	changeNotes: string[];
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
 * Изменения в файл, а не в промпт: размер диффа не должен решать, поместится ли проверка в контекст.
 * Родительская сессия дифф не читает вовсе - она за него и так заплатила при правках.
 *
 * Откуда берутся изменения, решает changes.ts: git, svn, hg, команда проекта или снимок дерева.
 */
export async function collectDiff(
	exec: ExecLike,
	volnaDir: string,
	task: string,
	base: string,
	profile: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<{ path: string; stat: string; filesChanged: number; empty: boolean; kind: string; base: string; notes: string[] }> {
	const dir = advocateDiffDir(volnaDir, task);
	mkdirSync(dir, { recursive: true });

	const changes = await collectChanges(exec, { volnaDir, profile, base, signal });
	const path = join(dir, `${task}-${stamp().replace(/[^\d]/g, "")}.diff`);
	writeFileSync(path, changes.diff || "(изменений нет)", "utf8");

	const stat = changes.files.length
		? changes.files.map((file) => `${file.status}: ${file.path}`).join("\n")
		: "";
	return {
		path,
		stat,
		filesChanged: changes.files.length,
		empty: changes.files.length === 0 && !changes.diff.trim(),
		kind: changes.kind,
		base: changes.base,
		notes: changes.notes,
	};
}

/** Убрать диффы задачи: они нужны, пока задача идёт, и не переживают её закрытие. */
export function dropDiffs(volnaDir: string, task: string): boolean {
	const dir = advocateDiffDir(volnaDir, task);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
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
	const diff = await collectDiff(exec, input.volnaDir, input.task, base, input.profile ?? {}, signal);

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
		`Задача ${input.task}. Проверь сделанные изменения.`,
		`Источник изменений: ${diff.kind}, база сравнения: ${diff.base}.`,
		"",
		`Изменения целиком лежат в файле: ${diff.path}`,
		"Читай его инструментом read (файл может быть большим - читай частями), при необходимости",
		"смотри исходники в рабочем дереве.",
		diff.notes.length ? `\nЧто знать про полноту этих данных:\n- ${diff.notes.join("\n- ")}` : "",
		"",
		"Изменённые файлы:",
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
		changeSource: diff.kind,
		changeBase: diff.base,
		changeNotes: diff.notes,
		filesChanged: diff.filesChanged,
		exitCode: 0,
		stderr: "",
		usage: emptyUsage(),
		toolCalls: 0,
		model: input.model,
	};

	if (diff.empty) {
		result.verdict = "нужен человек";
		result.report = [
			`Изменений не видно: источник - ${diff.kind}, база - ${diff.base}.`,
			diff.notes.length ? `Причина может быть здесь: ${diff.notes.join("; ")}.` : "Убедись, что правки сделаны и база указана верно.",
		].join(" ");
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
