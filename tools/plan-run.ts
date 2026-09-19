#!/usr/bin/env node
/**
 * Внешний драйвер прогона: гонит незакрытые части активной задачи по флоу «Волны», каждую своей
 * сессией pi, и останавливается на первой развилке.
 *
 * Запускается обычным node, а не изнутри pi: драйвер поднимает сессии подпроцессами, и вложенный
 * запуск дал бы сессию внутри сессии с общим журналом и гонкой записи.
 *
 *   node --experimental-strip-types tools/plan-run.ts --dir <корень проекта>
 *
 * Коды возврата те же, что у остальных операций пакета: 0 - все части прогона закрыты, 1 - прогон
 * остановлен на развилке и ход за человеком, 3 - запускать нечего или сбой.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AutopilotOptions, autopilotReadiness, runAutopilot, runTaskCapture } from "../extensions/volna/autopilot.ts";
import type { Part } from "../extensions/volna/parts.ts";
import type { RpcEvent } from "../extensions/volna/rpc.ts";

interface Args {
	dir: string;
	idleMinutes: number;
	startMinutes: number;
	nudges: number;
	continues: number;
	until: number;
	skip: number[];
	model: string;
	quiet: boolean;
	dryRun: boolean;
	noCapture: boolean;
	transcript: string;
	maxToolCalls: number;
	partMinutes: number;
	help: boolean;
}

const USAGE = [
	"Прогон незакрытых частей активной задачи по флоу «Волны», каждая часть - своей сессией pi.",
	"",
	"  node --experimental-strip-types tools/plan-run.ts [ключи]",
	"",
	"  --dir <путь>        корень проекта с .volna (по умолчанию текущий каталог)",
	"  --idle <минуты>     молчание, после которого ход прерывается и просится продолжение (10)",
	"  --start <минуты>    сколько ждать первого признака хода: холодная модель отвечает не сразу (5)",
	"  --nudges <N>        сколько раз будить молчащую сессию, прежде чем считать ход потерянным (2)",
	"  --continues <N>     сколько раз просить продолжить часть, осевшую незакрытой (1)",
	"  --until <номер>     дальше этой части не идти",
	"  --skip <N,M>        не гнать эти части: они ждут человека, а не работы",
	"  --max-calls <N>     страховочный потолок вызовов на часть, 0 снимает предел (400)",
	"  --part-minutes <N>  потолок времени на часть, 0 снимает предел (90)",
	"  --model <id>        модель сессий прогона (по умолчанию модель pi)",
	"  --quiet             без потока хода работы, только итоги частей",
	"  --transcript <путь> полная стенограмма потока событий в JSONL: задания, ответы, инструменты",
	"  --no-capture        не делать вывод по задаче, когда все части закрылись",
	"  --dry-run           показать условия запуска и очередь, ничего не запуская",
	"  --help              эта справка",
	"",
	"Коды возврата: 0 части закрыты, 1 остановлен на развилке, 3 запускать нечего или сбой.",
	"Вывод через конвейер (| tee) отдаёт код последней команды, а не драйвера: читайте итог в тексте.",
].join("\n");

function parseArgs(argv: string[]): Args {
	const args: Args = {
		dir: process.cwd(),
		idleMinutes: 10,
		startMinutes: 5,
		nudges: 2,
		continues: 1,
		until: 0,
		skip: [],
		model: "",
		quiet: false,
		dryRun: false,
		noCapture: false,
		transcript: "",
		maxToolCalls: 400,
		partMinutes: 90,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i];
		const value = argv[i + 1];
		if (key === "--help" || key === "-h") args.help = true;
		else if (key === "--quiet") args.quiet = true;
		else if (key === "--dry-run") args.dryRun = true;
		else if (key === "--no-capture") args.noCapture = true;
		else if (key === "--dir") (args.dir = resolve(value ?? "")), i++;
		else if (key === "--model") (args.model = value ?? ""), i++;
		else if (key === "--transcript") (args.transcript = resolve(value ?? "")), i++;
		else if (key === "--max-calls") (args.maxToolCalls = Number(value)), i++;
		else if (key === "--part-minutes") (args.partMinutes = Number(value)), i++;
		else if (key === "--idle") (args.idleMinutes = Number(value)), i++;
		else if (key === "--start") (args.startMinutes = Number(value)), i++;
		else if (key === "--nudges") (args.nudges = Number(value)), i++;
		else if (key === "--continues") (args.continues = Number(value)), i++;
		else if (key === "--until") (args.until = Number(value)), i++;
		else if (key === "--skip") (args.skip = String(value ?? "").split(",").map(Number).filter(Number.isInteger)), i++;
		else throw new Error(`Неизвестный ключ: ${key}`);
	}
	if (!Number.isFinite(args.idleMinutes) || args.idleMinutes <= 0) throw new Error("--idle ждёт число минут больше нуля");
	if (!Number.isFinite(args.startMinutes) || args.startMinutes <= 0) throw new Error("--start ждёт число минут больше нуля");
	if (!Number.isInteger(args.nudges) || args.nudges < 0) throw new Error("--nudges ждёт целое число от нуля");
	if (!Number.isInteger(args.continues) || args.continues < 0) throw new Error("--continues ждёт целое число от нуля");
	if (!Number.isInteger(args.until) || args.until < 0) throw new Error("--until ждёт номер части");
	return args;
}

function say(line = ""): void {
	process.stdout.write(`${line}\n`);
}

/** Однострочное сжатие текста для консоли: переводы строк схлопываются, хвост обрезается. */
function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Текст сообщения модели из события потока. */
function messageText(message: any): string {
	const content = Array.isArray(message?.content) ? message.content : [];
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join(" ");
}

/**
 * Строка хода работы. Показывается и то, что драйвер подал, и то, что сессия сказала: по одним
 * именам инструментов не видно, о чём вообще шёл разговор.
 */
function progressLine(event: RpcEvent): string | null {
	const e = event as any;
	if (event.type === "driver:prompt") return `  >> ${oneLine(String(e.message ?? ""), 200)}`;
	if (event.type === "driver:abort") return "  >> прерываю ход: сессия молчит дольше порога";
	if (event.type === "driver:extension_ui_response") return `  >> отвечаю отказом на диалог ${String(e.id ?? "")}`;
	if (event.type === "tool_execution_start") {
		const args = e.args ?? {};
		const hint = String(args.command ?? args.path ?? args.file_path ?? args.action ?? args.stage ?? "");
		return `    · ${String(e.toolName ?? "")}${hint ? ` ${oneLine(hint, 140)}` : ""}`;
	}
	if (event.type === "tool_execution_end" && e.isError) {
		return `    x ${String(e.toolName ?? "")}: ${oneLine(messageText(e.result), 200)}`;
	}
	if (event.type === "message_end" && e.message?.role === "assistant") {
		const text = messageText(e.message);
		return text ? `  << ${oneLine(text, 300)}` : null;
	}
	if (event.type === "extension_ui_request" && e.method === "notify") {
		return `    ! ${oneLine(String(e.message ?? ""), 200)}`;
	}
	return null;
}

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		say(String((error as Error).message));
		say();
		say(USAGE);
		return 3;
	}
	if (args.help) {
		say(USAGE);
		return 0;
	}

	const readiness = autopilotReadiness(args.dir);
	if (!readiness.ok) {
		say(readiness.message);
		return 3;
	}
	const queue = readiness.parts.filter(
		(part) =>
			part.status !== "сделано" &&
			part.status !== "снята" &&
			!args.skip.includes(part.number) &&
			(!args.until || part.number <= args.until),
	);
	say(`Задача ${readiness.task}, незакрытых частей ${readiness.left}, в прогоне ${queue.length}.`);
	for (const part of queue) say(`  ${part.number}. ${part.title} - ${part.status}`);
	for (const warning of readiness.warnings) say(`ВНИМАНИЕ: ${warning}`);
	if (!queue.length) {
		say("Гнать нечего.");
		return 3;
	}
	if (args.dryRun) return 0;

	// Стенограмма пишется построчно и сразу: прогон длинный, и прерванный он должен оставить всё,
	// что успело произойти. Потоковые довески текста в неё не идут - они повторяют накопленное
	// сообщение на каждом токене и раздувают файл, ничего не добавляя.
	let transcribe: ((part: string, event: RpcEvent) => void) | undefined;
	if (args.transcript) {
		writeFileSync(args.transcript, "", "utf8");
		transcribe = (part, event) => {
			if (event.type === "message_update") return;
			appendFileSync(args.transcript, `${JSON.stringify({ at: new Date().toISOString(), part, ...event })}\n`, "utf8");
		};
		say(`Стенограмма: ${args.transcript}`);
	}

	// Прерывание с клавиатуры не роняет прогон на месте: текущая сессия снимается, и человек
	// получает итог с причиной, а не оборванный вывод.
	const canceller = new AbortController();
	process.on("SIGINT", () => {
		say("\nОтмена: снимаю текущую сессию.");
		canceller.abort();
	});

	const options: AutopilotOptions = {
		cwd: args.dir,
		readiness,
		idleMs: Math.round(args.idleMinutes * 60 * 1000),
		startMs: Math.round(args.startMinutes * 60 * 1000),
		maxNudges: args.nudges,
		maxContinues: args.continues,
		maxToolCalls: args.maxToolCalls,
		partMs: Math.round(args.partMinutes * 60 * 1000),
		until: args.until,
		skip: args.skip,
		args: args.model ? ["--model", args.model] : [],
		signal: canceller.signal,
		onPart: (part: Part, index: number, total: number) => {
			say();
			say(`[${index + 1}/${total}] часть ${part.number}: ${part.title}`);
		},
		onEvent: (part, event) => {
				transcribe?.(`часть ${part.number}`, event);
				if (args.quiet) return;
				const line = progressLine(event);
				if (line) say(line);
			},
		onPartDone: (log) => {
			const marks = [
				log.closed ? "закрыта" : "не закрыта",
				`вызовов инструментов ${log.toolCalls}`,
				log.nudges ? `напоминаний ${log.nudges}` : "",
				log.asks.length ? `вопросов человеку ${log.asks.length}` : "",
				log.stray.length ? `тронуто чужих частей ${log.stray.length}` : "",
				log.strayPaths.length ? `файлов за границей ${log.strayPaths.length}` : "",
				log.closedWithoutHuman ? "закрыта без приёмки человеком" : "",
			].filter(Boolean);
			say(`  итог части ${log.part}: ${marks.join(", ")}`);
		},
	};

	const report = await runAutopilot(options);
	say();
	say(`Прогон окончен: ${report.stop}.`);
	if (report.closed.length) say(`Закрыто: ${report.closed.length === 1 ? "часть" : "части"} ${report.closed.join(", ")}.`);
	if (report.detail) say(report.detail);

	// Вывод по задаче делается только на закрытой очереди: на половине задачи сквозных выводов
	// ещё нет, а лог целиком читается ради них одних.
	if (report.stop === "все части закрыты" && !args.noCapture && !canceller.signal.aborted) {
		say();
		say("Вывод по задаче: читаю журнал целиком.");
		const capture = await runTaskCapture({
			cwd: args.dir,
			volnaDir: readiness.volnaDir,
			task: readiness.task,
			idleMs: options.idleMs,
			startMs: options.startMs,
			maxNudges: options.maxNudges,
			args: options.args,
			signal: canceller.signal,
			onEvent: (event) => {
					transcribe?.("вывод по задаче", event);
					if (args.quiet) return;
					const line = progressLine(event);
					if (line) say(line);
				},
		});
		say(`  вывод по задаче: вызовов инструментов ${capture.toolCalls}${capture.asks.length ? `, вопросов человеку ${capture.asks.length}` : ""}`);
		if (capture.lastText) {
			say();
			say(capture.lastText.slice(0, 1200));
		}
	}
	const last = report.runs[report.runs.length - 1];
	if (last && !last.closed && last.lastText) {
		say();
		say("Последнее слово сессии:");
		say(last.lastText.slice(0, 1200));
	}
	return report.stop === "все части закрыты" ? 0 : 1;
}

process.exitCode = await main();
