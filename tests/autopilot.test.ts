/**
 * Внешний прогон частей сессиями pi: условия запуска, задание на часть, чтение итога с диска и
 * разбор потока rpc. Сам pi не поднимается - он требует модели, а проверяется то, что обязано
 * работать при любой.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	autopilotReadiness,
	capturePrompt,
	partClosed,
	partPrompt,
	partsNow,
	unquotePath,
	profileWarnings,
	runAutopilot,
	strayChanges,
	strayFiles,
	needsHuman,
	touchedPrefixes,
} from "../extensions/volna/autopilot.ts";
import { intake } from "../extensions/volna/core.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { appendLogSection, lastSectionOf, sectionsOf, writeStateSection } from "../extensions/volna/journal.ts";
import { type Part, type PartStatus, markPart } from "../extensions/volna/parts.ts";
import { volnaPaths } from "../extensions/volna/paths.ts";
import { answerToAsk, splitJsonl, startRpcSession } from "../extensions/volna/rpc.ts";
import { readState } from "../extensions/volna/state.ts";
import { check, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	readiness();
	profile();
	prompt();
	verdict();
	stream();
	stray();
	capture();
	partsGuard();
	bounds();
	await turns();
	await loop();
}

/** Состояние задачи с готовым списком частей: прогон читает его с диска, как читает сессия. */
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
		{ goal: "поднять каркас проекта", done: "часть 1 закрыта", next: "гнать остаток частей", parts },
		{ logText },
	);
}

/** Постановка частей в логе: без неё сессии нечего дать вместо «готово, когда». */
function writeBriefs(volnaDir: string, task: string, briefs: string[]): void {
	appendLogSection(volnaDir, task, { stage: "spec", fields: { что: "постановка частей", части: briefs.join("\n") } });
	const paths = volnaPaths(volnaDir);
	writeStateSection(
		paths.journal(task),
		{ goal: "поднять каркас проекта", done: "часть 1 закрыта", next: "гнать остаток частей" },
		{ logText: readFileSync(paths.log(task), "utf8") },
	);
}

/** Условия запуска: активная задача, разбиение на части, постановка у каждой, свежий журнал. */
function readiness(): void {
	const dir = sandbox("autopilot-readiness");
	check("без .volna прогонять нечего", !autopilotReadiness(dir).ok);

	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	check("без активной задачи прогон не запускается", !autopilotReadiness(dir).ok);

	intake(dir, { assignment: "Фаза 0: каркас проекта" });
	const task = readState(volnaDir).active ?? "";
	const undivided = autopilotReadiness(dir);
	check("неразбитая задача прогона не требует", !undivided.ok && undivided.message.includes("на части не разбита"), undivided.message);

	writeParts(volnaDir, task, "1. проект и каталоги - сделано (2026-09-19, 3ч)\n2. автозагрузки - не начата");
	const bare = autopilotReadiness(dir);
	check("часть без постановки прогон не берёт", !bare.ok && bare.message.includes("готово, когда:"), bare.message.split("\n")[0]);

	writeBriefs(volnaDir, task, [
		"1. проект и каталоги",
		"   готово, когда: godot --headless --path game --quit даёт код 0",
		"2. автозагрузки",
		"   готово, когда: тест баланса зелёный, консоль чиста",
		"   трогает: game/core, game/data",
		"   не трогает: game/ui",
	]);
	const ready = autopilotReadiness(dir);
	check("с постановкой на каждой части прогон готов", ready.ok, ready.message);
	// Единственная оставшаяся часть здесь законна, в отличие от прогона подагентами: работу делает
	// тот же флоу, только своей сессией, и заводить ради неё нечего
	check("одна оставшаяся часть прогону не помеха", ready.ok && ready.left === 1, String(ready.left));
	check("задача и каталог названы для прогона", ready.task === task && ready.volnaDir === volnaDir);

	appendLogSection(volnaDir, task, { stage: "implement", fields: { что: "правки по плану" } });
	const stale = autopilotReadiness(dir);
	check("на отставшем журнале прогон не запускается", !stale.ok && stale.message.includes("Журнал отстал"), stale.message.split("\n")[0]);
}

/** Профиль: незаполненные строки и push прогон не останавливают, но названы до запуска. */
function profile(): void {
	const dir = sandbox("autopilot-profile");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	const shipped = profileWarnings(volnaDir);
	check("незаполненный профиль назван предупреждением", shipped.some((line) => line.includes("не спрошено")), shipped.join(" | "));

	const projectPath = volnaPaths(volnaDir).project;
	const filled = readFileSync(projectPath, "utf8")
		.replace(/- тесты: .*/, "- тесты: npm test")
		.replace(/- сборка: .*/, "- сборка: нет")
		.replace(/- запуск: .*/, "- запуск: нет")
		.replace(/- доставка: .*/, "- доставка: commit+push")
		.replace(/- ветка: .*/, "- ветка: feature/<задача>");
	writeFileSync(projectPath, filled, "utf8");
	const warnings = profileWarnings(volnaDir);
	check("заполненные строки больше не в предупреждениях", !warnings.some((line) => line.includes("не спрошено")), warnings.join(" | "));
	check("про push сказано до запуска", warnings.some((line) => line.includes("push")), warnings.join(" | "));
}

/** Задание на часть: критерий, границы, адреса журнала и правила автоматического прогона. */
function prompt(): void {
	const text = partPrompt({
		volnaDir: join("D:", "Проекты", "игра", ".volna"),
		task: "260919-karkas",
		part: { number: 2, title: "автозагрузки", status: "не начата", note: "" },
		criterion: "тест баланса зелёный",
		brief: { number: 2, title: "автозагрузки", criterion: "тест баланса зелёный", touches: "game/core", avoids: "game/ui", depends: "часть 1" },
	});
	check("часть названа номером и заголовком", text.includes("часть 2: автозагрузки"), text.split("\n")[0]);
	check("критерий остановки в задании", text.includes("Готово, когда: тест баланса зелёный"));
	check("границы части в задании", text.includes("Трогает: game/core") && text.includes("Не трогает: game/ui"));
	check("адрес журнала в задании", text.includes("journal/TASK-260919-karkas.md"), text);
	check("push прогону запрещён прямо в задании", text.includes("Push не делай"));
	check("сказано останавливаться на ручной проверке", text.includes("только человек"));
}

/** Итог части читается из журнала на диске, а не из слов сессии. */
function verdict(): void {
	const dir = sandbox("autopilot-verdict");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	intake(dir, { assignment: "Фаза 0: каркас проекта" });
	const task = readState(volnaDir).active ?? "";

	writeParts(volnaDir, task, "1. проект - сделано (2026-09-19, 3ч)\n2. автозагрузки - в работе\n3. оверлей - снята (не нужен)");
	check("статуса «сделано» мало: закрытия в логе нет", !partClosed(volnaDir, task, 1));
	check("часть в работе не закрыта", !partClosed(volnaDir, task, 2));
	check("снятая часть закрыта: «снята» ставит только полное закрытие задачи", partClosed(volnaDir, task, 3));
	check("части вне списка закрытыми не считаются", !partClosed(volnaDir, task, 9));

	// Нелатинские имена git отдаёт в кавычках и октальных последовательностях. Кавычка перед именем
	// ломает узнавание префикса `.volna/`, и служебная правка флоу начинает выглядеть работой за
	// границей части - прогон останавливается на ровном месте.
	check("кавычки вокруг имени снимаются", unquotePath('".volna/wiki/process/INDEX--сопровождение.md"') === ".volna/wiki/process/INDEX--сопровождение.md");
	check("обычное имя не трогается", unquotePath("game/sim/combat/weapon_slot.gd") === "game/sim/combat/weapon_slot.gd");
	check("одинокая кавычка именем не считается", unquotePath('"') === '"');

	// След, которого рукой не поставишь: секцию close пишет только `finishTask`.
	appendLogSection(volnaDir, task, {
		stage: "close",
		fields: { что: "часть 1/3 закрыта: проект", сделано: "каркас на месте" },
	});
	check("со следом закрытия в логе часть закрыта", partClosed(volnaDir, task, 1));
	check("чужой след закрытия за свой не считается", !partClosed(volnaDir, task, 2));
}

/** Поток rpc: разбор записей и ответ на диалог расширения. */
function stream(): void {
	const crlf = splitJsonl('{"type":"agent_start"}\r\n{"type":"agent_settled"}\r\n');
	check("записи с возвратом каретки разбираются", crlf.lines.length === 2 && crlf.lines[1] === '{"type":"agent_settled"}', crlf.lines.join(" | "));
	check("хвост без перевода строки остаётся в остатке", splitJsonl('{"a":1}\n{"b":').rest === '{"b":');
	// U+2028 законен внутри строки JSON, и запись по нему делить нельзя: готовые построчные
	// читалки Node делают ровно это
	const separator = splitJsonl('{"text":"строка продолжение"}\n');
	check("разделитель строк Unicode запись не рвёт", separator.lines.length === 1, String(separator.lines.length));

	const confirm = answerToAsk({ type: "extension_ui_request", id: "1", method: "confirm", title: "отправить ветку?" });
	check("согласия прогон не даёт", confirm?.confirmed === false, JSON.stringify(confirm));
	const select = answerToAsk({ type: "extension_ui_request", id: "2", method: "select", title: "чем чинить?" });
	check("выбор прогон отклоняет", select?.cancelled === true, JSON.stringify(select));
	check("уведомление ответа не требует", answerToAsk({ type: "extension_ui_request", id: "3", method: "notify" }) === null);
	check("запрос без опознавателя ответа не получает", answerToAsk({ type: "extension_ui_request", method: "confirm" }) === null);
}

/** Ход сессии: обычный ответ, вопрос человеку, молчание с напоминанием и без, несостоявшийся ход. */
async function turns(): Promise<void> {
	const dir = sandbox("autopilot-turns");
	const stub = fileURLToPath(new URL("rpc-stub.mjs", import.meta.url));
	const exec = { command: process.execPath, args: [stub] };

	const plain = startRpcSession({ cwd: dir, exec, idleMs: 300, startMs: 300, maxNudges: 2 });
	const answer = await plain.prompt("часть 2: автозагрузки");
	await plain.close();
	check("обычный ход доходит до ответа", answer.texts.at(-1)?.startsWith("готово:") === true, answer.texts.join(" | "));
	check("вызовы инструментов сочтены", answer.toolCalls === 1, String(answer.toolCalls));
	check("цена хода собрана", answer.usage.cost.total === 0.5, String(answer.usage.cost.total));
	check("обычный ход не считается прерванным", !answer.aborted && !answer.stalled && !answer.exited);

	const asking = startRpcSession({ cwd: dir, exec, idleMs: 300, startMs: 300, maxNudges: 2 });
	const asked = await asking.prompt("СПРОСИ про ветку");
	await asking.close();
	check("вопрос человеку попадает в итог хода", asked.asks.length === 1 && asked.asks[0].method === "confirm", JSON.stringify(asked.asks));
	check("после отказа ход завершается сам", asked.texts.at(-1)?.includes("confirmed") === true, asked.texts.join(" | "));

	const silent = startRpcSession({ cwd: dir, exec, idleMs: 300, startMs: 300, maxNudges: 2 });
	const nudged = await silent.prompt("МОЛЧИ на первом ходу");
	await silent.close();
	check("молчание прерывается и просится продолжение", nudged.nudges === 1, String(nudged.nudges));
	check("продолжившийся ход прерванным не считается", !nudged.aborted, JSON.stringify(nudged));

	// Круг: сессия не молчит и вызовы идут, но работа стоит. Сторож простоя такого не ловит -
	// событий полно; потолок вызовов сработает много позже. Ловит счёт повторов одной подписи.
	const looping = startRpcSession({
		cwd: dir,
		exec,
		idleMs: 60000,
		startMs: 60000,
		maxNudges: 0,
		watch: ({ repeats, lastCall }) => (repeats >= 5 ? `один и тот же вызов ${repeats} раз подряд: ${lastCall.slice(0, 40)}` : null),
	});
	const looped = await looping.prompt("ПОКРУГУ");
	await looping.close();
	check("круг одинаковых вызовов прерывается", looped.stoppedBy.includes("раз подряд"), looped.stoppedBy);
	check("в причине названа сама команда", looped.stoppedBy.includes("grep"), looped.stoppedBy);
	// Без этого сторожа круг не ловится ничем: событий полно, молчания нет, ход не кончается сам.
	const unguarded = startRpcSession({ cwd: dir, exec, idleMs: 60000, startMs: 60000, maxNudges: 0 });
	const spun = await unguarded.prompt("ПОКРУГУ");
	await unguarded.close();
	check("без сторожа круг ничем не прерывается", spun.stoppedBy === "", spun.stoppedBy || "(пусто)");

	const lost = startRpcSession({ cwd: dir, exec, idleMs: 300, startMs: 300, maxNudges: 0 });
	const gone = await lost.prompt("МОЛЧИ без напоминаний");
	await lost.close();
	check("без напоминаний молчащий ход признаётся прерванным", gone.aborted, JSON.stringify(gone));

	const mute = startRpcSession({ cwd: dir, exec, idleMs: 60000, startMs: 300, maxNudges: 2 });
	const never = await mute.prompt("НЕМОЙ");
	await mute.close();
	check("не начавшийся ход виден по своему порогу", never.stalled, JSON.stringify(never));
}

/** Смена статуса не у своей части: то, чем закрытие ставится не туда. */
function stray(): void {
	const before: Part[] = [
		{ number: 1, title: "проект", status: "сделано", note: "" },
		{ number: 2, title: "автозагрузки", status: "в работе", note: "" },
		{ number: 3, title: "оверлей", status: "не начата", note: "" },
	];
	const same = strayChanges(before, before, 2);
	check("без правок чужих частей не находится", same.length === 0, String(same.length));

	const closedOwn = strayChanges(before, markPart(before, 2, "сделано"), 2);
	check("закрытие своей части чужой правкой не считается", closedOwn.length === 0, JSON.stringify(closedOwn));

	const closedOther = strayChanges(before, markPart(before, 3, "сделано"), 2);
	check("закрытие соседней части находится", closedOther.length === 1 && closedOther[0].number === 3, JSON.stringify(closedOther));
	check("видно, из какого статуса в какой", closedOther[0]?.from === "не начата" && closedOther[0]?.to === "сделано", JSON.stringify(closedOther[0]));
}

/** Прогон целиком: часть видна начатой, а закрытие соседней части прогон останавливает. */
async function loop(): Promise<void> {
	const dir = sandbox("autopilot-loop");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	intake(dir, { assignment: "Фаза 0: каркас проекта" });
	const task = readState(volnaDir).active ?? "";
	writeParts(volnaDir, task, "1. проект - сделано (2026-09-19, 3ч)\n2. автозагрузки ЧУЖАЯ - не начата\n3. оверлей - не начата");
	// Постановки нумеруются по порядку в блоке, а не по цифре в строке: блок обязан начинаться
	// с первой части, иначе номера разъедутся со списком «Состояния»
	writeBriefs(volnaDir, task, [
		"1. проект",
		"   готово, когда: проект открывается",
		"2. автозагрузки ЧУЖАЯ",
		"   готово, когда: тест баланса зелёный",
		"3. оверлей",
		"   готово, когда: F1 показывает цифры",
	]);

	const readiness = autopilotReadiness(dir);
	check("прогон готов к запуску", readiness.ok, readiness.message);

	let takenWhileRunning: PartStatus | undefined;
	const seen: string[] = [];
	const report = await runAutopilot({
		cwd: dir,
		readiness,
		idleMs: 2000,
		startMs: 2000,
		maxNudges: 0,
		maxContinues: 0,
		exec: { command: process.execPath, args: [fileURLToPath(new URL("rpc-stub.mjs", import.meta.url))] },
		onEvent: (_part, event) => seen.push(String(event.type ?? "")),
		onPart: (part) => {
			// Статус читается после отметки о взятии и до работы сессии: именно в это окно часть
			// раньше и стояла «не начата»
			takenWhileRunning = partsNow(volnaDir, task).find((item) => item.number === part.number)?.status;
		},
	});

	const prompts = readFileSync(join(dir, "stub-prompts.log"), "utf8").split(/\r?\n/).filter(Boolean);
	// В часть входит сама «Волна»: без этого сессия открывается на этапе, которым кончилась
	// предыдущая часть, и флоу не начинается
	// Отправленное драйвером идёт тем же потоком: иначе в стенограмме видна половина разговора
	check("поданное драйвером видно в потоке событий", seen.includes("driver:prompt"), seen.slice(0, 6).join(", "));
	check("ответы сессии в потоке тоже есть", seen.includes("message_end"), seen.slice(0, 6).join(", "));
	check("первым подаётся вход в названную часть", prompts[0] === "/volna:task 2", prompts[0]);
	check("задание на часть идёт следом", prompts[1]?.includes("часть 2:") === true, prompts[1]);
	check("часть видно начатой, пока над ней работают", takenWhileRunning === "в работе", String(takenWhileRunning));
	check("закрытие чужой части останавливает прогон", report.stop === "тронута чужая часть", report.stop);
	check("в причине названа тронутая часть", report.detail.includes("часть 3"), report.detail);
	check("чужая правка попала в отчёт части", report.runs[0]?.stray.length === 1, JSON.stringify(report.runs[0]?.stray));
	// Находки независимы: прерванный ход не должен затыкать закрытие без приёмки
	check("закрытие без человека старше прерывания", report.runs[0]?.closedWithoutHuman === false, String(report.runs[0]?.closedWithoutHuman));
	check("на следующую часть прогон не пошёл", report.runs.length === 1, String(report.runs.length));
}

/** Материал вывода по задаче: «Состояние» и итоги частей, но не лог целиком. */
function capture(): void {
	const dir = sandbox("autopilot-capture");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	intake(dir, { assignment: "Фаза 0: каркас проекта" });
	const task = readState(volnaDir).active ?? "";

	appendLogSection(volnaDir, task, { stage: "implement", fields: { что: "черновой подход, потом отвергнут" } });
	appendLogSection(volnaDir, task, { stage: "close", fields: { что: "часть 1 закрыта", сделано: "проект собран" } });
	appendLogSection(volnaDir, task, { stage: "implement", fields: { что: "ещё одна отвергнутая попытка" } });
	appendLogSection(volnaDir, task, { stage: "close", fields: { что: "часть 2 закрыта", сделано: "автозагрузки на месте" } });
	writeParts(volnaDir, task, "1. проект - сделано (2026-09-19, 3ч)\n2. автозагрузки - сделано (2026-09-19, 4ч)");

	const logText = readFileSync(volnaPaths(volnaDir).log(task), "utf8");
	check("секции этапа берутся все и по порядку", sectionsOf(logText, "close").length === 2, String(sectionsOf(logText, "close").length));
	check("последняя секция этапа - последняя по порядку", lastSectionOf(logText, "close").includes("часть 2 закрыта"));

	const text = capturePrompt(volnaDir, task);
	check("в задание вошло «Состояние»", text.includes("«Состояние» задачи:"), text.slice(0, 80));
	check("итоги обеих закрытых частей на месте", text.includes("часть 1 закрыта") && text.includes("часть 2 закрыта"));
	// Лог хранит и отвергнутые подходы: в материал сквозного вывода они не идут, иначе брошенная
	// гипотеза читается как факт
	check("отвергнутые итерации в задание не попали", !text.includes("отвергнутая попытка"), text.slice(-200));
	check("вика названа местом прежних записей", text.includes("wiki"), text.slice(-400));
	check("лог целиком читать не предлагается", text.includes("целиком не читай"), text.slice(-300));
	check("закрывать задачу прогон не поручает", text.includes("задачу не закрывай"));
}

/** Список частей в непрочитываемой форме отвергается, а не затирает живой. */
function partsGuard(): void {
	const dir = sandbox("autopilot-parts-guard");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	intake(dir, { assignment: "Фаза 0: каркас проекта" });
	const task = readState(volnaDir).active ?? "";
	writeParts(volnaDir, task, "1. проект - сделано (2026-09-19, 3ч)\n2. автозагрузки - в работе");

	// Так список приходит от модели, когда она отдаёт его массивом: подпункт на месте, а частей в
	// нём никто не находит - остаток задачи исчезает молча
	const asJson = JSON.stringify(["1. проект - сделано", "2. автозагрузки - в работе"]);
	let refused = "";
	try {
		writeStateSection(volnaPaths(volnaDir).journal(task), { goal: "цель", done: "сделано", next: "дальше", parts: asJson });
	} catch (error) {
		refused = String((error as Error).message);
	}
	check("список одной строкой отвергается", refused.includes("не читается"), refused || "записан без возражений");
	check("прежний список цел", partsNow(volnaDir, task).length === 2, String(partsNow(volnaDir, task).length));
	check("статусы частей не тронуты", partsNow(volnaDir, task)[1]?.status === "в работе", partsNow(volnaDir, task)[1]?.status);

	writeStateSection(volnaPaths(volnaDir).journal(task), { goal: "цель", done: "сделано", next: "дальше" });
	check("список переносится сам, когда его не передали", partsNow(volnaDir, task).length === 2, String(partsNow(volnaDir, task).length));
}

/** Границы части по файлам и признак критерия, который закрывает человек. */
function bounds(): void {
	const touches = "game/core/input/gesture_input.gd, game/core/input/gesture_input.tscn, game/core/event_bus.gd";
	check("из прозы берутся только пути", touchedPrefixes(touches).length === 3, touchedPrefixes(touches).join(" | "));
	check("слова без пути границей не служат", touchedPrefixes("ввод и шина событий").length === 0);

	const changed = ["game/core/input/gesture_input.gd", "game/sim/actor/actor.gd", ".volna/journal/TASK-x.md"];
	const stray = strayFiles(changed, touches);
	check("чужой файл опознан за границей", stray.length === 1 && stray[0] === "game/sim/actor/actor.gd", stray.join(" | "));
	// Журнал и вику правит сам флоу на каждом этапе: к границе части они не относятся
	check("журнал за границу не считается", !stray.some((file) => file.startsWith(".volna/")), stray.join(" | "));
	check("без поля «трогает» проверять нечем", strayFiles(changed, "").length === 0);
	// Спутник движка и тест к своему файлу пишет та же часть: в поле «трогает» карточки их нет,
	// но чужой работой они от этого не становятся
	check("спутник движка чужим не считается", strayFiles(["game/core/input/gesture_input.gd.uid"], touches).length === 0);
	check("тест к своему файлу чужим не считается", strayFiles(["game/tests/unit/test_gesture_input.gd"], touches).length === 0);

	check("критерий с телефоном ждёт человека", needsHuman("проверяется руками на телефоне"));
	check("критерий с замером ждёт человека", needsHuman("замер записать в docs/perf-log.md"));
	check("машинный критерий человека не ждёт", !needsHuman("тест баланса зелёный, консоль чиста"));
}
