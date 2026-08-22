/**
 * Этапы флоу: имя, уровень, назначение. Упрощённая «Волна»: приём задания текстом, разбор,
 * постановка, план, итерации реализации с адвокатом, тесты, опциональная визуальная проверка,
 * закрытие. Доставки (коммит, push, PR, трекер) в этой версии нет.
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

/** Обязанности этапа. Идут перед инструкцией, чтобы запись в журнал не зависела от текста этапа. */
export function stageDuties(stage: Stage, ctx: { task: string; journalRel: string; logRel: string; iteration: number }): string {
	const lines = [
		`## Обязанности на этапе (уровень: ${stage.level})`,
		"",
		`1. Работать по инструкции ниже. Задача ${ctx.task}, итерация этапа ${ctx.iteration}.`,
		`2. В конце этапа записать секцию в лог: инструмент volna_journal, action=log. Формат и метку времени`,
		"   ставит инструмент - руками markdown журнала не писать.",
		"3. На границе отдачи хода человеку и перед сжатием контекста переписать «Состояние»:",
		"   volna_journal, action=state. Внутри автопрохода хватает одной перезаписи в конце цепочки.",
		"4. Переход на следующий этап - volna_stage, а не текст «перехожу к…»: этап в журнале ставит инструмент.",
	];
	if (stage.level === "required") {
		lines.push("5. Уровень required: необратимое действие этапа делать только по явному «да» человека.");
	} else if (stage.level === "expected") {
		lines.push("5. Уровень expected: этап проходится по умолчанию, пропуск - с причиной в журнал (volna_stage, skip).");
	} else {
		lines.push("5. Уровень optional: этап по ситуации. Не нужен - сказать одной строкой и идти дальше.");
	}
	lines.push(
		"",
		`Журнал задачи: ${ctx.journalRel} (состояние), ${ctx.logRel} (лог итераций, append-only).`,
		"Сработал СТОП-критерий (постановка неоднозначна, нет данных, нужен доступ) - остановиться и спросить,",
		"а не достраивать на догадках.",
	);
	return lines.join("\n");
}
