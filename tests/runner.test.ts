/**
 * Прогон частей подагентом: условия запуска и разбор отчёта. Сам подпроцесс pi не поднимается -
 * он требует модели, а проверяется то, что обязано работать при любой.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { intake } from "../extensions/volna/core.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { writeStateSection } from "../extensions/volna/journal.ts";
import { volnaPaths } from "../extensions/volna/paths.ts";
import { continues, parseOutcome, partsMap, partsRunInstructions, partsRunReadiness } from "../extensions/volna/runner.ts";
import { readState } from "../extensions/volna/state.ts";
import { check, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	readiness();
	reportParsing();
}

/** Состояние задачи с готовым списком частей: прогон читает его с диска, как подагент. */
function writeParts(volnaDir: string, task: string, parts: string): void {
	const paths = volnaPaths(volnaDir);
	let logText = "";
	try {
		logText = readFileSync(paths.log(task), "utf8");
	} catch {
		logText = "";
	}
	writeStateSection(
		paths.journal(task),
		{ goal: "перенести вику в pi", done: "ядро перенесено", next: "прогнать остаток частей", parts },
		{ logText },
	);
}

/** Условия прогона: активная задача, список частей, остаток больше одной, свежий журнал. */
function readiness(): void {
	const dir = sandbox("runner-readiness");
	check("без .volna прогонять нечего", !partsRunReadiness(dir).ok);

	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	check("без активной задачи прогон не запускается", !partsRunReadiness(dir).ok);

	intake(dir, { assignment: "Перенести вику выводов в pi" });
	const task = readState(volnaDir).active ?? "";
	const undivided = partsRunReadiness(dir);
	check("неразбитая задача прогона не требует", !undivided.ok && undivided.message.includes("на части не разбита"), undivided.message);

	writeParts(volnaDir, task, "1. ядро вики - сделано (2026-09-13, 4ч)\n2. указатели - не начата");
	const single = partsRunReadiness(dir);
	check("на одной незакрытой части прогон отговаривает", !single.ok && single.message.includes("делай сам"), single.message);
	check("остаток посчитан", single.left === 1, String(single.left));

	writeParts(volnaDir, task, "1. ядро вики - сделано (2026-09-13, 4ч)\n2. указатели - не начата\n3. команды - не начата");
	const ready = partsRunReadiness(dir);
	check("на двух незакрытых частях прогон готов", ready.ok, ready.message);
	check("следующей идёт первая незакрытая", ready.next?.number === 2, String(ready.next?.number));
	check("карта частей показывает все три", partsMap(ready.parts).split("\n").length === 3);

	// «Состояние» без обязательного подпункта - ровно тот случай, когда подагент прочтёт с диска
	// не ту картину: запуск обязан встать до того, как он начнёт работать
	const journalPath = volnaPaths(volnaDir).journal(task);
	const text = readFileSync(journalPath, "utf8").replace("**следующий шаг:**", "**что дальше:**");
	writeFileSync(journalPath, text, "utf8");
	const stale = partsRunReadiness(dir);
	check("на отставшем журнале прогон не запускается", !stale.ok && stale.message.includes("Журнал отстал"), stale.message);
}

/** Итог берётся из последней строки отчёта; всё, кроме «сделано», останавливает прогон. */
function reportParsing(): void {
	check("итог разбирается", parseOutcome("...отчёт...\nИТОГ: сделано") === "сделано");
	check("вопрос разбирается", parseOutcome("**блокер:** нужен выбор\nИТОГ: вопрос") === "вопрос");
	check("итог не выдумывается", parseOutcome("вроде всё получилось") === "не определён");
	check("дальше идёт только «сделано»", continues("сделано") && !continues("вопрос") && !continues("не определён"));
	check("порядок прогона лежит в скилле", partsRunInstructions().startsWith("# Running the remaining parts"));
}
