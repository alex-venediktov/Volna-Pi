/**
 * Этапы флоу: имя, уровень, назначение. Упрощённая «Волна»: приём задания текстом, разбор,
 * постановка, план, итерации реализации с адвокатом, тесты, опциональная визуальная проверка,
 * закрытие. Доставки (коммит, push, PR, трекер) в этой версии нет.
 *
 * Место доставки зарезервировано перед close: этап deliver встанет в список здесь и тем самым
 * окажется внутри цикла части - ветка одна на задачу, коммит (и не один, если часть того требует)
 * на каждую часть, а не один коммит на задачу.
 *
 * Имя этапа = имя файла инструкции = значение stage в журнале = хвост имени команды. Одно слово
 * во всех четырёх местах: расхождение здесь означает, что что-то одно неверно.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./paths.ts";

export type StageLevel = "required" | "expected" | "optional";

export interface Stage {
	name: string;
	level: StageLevel;
	title: string;
	/** Что предлагается следующим при обычном ходе работы. */
	next?: string;
}

export const STAGES: Stage[] = [
	{ name: "intake", level: "required", title: "принять задание текстом, карточка задачи, журнал", next: "analyze" },
	{ name: "analyze", level: "expected", title: "разбор задания: код, похожие места, вопросы", next: "spec" },
	{ name: "spec", level: "expected", title: "постановка своими словами, критерии приёмки, расхождения", next: "plan" },
	{ name: "plan", level: "expected", title: "план правок по файлам, порядок, риски", next: "implement" },
	{ name: "implement", level: "expected", title: "итерация правок по плану", next: "advocate" },
	{ name: "advocate", level: "expected", title: "адвокат дьявола против своего решения, по полному диффу", next: "unit-tests" },
	{ name: "unit-tests", level: "expected", title: "тесты по конвенциям проекта", next: "visual" },
	{ name: "visual", level: "optional", title: "визуальная проверка: браузер, ошибки консоли, скриншот", next: "close" },
	{ name: "close", level: "required", title: "итог, часы в журнал, завершение задачи", next: undefined },
];

export const STAGE_NAMES = STAGES.map((s) => s.name);

export function findStage(name: string): Stage | undefined {
	return STAGES.find((s) => s.name === name.trim().toLowerCase());
}

/** Позиция этапа для шапки: «5/9». Неизвестный этап - пустая строка, а не выдуманный номер. */
export function stagePosition(name: string): string {
	const index = STAGE_NAMES.indexOf(String(name).trim().toLowerCase());
	return index < 0 ? "" : `${index + 1}/${STAGES.length}`;
}

/** Инструкция этапа из скилла пакета. Файла нет - осмысленная ошибка, а не пустая строка. */
export function stageInstructions(name: string): string {
	const path = join(packageRoot(), "skills", "volna-flow", "stages", `${name}.md`);
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		throw new Error(`Не нашёл инструкцию этапа: ${path}`);
	}
}

/**
 * Обязанности этапа: короткий блок перед инструкцией. По-английски, потому что платится он каждым
 * входом в этап, а токенизаторы локальных моделей на английском экономнее; язык ответов и журнала
 * задаётся здесь же отдельной строкой.
 */
export function stageDuties(stage: Stage, ctx: { task: string; journalRel: string; logRel: string; iteration: number }): string {
	const level =
		stage.level === "required"
			? "required: the irreversible action of this stage needs an explicit yes from the user."
			: stage.level === "expected"
				? "expected: done by default; skipping needs a reason in the journal (volna_stage action=skip)."
				: "optional: by situation. Not needed - say so in one line and move on.";
	return [
		`## Duties (level: ${stage.level})`,
		"",
		`Task ${ctx.task}, stage iteration ${ctx.iteration}. Journal: ${ctx.journalRel} (status), ${ctx.logRel} (append-only log).`,
		"",
		"1. Work per the instructions below.",
		"2. End the stage with volna_journal action=log. The tool sets format and timestamp - never write journal markdown by hand.",
		"3. Rewrite Status (action=state) before handing the turn back and before compaction; once per chain is enough inside a run.",
		"4. Change stage with volna_stage, never by just saying so.",
		`5. ${level}`,
		"",
		"Stop and ask on a stop-criterion (ambiguous statement, missing data or access) instead of guessing.",
		"Talk to the user in Russian; journal entries in Russian.",
	].join("\n");
}
