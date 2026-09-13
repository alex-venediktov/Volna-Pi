/**
 * Прогон части задачи подагентом: отдельный процесс pi с чистым контекстом и правами на запись.
 *
 * Смысл не в цене, а в изоляции окна: часть читает много и правит много, и весь этот контекст
 * оркестратору не нужен - ему нужен отчёт. Кэш подагент не переиспользует: он стартует со своим
 * промптом, и вложенный контекст оплачивается заново.
 *
 * Ветвью флоу подагент не становится. Журнал один («Состояние» переписывается, лог append-only),
 * `state.json` указывает на одну активную задачу и по ней держит гейт правок - параллельные ветви
 * дают гонку записи. Поэтому части идут по одной, а этапы, журнал и закрытие части остаются на
 * оркестраторе: подагент делает работу части и отчитывается, расширения «Волны» ему выключены.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { journalIssues } from "./journal.ts";
import { type Part, partsFromState, unfinishedParts } from "./parts.ts";
import { displayPath, loadActive } from "./state.ts";
import { packageRoot, volnaPaths, workspaceRoot } from "./paths.ts";
import { emptyUsage, type RunProgress, runPiAgent } from "./piagent.ts";

/** Чем кончилась часть. Вопрос и блокер равно останавливают прогон: развилка есть развилка. */
export type PartOutcome = "сделано" | "вопрос" | "блокер" | "не определён";

export interface PartRunInput {
	volnaDir: string;
	task: string;
	part: Part;
	/** «Готово, когда»: без критерия подагент не знает, где остановиться, и вернёт «кажется, готово». */
	criterion: string;
	/** Постановка и решения из журнала: подагент читает журнал с диска, это - адрес и акцент. */
	focus?: string;
	model?: string;
	timeoutMs?: number;
	/** Оставить расширения pi включёнными: нужно, когда провайдер модели регистрируется расширением. */
	keepExtensions?: boolean;
}

export interface PartRunResult {
	outcome: PartOutcome;
	report: string;
	part: number;
	title: string;
	exitCode: number;
	stderr: string;
	usage: Usage;
	toolCalls: number;
	model?: string;
}

export interface PartsReadiness {
	ok: boolean;
	message: string;
	parts: Part[];
	/** Часть, которую надо гнать следующей: в работе, а если такой нет - первая не начатая. */
	next?: Part;
	left: number;
}

/**
 * Можно ли запускать прогон. Проверки в коде, а не в просьбе к модели: запуск подагента на
 * отставшем журнале даёт работу по устаревшей картине, и увидит это только человек - потом.
 */
export function partsRunReadiness(cwd: string): PartsReadiness {
	const active = loadActive(cwd);
	if (!active) {
		return { ok: false, message: "Активной задачи нет: прогонять нечего. Принять задание - /volna:task.", parts: [], left: 0 };
	}
	const parts = partsFromState(active.stateSection);
	if (!parts.length) {
		return {
			ok: false,
			message: "Задача на части не разбита: прогонять нечего. Обычный ход - /volna:task или /volna:spec.",
			parts,
			left: 0,
		};
	}
	const left = unfinishedParts(parts);
	if (!left.length) {
		return { ok: false, message: "Незакрытых частей нет: задача идёт к закрытию (/volna:close).", parts, left: 0 };
	}
	if (left.length === 1) {
		return {
			ok: false,
			message: `Осталась одна часть («${left[0].title}») - заводить подагента ради неё дороже, чем сделать: делай сам.`,
			parts,
			next: left[0],
			left: 1,
		};
	}
	// Подагент читает журнал с диска, а не пересказ оркестратора: отставшее «Состояние» он примет
	// за правду. Поэтому замок чек-пойнта - условие запуска, а не пожелание
	const issues = journalIssues({
		text: active.text,
		stateSection: active.stateSection,
		logText: active.logText,
		fm: active.fm,
	});
	if (issues.length) {
		return {
			ok: false,
			message: [
				"Журнал отстал, а подагент читает его с диска:",
				...issues.map((issue) => `- ${issue}`),
				"Перепиши «Состояние» (volna_journal action=state) и повтори.",
			].join("\n"),
			parts,
			next: left[0],
			left: left.length,
		};
	}
	return { ok: true, message: "", parts, next: left[0], left: left.length };
}

/** Порядок прогона для оркестратора: текст лежит в скилле пакета, а не в коде. */
export function partsRunInstructions(): string {
	const path = join(packageRoot(), "skills", "volna-flow", "references", "parts-run.md");
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		throw new Error(`Не нашёл порядок прогона частей: ${path}`);
	}
}

/** Карта частей для человека: что сделано, что идёт, что осталось. */
export function partsMap(parts: Part[]): string {
	return parts
		.map((part) => `${part.number}. ${part.title} - ${part.status}${part.note ? ` (${part.note})` : ""}`)
		.join("\n");
}

/** Запустить подагента на одну часть. Промпт роли лежит в скилле пакета, а не в коде. */
export async function runPart(
	input: PartRunInput,
	signal?: AbortSignal,
	onProgress?: RunProgress,
): Promise<PartRunResult> {
	const paths = volnaPaths(input.volnaDir);
	const systemPromptPath = join(packageRoot(), "skills", "volna-flow", "agents", "part.md");
	const systemPrompt = readFileSync(systemPromptPath, "utf8");
	const tmpPromptPath = join(tmpdir(), `volna-part-${process.pid}-${Date.now()}.md`);
	writeFileSync(tmpPromptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });

	const args = ["--mode", "json", "-p", "--no-session"];
	// Расширения выключены: инструменты «Волны» подагенту не нужны, а гейт правок и журнал -
	// это как раз то, чего он касаться не должен. Запреты становятся устройством, а не просьбой
	if (!input.keepExtensions) args.push("--no-extensions");
	args.push("--no-skills", "--no-prompt-templates", "--tools", "read,write,edit,grep,find,ls,bash", "--append-system-prompt", tmpPromptPath);
	if (input.model) args.push("--model", input.model);

	const prompt = [
		`Задача ${input.task}, часть ${input.part.number}: ${input.part.title}.`,
		"",
		`Готово, когда: ${input.criterion}`,
		"",
		"Журнал задачи (читай с диска, он источник правды о постановке и решениях):",
		`- состояние: ${displayPath(input.volnaDir, paths.journal(input.task))}`,
		`- лог: ${displayPath(input.volnaDir, paths.log(input.task))}`,
		"",
		input.focus ? `На что смотреть в первую очередь: ${input.focus}` : "",
		"",
		"Делай только эту часть. Не коммить, не пушь, не трогай другие части и журнал.",
	]
		.filter((line) => line !== "")
		.join("\n");
	args.push(prompt);

	const run = await runPiAgent(args, {
		cwd: workspaceRoot(input.volnaDir),
		timeoutMs: input.timeoutMs,
		signal,
		onProgress,
	});

	const result: PartRunResult = {
		outcome: "не определён",
		report: run.texts.at(-1) ?? "",
		part: input.part.number,
		title: input.part.title,
		exitCode: run.exitCode,
		stderr: run.stderr,
		usage: run.usage ?? emptyUsage(),
		toolCalls: run.toolCalls,
		model: run.model ?? input.model,
	};
	if (run.aborted) {
		result.outcome = "блокер";
		result.report = `Подагент прерван${input.timeoutMs ? " (таймаут или отмена)" : ""}. Частичный вывод:\n\n${result.report}`;
		return result;
	}
	if (run.exitCode !== 0 && !result.report) {
		result.outcome = "блокер";
		result.report = `Подагент завершился с кодом ${run.exitCode}. stderr:\n${run.stderr.trim().slice(-2000) || "(пусто)"}`;
		return result;
	}
	result.outcome = parseOutcome(result.report);
	return result;
}

/**
 * Итог из последней строки отчёта. Не нашли - «не определён»: догадываться нельзя, а прогон на
 * неразобранном итоге обязан встать так же, как на вопросе.
 */
export function parseOutcome(report: string): PartOutcome {
	const match = /ИТОГ\s*:\s*(сделано|вопрос|блокер)/i.exec(report);
	if (!match) return "не определён";
	const value = match[1].toLowerCase();
	if (value === "сделано") return "сделано";
	if (value === "вопрос") return "вопрос";
	return "блокер";
}

/** Идти ли дальше по списку. Всё, кроме чистого «сделано», останавливает прогон. */
export function continues(outcome: PartOutcome): boolean {
	return outcome === "сделано";
}
