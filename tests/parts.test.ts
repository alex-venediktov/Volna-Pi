/** Задача из нескольких частей: список в «Состоянии», закрытие части, продолжение после /clear. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareWithSnapshot } from "../extensions/volna/changes.ts";
import { contextHeader, enterStage, finishTask, intake, resumeTask, statusReport } from "../extensions/volna/core.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { appendLogSection, writeStateSection } from "../extensions/volna/journal.ts";
import { currentPart, parsePartsText, partsFromState, renderPartsText, unfinishedParts } from "../extensions/volna/parts.ts";
import { loadActive, readState } from "../extensions/volna/state.ts";
import { check, sandbox } from "./harness.ts";

const LIST = [
	"1. схема хранения - сделано (2026-08-16, 3ч)",
	"2. приём шага по форме - в работе",
	"3. продолжение цепочки - не начата",
].join("\n");

export async function run(): Promise<void> {
	const parsed = parsePartsText(LIST);
	check("список частей разобран", parsed.length === 3, String(parsed.length));
	check("состояние сделанной части прочитано", parsed[0].status === "сделано" && parsed[0].note === "2026-08-16, 3ч");
	check("название части не съедено статусом", parsed[1].title === "приём шага по форме", parsed[1].title);
	check("текущая часть - та, что в работе", currentPart(parsed)?.number === 2);
	check("остаток считается", unfinishedParts(parsed).length === 2);
	check("список собирается обратно", renderPartsText(parsed) === LIST, renderPartsText(parsed));
	check("часть без статуса считается не начатой", parsePartsText("1. вторая половина")[0].status === "не начата");

	const dir = sandbox("parts");
	initVolna(dir);
	intake(dir, { assignment: "Перевести хранение шагов на новую схему и починить приём формы" });
	const volnaDir = join(dir, ".volna");
	const task = readState(volnaDir).active!;
	const journalPath = loadActive(dir)!.journalPath;

	writeStateSection(journalPath, {
		goal: "шаги хранятся по новой схеме",
		parts: LIST.replace("2. приём шага по форме - в работе", "2. приём шага по форме - не начата").replace(
			"1. схема хранения - сделано (2026-08-16, 3ч)",
			"1. схема хранения - в работе",
		),
		done: "части намечены",
		next: "план первой части",
	});
	let active = loadActive(dir)!;
	check("части попали в «Состояние»", (active.stateSection ?? "").includes("**части:**"), active.stateSection ?? "");
	check("номер части во frontmatter", String(active.fm.part) === "1" && String(active.fm.parts) === "3", `${active.fm.part}/${active.fm.parts}`);
	check("шапка называет часть", contextHeader(active).join(" ").includes("часть 1/3"), contextHeader(active).join(" "));
	check("сводка перечисляет части", statusReport(dir).includes("Части: часть 1/3"), statusReport(dir).split("\n").join(" | "));

	writeStateSection(journalPath, { goal: "шаги хранятся по новой схеме", done: "схема готова", next: "приём формы" });
	active = loadActive(dir)!;
	check(
		"список частей переносится при перезаписи без него",
		partsFromState(active.stateSection).length === 3,
		active.stateSection ?? "",
	);

	enterStage(dir, "implement", { reason: "часть 1" });
	appendLogSection(volnaDir, task, { stage: "implement", fields: { что: "схема", сделано: "готово", осталось: "-" } });

	const early = finishTask(dir, { summary: "всё сделал", hours: "3" });
	check("закрытие задачи с остатком требует назвать остаток", !early.ok, early.message.slice(0, 60));
	check("активная задача при отказе на месте", readState(volnaDir).active === task);

	const closedPart = finishTask(dir, { summary: "схема хранения переведена", hours: "3", part: true });
	check("часть закрыта", closedPart.ok && !closedPart.closed, closedPart.message.slice(0, 70));
	check("задача осталась активной", readState(volnaDir).active === task);
	active = loadActive(dir)!;
	const afterFirst = partsFromState(active.stateSection);
	check("часть помечена сделанной с часами", afterFirst[0].status === "сделано" && afterFirst[0].note.includes("3ч"), afterFirst[0].note);
	check("следующая часть названа в «Состоянии»", (active.stateSection ?? "").includes("часть 2/3"), active.stateSection ?? "");
	check("итог части ушёл в лог", active.logText.includes("часть 1/3 закрыта"));

	const resumed = resumeTask(dir);
	check("продолжение вошло в spec следующей части", resumed.ok && resumed.stage === "spec", resumed.message.slice(0, 70));
	check("в инструкции названа часть", resumed.message.includes("часть 2/3"), resumed.message.slice(0, 120));
	check("часть переведена в работу", currentPart(partsFromState(loadActive(dir)!.stateSection))?.status === "в работе");

	const dropped = finishTask(dir, { summary: "первая часть в проде, остальное не делаем", left: "части 2 и 3 сняты: приоритет ушёл" });
	check("задача закрыта с названным остатком", dropped.ok && dropped.closed, dropped.message.slice(0, 60));
	check("активная задача снята", readState(volnaDir).active === null);
	const finalParts = partsFromState(readFileSync(journalPath, "utf8"));
	check(
		"незакрытые части помечены снятыми",
		finalParts.filter((part) => part.status === "снята").length === 2,
		renderPartsText(finalParts),
	);

	await snapshotMovesWithPart();
}

/** Проект без системы контроля версий: закрытие части сдвигает базу адвоката, как это делает коммит. */
async function snapshotMovesWithPart(): Promise<void> {
	const dir = sandbox("parts-snapshot", { git: false });
	initVolna(dir);
	writeFileSync(join(dir, "app.js"), "export const step = 1;\n", "utf8");
	intake(dir, { assignment: "Разбить работу над шагами на части" });
	const volnaDir = join(dir, ".volna");
	const task = readState(volnaDir).active!;
	const journalPath = loadActive(dir)!.journalPath;
	writeStateSection(journalPath, {
		goal: "шаги",
		parts: "1. первая половина - в работе\n2. вторая половина - не начата",
		done: "части намечены",
		next: "первая часть",
	});

	enterStage(dir, "implement", { reason: "часть 1" });
	writeFileSync(join(dir, "app.js"), "export const step = 2;\n", "utf8");
	check("правки части видны адвокату", compareWithSnapshot(volnaDir, task, {}).files.length === 1);

	const closed = finishTask(dir, { summary: "первая половина готова", hours: "2", part: true });
	check("про пере-снятый снимок сказано", closed.warnings.some((warning) => warning.includes("снимок дерева пере-снят")), closed.warnings.join("; "));
	check("после закрытия части база сдвинулась", compareWithSnapshot(volnaDir, task, {}).files.length === 0);

	writeFileSync(join(dir, "app.js"), "export const step = 3;\n", "utf8");
	check("правки следующей части видны отдельно", compareWithSnapshot(volnaDir, task, {}).files.length === 1);
}
