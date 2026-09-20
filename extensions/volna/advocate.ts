/**
 * Адвокат дьявола отдельным процессом pi.
 *
 * В одном контексте адвокат вырождается в «перечитал свой вывод и согласился»: та же модель,
 * та же история, те же слепые зоны. Поэтому проверка идёт в отдельном процессе с чистым
 * контекстом, своим системным промптом и правами только на чтение - он не видел, как писался
 * этот код, и судит по диффу, а не по намерению.
 *
 * Проверка идёт порциями: один прогон разбирает столько файлов диффа, сколько успевает до
 * таймаута, его вердикт и отчёт остаются в журнале проверок, и следующий прогон берёт следующую
 * порцию (`advocate-batches.ts`). Один длинный прогон на весь дифф этого не даёт: снятый по
 * таймауту процесс уносит с собой всю работу.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	type Batch,
	DEFAULT_BATCH_BYTES,
	type Ledger,
	ledgerSummary,
	planBatch,
	readLedger,
	recordRun,
	splitDiff,
	worstVerdict,
} from "./advocate-batches.ts";
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
	/** Размер порции в байтах диффа: сколько уходит в один прогон. */
	batchBytes?: number;
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
	/** Номер порции этого прогона и сколько порций выходит всего. */
	batch: number;
	batches: number;
	/** Файлы, попавшие в эту порцию. */
	batchFiles: string[];
	/** Файлов проверено прошлыми прогонами и осталось после этого. */
	filesDone: number;
	filesLeft: number;
	/** Файлов в диффе всего: кусков диффа, а не строк `git diff --name-status`. */
	filesTotal: number;
	/** Проверка не закончена: остались файлы, которых ни один прогон не видел. */
	pending: boolean;
	/** Файл с диффом этой порции: его и читает адвокат. */
	batchPath: string;
	/** Итоги прошлых прогонов строками: что уже проверено и с каким вердиктом. */
	runs: string;
	/** Вердикт всей проверки по журналу: худшее из того, что нашли порции. */
	overall: Verdict;
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
): Promise<{
	path: string;
	text: string;
	stat: string;
	filesChanged: number;
	empty: boolean;
	repo: boolean;
	base: string;
	notes: string[];
}> {
	const dir = advocateDiffDir(volnaDir, task);
	mkdirSync(dir, { recursive: true });

	const changes = await collectChanges(exec, { volnaDir, base, signal });
	// Имя постоянное, а не с меткой времени: проверка идёт порциями, и дифф целиком пересобирается
	// на каждом прогоне. С меткой в temp оставалось по копии на прогон - десяток одинаковых файлов
	// на задачу, а история прогонов и так лежит в журнале проверок.
	const path = join(dir, `${task}-full.diff`);
	writeFileSync(path, changes.diff || "(изменений нет)", "utf8");

	const stat = changes.files.length
		? changes.files.map((file) => `${file.status}: ${file.path}`).join("\n")
		: "";
	return {
		path,
		text: changes.diff,
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


/**
 * Запустить адвоката на одну порцию изменений и вернуть её вердикт. Промпт лежит в скилле пакета,
 * а не в коде.
 *
 * Один вызов - одна порция: файлы, которые прошлые прогоны уже разобрали, в дифф этого прогона не
 * попадают, а его итог ложится в журнал проверок. Поэтому снятый по таймауту прогон стоит одной
 * порции, а не всей проверки, и повторный вызов продолжает с того же места.
 */
export async function runAdvocate(
	exec: ExecLike,
	input: AdvocateInput,
	signal?: AbortSignal,
	onProgress?: RunProgress,
): Promise<AdvocateResult> {
	const base = input.base?.trim() || "HEAD";
	const diff = await collectDiff(exec, input.volnaDir, input.task, base, signal);
	const dir = advocateDiffDir(input.volnaDir, input.task);
	const ledger: Ledger = readLedger(dir, diff.base);
	const batch: Batch = planBatch(splitDiff(diff.text), ledger, input.batchBytes || DEFAULT_BATCH_BYTES);

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

	// Путь относительный, от корня проекта: абсолютный на Windows проходит через домашний каталог,
	// и модель его не воспроизводит - см. `paths.ts:advocateDiffDir`.
	const batchPath = relative(workspaceRoot(input.volnaDir), join(dir, `batch-${batch.number}.diff`)).split("\\").join("/");
	const reviewedBefore = ledger.reviewed.map((entry) => entry.file);

	const prompt = [
		`Задача ${input.task}. Проверь сделанные изменения.`,
		`База сравнения: ${diff.base}.`,
		batch.total > 1 ? `Это порция ${batch.number} из ${batch.total}: дифф разрезан по файлам.` : "",
		"",
		`Изменения этой порции лежат в файле: ${batchPath}`,
		"Читай его инструментом read (файл может быть большим - читай частями), при необходимости",
		"смотри исходники в рабочем дереве.",
		"",
		"Файлы этой порции:",
		batch.sections.map((item) => `- ${item.path}`).join("\n"),
		reviewedBefore.length
			? `\nУже разобрано прошлыми порциями (в этот дифф не входит, заново не проси): ${reviewedBefore.join(", ")}`
			: "",
		diff.notes.length ? `\nЧто знать про полноту этих данных:\n- ${diff.notes.join("\n- ")}` : "",
		"",
		"Все изменённые файлы задачи (для понимания, что рядом):",
		diff.stat || "(пусто)",
		"",
		"Вердикт ставь по этой порции: соседние файлы проверяют другие прогоны.",
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
		batch: batch.number,
		batches: Math.max(batch.total, batch.number),
		batchFiles: batch.sections.map((item) => item.path),
		filesDone: batch.filesDone,
		filesLeft: batch.filesLeft,
		filesTotal: batch.filesTotal,
		pending: batch.filesLeft > 0,
		batchPath,
		runs: ledgerSummary(ledger),
		overall: worstVerdict(ledger),
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

	// Очередь пуста: каждый кусок диффа уже разобран какой-то порцией. Проверять заново нечего,
	// и вердикт всей проверки собирается по журналу прогонов.
	if (!batch.sections.length) {
		result.verdict = worstVerdict(ledger);
		result.overall = result.verdict;
		// Прогона не было: номер порции - последний состоявшийся, иначе ответ обещает работу,
		// которой никто не делал.
		result.batch = ledger.runs.length;
		result.batches = ledger.runs.length;
		result.report = [
			`Все изменения уже разобраны: порций ${ledger.runs.length}, файлов ${batch.filesTotal}.`,
			`Вердикт всей проверки: ${result.verdict}.`,
			"",
			ledgerSummary(ledger),
			"",
			`Отчёты порций лежат рядом с диффом: ${dir}`,
			"Правка после находок меняет дифф файла, и такой файл вернётся в очередь сам.",
		].join("\n");
		try {
			unlinkSync(tmpPromptPath);
		} catch {}
		return result;
	}

	writeFileSync(batchPath, batch.sections.map((item) => item.text).join("\n\n"), "utf8");

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
		result.report = [
			`Адвокат прерван${input.timeoutMs ? " (таймаут или отмена)" : ""} на порции ${batch.number}.`,
			`Порция не зачтена: её файлы (${result.batchFiles.join(", ")}) придут в следующий прогон.`,
			"Повторный таймаут значит, что порция велика: уменьши её (batch_kb) и вызови снова.",
			"",
			`Частичный вывод:\n\n${result.report}`,
		].join("\n");
		recordRun({ dir, ledger, batch, verdict: "не определён", report: result.report, at: stamp(), base: diff.base, aborted: true });
		result.runs = ledgerSummary(ledger);
		result.overall = worstVerdict(ledger);
		result.filesLeft += batch.sections.length;
		result.pending = true;
		return result;
	}
	if (run.exitCode !== 0 && !result.report) {
		result.verdict = "нужен человек";
		result.report = `Адвокат завершился с кодом ${run.exitCode}. stderr:\n${result.stderr.trim().slice(-2000) || "(пусто)"}`;
		recordRun({ dir, ledger, batch, verdict: "не определён", report: result.report, at: stamp(), base: diff.base, aborted: true });
		result.runs = ledgerSummary(ledger);
		result.overall = worstVerdict(ledger);
		result.filesLeft += batch.sections.length;
		result.pending = true;
		return result;
	}
	result.verdict = parseVerdict(result.report);
	recordRun({ dir, ledger, batch, verdict: result.verdict, report: result.report, at: stamp(), base: diff.base });
	result.runs = ledgerSummary(ledger);
	result.overall = worstVerdict(ledger);
	// Вердикт «не определён» порцию не зачитывает: её файлы вернутся в следующий прогон, значит
	// остаток не меньше, чем был. Разобранная порция, наоборот, уже проверена - иначе ответ считает
	// проверенным только то, что было до неё, и числа в нём не сходятся с остатком.
	if (result.verdict === "не определён") {
		result.filesLeft += batch.sections.length;
		result.pending = true;
	} else {
		result.filesDone += batch.sections.length;
	}
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
