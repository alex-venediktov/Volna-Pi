/** Флоу и журнал: приём задания, переходы, итерации, пропуск этапа, восстановимость. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enterStage, intake, skipStage, statusReport } from "../extensions/volna/core.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { appendLogSection, journalIssues, nextIteration, writeStateSection } from "../extensions/volna/journal.ts";
import { recall } from "../extensions/volna/recall.ts";
import { loadActive, readState } from "../extensions/volna/state.ts";
import { check, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	const dir = sandbox("flow");
	writeFileSync(join(dir, ".gitignore"), "dist/\n", "utf8");

	const init = initVolna(dir);
	check("init создал .volna", init.created.some((path) => path.endsWith(".volna")));
	check("init дописал .gitignore", readFileSync(join(dir, ".gitignore"), "utf8").includes(".volna/journal/"));

	const taken = intake(dir, { assignment: "Починить показ пустого списка заказов: сейчас белый экран вместо заглушки" });
	check("задание принято", taken.ok, taken.task ?? taken.message.slice(0, 60));
	const volnaDir = join(dir, ".volna");
	const task = readState(volnaDir).active!;
	check("активная задача записана", task === taken.task);
	check("идентификатор из даты и слага", /^\d{6}-[a-z0-9-]+$/.test(task), task);

	const active = loadActive(dir)!;
	check("журнал читается", active.task === task);
	check("задание в логе дословно", active.logText.includes("белый экран"));

	const analyze = await enterStage(dir, "analyze");
	check("вход в этап выдал инструкцию", analyze.ok && analyze.message.includes("Stage 2 · analyze"));
	check("контекст задачи приложен", analyze.message.includes("## Task") && analyze.message.includes("Status from the journal"));
	check("этап записан в журнал", loadActive(dir)!.fm.stage === "analyze");

	appendLogSection(volnaDir, task, {
		stage: "analyze",
		fields: { что: "разобрал список", как: "grep по OrdersList", сделано: "src/orders/List.tsx:42", осталось: "-" },
	});
	await enterStage(dir, "spec");
	check("пройденный этап отмечен", (loadActive(dir)!.fm.stages_done as string[]).includes("analyze"));

	await enterStage(dir, "implement", { reason: "первая правка" });
	appendLogSection(volnaDir, task, {
		stage: "implement",
		fields: { что: "добавил заглушку", как: "src/orders/List.tsx", сделано: "заглушка рендерится", осталось: "-" },
	});
	const second = await enterStage(dir, "implement", { reason: "находка адвоката: не покрыт случай ошибки загрузки" });
	check("повторный заход открыл итерацию", second.iteration === 2, String(second.iteration));
	check("причина возврата в инструкции", second.message.includes("находка адвоката"));
	check("итерация считается по логу", nextIteration(loadActive(dir)!.logText, "implement") === 2);

	const skipped = skipStage(dir, "visual", "консольная утилита, визуального выхода нет");
	check("пропуск записан с причиной", skipped.ok);
	check(
		"причина с запятой не развалилась",
		(loadActive(dir)!.fm.skipped as string[]).some((item) => item === "visual: консольная утилита, визуального выхода нет"),
		(loadActive(dir)!.fm.skipped as string[]).join(" | "),
	);
	check("этап required не пропускается", !skipStage(dir, "close", "не хочу").ok);

	const stale = loadActive(dir)!;
	check("отставание «Состояния» видно", journalIssues(stale).some((issue) => issue.includes("отстало")));
	writeStateSection(
		stale.journalPath,
		{
			goal: "пустой список показывает заглушку",
			done: "заглушка есть",
			next: "прогнать тесты",
			rejected: "правка на бэкенде — заглушка это дело фронта",
		},
		{ logText: stale.logText },
	);
	const fresh = loadActive(dir)!;
	check("после перезаписи замечаний нет", journalIssues(fresh).length === 0, journalIssues(fresh).join("; "));
	check("«отвергнуто» сохранилось", (fresh.stateSection ?? "").includes("**отвергнуто:**"));

	check("поиск находит свой журнал", recall(volnaDir, "заглушка заказов").hits.length > 0);
	check("сводка показывает этап", statusReport(dir).includes("Этап: implement"));
}
