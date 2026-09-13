/**
 * Адвокат дьявола отдельным процессом pi.
 *
 * В одном контексте адвокат вырождается в «перечитал свой вывод и согласился»: та же модель,
 * та же история, те же слепые зоны. Поэтому проверка идёт в отдельном процессе с чистым
 * контекстом, своим системным промптом и правами только на чтение - он не видел, как писался
 * этот код, и судит по диффу, а не по намерению.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { collectChanges, NO_REPO_REASON } from "./changes.ts";
import { stamp } from "./journal.ts";
import { advocateDiffDir, packageRoot, workspaceRoot } from "./paths.ts";
import { emptyUsage, type RunProgress, runPiAgent } from "./piagent.ts";

export type Verdict = "чисто" | "дефекты" | "нужен человек" | "не определён";

export interface AdvocateInput {
	volnaDir: string;
	task: string;
	/** С чем сравнивать рабочее дерево: точка начала части из журнала. По умолчанию HEAD. */
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
	/** Есть ли здесь git: нет - проверять было нечего, и дифф пуст не потому, что правок нет. */
	repo: boolean;
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

/**
 * Изменения в файл, а не в промпт: размер диффа не должен решать, поместится ли проверка в контекст.
 * Родительская сессия дифф не читает вовсе - она за него и так заплатила при правках.
 */
export async function collectDiff(
	exec: ExecLike,
	volnaDir: string,
	task: string,
	base: string,
	signal?: AbortSignal,
): Promise<{ path: string; stat: string; filesChanged: number; empty: boolean; repo: boolean; base: string; notes: string[] }> {
	const dir = advocateDiffDir(volnaDir, task);
	mkdirSync(dir, { recursive: true });

	const changes = await collectChanges(exec, { volnaDir, base, signal });
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
		repo: changes.repo,
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
		`Задача ${input.task}. Проверь сделанные изменения.`,
		`База сравнения: ${diff.base}.`,
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
		repo: diff.repo,
		changeBase: diff.base,
		changeNotes: diff.notes,
		filesChanged: diff.filesChanged,
		exitCode: 0,
		stderr: "",
		usage: emptyUsage(),
		toolCalls: 0,
		model: input.model,
	};

	// Отказ вместо проверки: без git «Волна» не знает, что именно правилось, а разбирать проект
	// целиком - другая работа, и подпроцесс адвоката для неё не нужен.
	if (!diff.repo || diff.empty) {
		result.verdict = "нужен человек";
		result.report = !diff.repo
			? [
					NO_REPO_REASON,
					"Заведи git (git init и первый коммит) - и адвокат заработает, либо пропусти этап с причиной:",
					"volna_stage action=skip, stage=advocate.",
				].join(" ")
			: [
					`Изменений не видно: база - ${diff.base}.`,
					diff.notes.length ? `Причина может быть здесь: ${diff.notes.join("; ")}.` : "Убедись, что правки сделаны и база указана верно.",
				].join(" ");
		try {
			unlinkSync(tmpPromptPath);
		} catch {}
		return result;
	}

	const run = await runPiAgent(args, {
		cwd: workspaceRoot(input.volnaDir),
		timeoutMs: input.timeoutMs,
		signal,
		onProgress,
	});

	try {
		unlinkSync(tmpPromptPath);
	} catch {}

	result.exitCode = run.exitCode;
	result.stderr = run.stderr;
	result.usage = run.usage;
	result.toolCalls = run.toolCalls;
	result.model = run.model ?? result.model;
	result.report = run.texts.at(-1) ?? "";
	if (run.aborted) {
		result.verdict = "нужен человек";
		result.report = `Адвокат прерван${input.timeoutMs ? " (таймаут или отмена)" : ""}. Частичный вывод:\n\n${result.report}`;
		return result;
	}
	if (run.exitCode !== 0 && !result.report) {
		result.verdict = "нужен человек";
		result.report = `Адвокат завершился с кодом ${run.exitCode}. stderr:\n${result.stderr.trim().slice(-2000) || "(пусто)"}`;
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
