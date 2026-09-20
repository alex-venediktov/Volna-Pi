/** Задача из нескольких частей: список в «Состоянии», закрытие части, продолжение после /new. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectChanges } from "../extensions/volna/changes.ts";
import { contextHeader, enterStage, finishTask, intake, resumeTask, statusReport } from "../extensions/volna/core.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { appendLogSection, writeStateSection } from "../extensions/volna/journal.ts";
import {
	currentPart,
	partArgument,
	markPart,
	partBrief,
	partBriefForm,
	parsePartBriefs,
	parsePartsText,
	partsFromState,
	renderPartsText,
	takePart,
	unfinishedParts,
} from "../extensions/volna/parts.ts";
import { loadActive, readState, taskField } from "../extensions/volna/state.ts";
import { check, exec, sandbox } from "./harness.ts";

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

	// Разбор аргумента команды: ошибка здесь не видна глазом - вместо продолжения части заводится
	// новая задача с названием из аргумента, и находится это только живым прогоном.
	check("голое число - номер части", partArgument("9") === 9);
	check("номер с пробелами вокруг читается", partArgument("  2  ") === 2);
	check("текст задания номером не считается", partArgument("Переписать хранение шагов") === undefined);
	check("пустой аргумент номером не считается", partArgument("") === undefined);
	check("буква d номером не считается", partArgument("d") === undefined, String(partArgument("d")));
	check("путь к файлу номером не считается", partArgument("docs/tasks/9.md") === undefined);
	check("задание, начатое цифрой, остаётся заданием", partArgument("9 частей переписать") === undefined);
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

	await enterStage(dir, "implement", { reason: "часть 1" });
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

	const resumed = await resumeTask(dir);
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

	await baseMovesWithPart();
	await namedPartWins();
	partStatementsLiveInTheLog();
}

/**
 * Постановка части читается из лога: подпункт «части» секции spec. По ней прогон берёт критерий
 * «готово, когда», и повторный заход на spec перекрывает написанное раньше.
 */
function partStatementsLiveInTheLog(): void {
	const dir = sandbox("parts-brief");
	initVolna(dir);
	intake(dir, { assignment: "Разбить работу на части с критериями" });
	const volnaDir = join(dir, ".volna");
	const task = readState(volnaDir).active!;

	appendLogSection(volnaDir, task, {
		stage: "spec",
		fields: {
			что: "постановка задачи",
			части: [
				"1. схема хранения",
				"   готово, когда: npm test зелёный на tests/store.test.ts",
				"   трогает: src/store/**",
				"   не трогает: UI, миграции",
				"   зависит от: нет",
				"2. приём шага по форме",
				"   готово, когда: форма сохраняет шаг, в списке появляется запись",
				"   зависит от: часть 1",
			].join("\n"),
			сделано: "части намечены",
		},
	});
	let log = readFileSync(loadActive(dir)!.logPath, "utf8");
	const briefs = parsePartBriefs(log);
	check("постановки частей разобраны", briefs.length === 2, String(briefs.length));
	check("критерий части прочитан", briefs[0].criterion.includes("tests/store.test.ts"), briefs[0].criterion);
	check("границы части прочитаны", briefs[0].touches === "src/store/**" && briefs[0].avoids === "UI, миграции", briefs[0].avoids);
	check("зависимость части прочитана", briefs[1].depends === "часть 1", briefs[1].depends);
	check("названия частей не съедены полями", briefs[1].title === "приём шага по форме", briefs[1].title);
	check("постановка одной части находится по номеру", partBrief(log, 2)?.criterion.includes("форма сохраняет шаг") === true);
	check("часть без постановки критерия не получает", partBrief(log, 3) === undefined);

	appendLogSection(volnaDir, task, {
		stage: "spec",
		fields: {
			что: "постановка переписана",
			части: ["1. схема хранения", "   готово, когда: миграция прогоняется на копии базы"].join("\n"),
			сделано: "критерий первой части уточнён",
		},
	});
	log = readFileSync(loadActive(dir)!.logPath, "utf8");
	check(
		"повторный заход на spec перекрывает постановку",
		partBrief(log, 1)?.criterion === "миграция прогоняется на копии базы",
		partBrief(log, 1)?.criterion ?? "(пусто)",
	);
	check("форма постановки одна на промпт и на отказ", partBriefForm().includes("готово, когда:"), partBriefForm().slice(0, 40));

	// Часть, отданную подагенту, видно в карте частей начатой: иначе остановка на вопросе выглядит
	// так, будто за неё никто не брался
	const journalPath = loadActive(dir)!.journalPath;
	writeStateSection(journalPath, {
		goal: "части",
		parts: "1. схема хранения - не начата\n2. приём шага по форме - не начата",
		done: "части намечены",
		next: "первая часть",
	});
	const before = partsFromState(loadActive(dir)!.stateSection);
	check("часть берётся в работу", takePart(journalPath, before, 1));
	check(
		"взятая часть видна начатой",
		partsFromState(loadActive(dir)!.stateSection)[0].status === "в работе",
		partsFromState(loadActive(dir)!.stateSection)[0].status,
	);
	check("повторное взятие ничего не переписывает", !takePart(journalPath, partsFromState(loadActive(dir)!.stateSection), 1));
	const closed = markPart(partsFromState(loadActive(dir)!.stateSection), 2, "сделано", "2026-09-14, 1ч");
	check("закрытую часть в работу не вернуть", !takePart(journalPath, closed, 2));
}

/**
 * Часть, названную номером, продолжение берёт вместо очередной. Прогон гонит части не подряд, и
 * «очередная» у «Волны» своя: первая начатая. Отложенная до человека часть остаётся начатой, и без
 * номера сессия вошла бы в неё, получив задание на другую.
 */
async function namedPartWins(): Promise<void> {
	const dir = sandbox("parts-named");
	initVolna(dir);
	intake(dir, { assignment: "Три части, средняя отложена до человека" });
	const journalPath = loadActive(dir)!.journalPath;
	writeStateSection(journalPath, {
		goal: "части не подряд",
		parts: "1. схема - сделано (2026-09-01, 1ч)\n2. замер на устройстве - в работе\n3. патрули - не начата",
		done: "первая часть закрыта",
		next: "часть 2 ждёт человека",
	});

	const byDefault = await resumeTask(dir);
	check("без номера продолжение берёт первую начатую", byDefault.message.includes("часть 2/3"), byDefault.message.slice(0, 120));

	const named = await resumeTask(dir, undefined, 3);
	check("названная часть перебивает очередную", named.ok && named.message.includes("часть 3/3"), named.message.slice(0, 120));
	check(
		"названная часть переведена в работу",
		partsFromState(loadActive(dir)!.stateSection)[2].status === "в работе",
		partsFromState(loadActive(dir)!.stateSection)[2].status,
	);

	const closed = await resumeTask(dir, undefined, 1);
	check("закрытую часть продолжением не поднять", !closed.ok, closed.message.slice(0, 80));
	const missing = await resumeTask(dir, undefined, 9);
	check("несуществующая часть названа ошибкой, а не молчанием", !missing.ok && missing.message.includes("9"), missing.message.slice(0, 80));
}

/** Закрытие части сдвигает базу адвоката: следующая часть ставит свою точку начала на implement. */
async function baseMovesWithPart(): Promise<void> {
	const dir = sandbox("parts-base", { git: false });
	await exec("git", ["init", "-q", dir]);
	await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
	await exec("git", ["-C", dir, "config", "user.name", "test"]);
	writeFileSync(join(dir, "app.js"), "export const step = 1;\n", "utf8");
	initVolna(dir);
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-q", "-m", "base"]);
	intake(dir, { assignment: "Разбить работу над шагами на части" });
	const volnaDir = join(dir, ".volna");
	const journalPath = loadActive(dir)!.journalPath;
	writeStateSection(journalPath, {
		goal: "шаги",
		parts: "1. первая половина - в работе\n2. вторая половина - не начата",
		done: "части намечены",
		next: "первая часть",
	});

	await enterStage(dir, "implement", { reason: "часть 1", exec });
	const firstBase = taskField(loadActive(dir)!.fm, "part_base");
	check("точка начала части записана в журнал", /^[0-9a-f]{40}$/.test(firstBase), firstBase || "(пусто)");
	writeFileSync(join(dir, "app.js"), "export const step = 2;\n", "utf8");
	const during = await collectChanges(exec, { volnaDir, base: firstBase });
	check("правки части видны адвокату", during.files.length === 1, JSON.stringify(during.files));

	// доставка части: коммит внутри части не должен уводить проверенное из-под адвоката
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-q", "-m", "часть 1"]);
	const afterCommit = await collectChanges(exec, { volnaDir, base: firstBase });
	check("коммит внутри части не прячет правки от адвоката", afterCommit.files.length === 1, JSON.stringify(afterCommit.files));
	check("против HEAD те же правки уже не видны", (await collectChanges(exec, { volnaDir })).files.length === 0);

	const closed = finishTask(dir, { summary: "первая половина готова", hours: "2", part: true });
	check("часть закрыта", !closed.closed && closed.ok, closed.message.slice(0, 60));
	check("точка начала части сброшена", taskField(loadActive(dir)!.fm, "part_base") === "");

	await enterStage(dir, "implement", { reason: "часть 2", exec });
	const secondBase = taskField(loadActive(dir)!.fm, "part_base");
	check("следующая часть поставила свою точку", /^[0-9a-f]{40}$/.test(secondBase) && secondBase !== firstBase, secondBase.slice(0, 8));
	writeFileSync(join(dir, "next.js"), "export const step = 3;\n", "utf8");
	const second = await collectChanges(exec, { volnaDir, base: secondBase });
	check("адвокат следующей части видит только её правки", second.files.length === 1 && second.files[0].path === "next.js", JSON.stringify(second.files));

	finishTask(dir, { summary: "вторая половина готова", hours: "1", part: true });
	const done = finishTask(dir, { summary: "шаги переведены целиком", hours: "3" });
	check("задача закрыта целиком", done.ok && done.closed, done.message.slice(0, 60));
	check("журнал пережил закрытие", done.message.includes("Журнал остался"), done.message.slice(-120));
}
