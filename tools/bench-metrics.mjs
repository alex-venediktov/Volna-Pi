/**
 * Числа одного прогона: сколько стоила часть и чем кончилась.
 *
 * Считается по двум файлам, которые драйвер и так пишет: терминальному логу и стенограмме. Своего
 * учёта в драйвер не добавляется - сравнение моделей не должно менять то, что оно измеряет.
 *
 * Запуск: node tools/bench-metrics.mjs <лог> <стенограмма> [метка]
 */
import { readFileSync } from "node:fs";

const [logPath, jsonlPath, label = ""] = process.argv.slice(2);
if (!logPath || !jsonlPath) {
	console.error("нужно: node tools/bench-metrics.mjs <лог> <стенограмма> [метка]");
	process.exit(2);
}

const log = readFileSync(logPath, "utf8");
const events = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((line) => {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}).filter(Boolean);

// Считается только работа над частью. Вывод по задаче - отдельная сессия, которую драйвер делает
// на закрытой очереди: модель, дошедшая до конца, платит за неё, а остановленная на границе - нет.
// Сложение обоих сравнивало бы разное.
const partEvents = events.filter((e) => String(e.part ?? "").startsWith("часть"));
const captureEvents = events.filter((e) => !String(e.part ?? "").startsWith("часть"));

const toolCalls = partEvents.filter((e) => e.type === "tool_execution_start").length;
// Ошибки считаются по терминальному логу: драйвер печатает их строкой «x <инструмент>», и это
// единственное место, где неудачный вызов отличим от удачного без разбора формата результата.
const toolErrors = (log.match(/^ {4}x /gm) ?? []).length;
const nudges = (log.match(/прерываю ход/g) ?? []).length;
const bash = partEvents.filter((e) => e.type === "tool_execution_start" && e.toolName === "bash").length;

// Время по меткам событий: стена, а не сумма ходов. Простой между ходами - тоже цена модели.
const stamps = partEvents.map((e) => Date.parse(e.at)).filter((n) => Number.isFinite(n));
const minutes = stamps.length > 1 ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 60000) : 0;

// Токены: у каждого хода своя запись usage, складываем входные и выходные отдельно.
let input = 0;
let output = 0;
for (const e of partEvents) {
	// Расход считается по одному типу событий: `message_end` и `turn_end` несут одну и ту же
	// запись, и сложение обоих удваивает числа - сравнение моделей сразу теряет смысл.
	if (e.type !== "turn_end") continue;
	const u = e.message?.usage;
	if (!u) continue;
	input += Number(u.input ?? 0) + Number(u.cacheRead ?? 0);
	output += Number(u.output ?? 0);
}

// Вердикт адвоката живёт в ответе инструмента, а не в терминальном логе: туда драйвер печатает
// только сам вызов.
const verdicts = [...JSON.stringify(partEvents).matchAll(/вердикт «([^»]+)»/g)].map((m) => m[1]);
const outcome = /итог части [^\n]*/.exec(log)?.[0]?.replace(/^\s*/, "") ?? "не завершилась";
const stop = /Прогон окончен: ([^\n]+)/.exec(log)?.[1] ?? "-";

const row = {
	модель: label,
	итог: outcome,
	остановка: stop,
	вызовов: toolCalls,
	"из них bash": bash,
	"ошибок инструментов": toolErrors,
	"прерываний сторожем": nudges,
	минут: minutes,
	"токенов на вход": input,
	"токенов на выход": output,
	"ток/с по стене": minutes ? Number((output / (minutes * 60)).toFixed(1)) : 0,
	"ток на вызов": toolCalls ? Math.round(output / toolCalls) : 0,
	"вердикты адвоката": verdicts.join(", ") || "-",
	"вывод по задаче": captureEvents.length ? `${captureEvents.filter((e) => e.type === "tool_execution_start").length} вызовов отдельной сессией` : "не делался",
};
console.log(JSON.stringify(row, null, 1));
