/** События расширения: шапка контекста, гейт правок до реализации, отмена сжатия при отставшем журнале. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { enterStage, intake } from "../extensions/volna/core.ts";
import volna from "../extensions/volna/index.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { appendLogSection } from "../extensions/volna/journal.ts";
import { readState } from "../extensions/volna/state.ts";
import { check, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	const dir = sandbox("events");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");

	const handlers = new Map<string, any>();
	const sent: any[] = [];
	const notices: string[] = [];
	const status: Record<string, string | undefined> = {};
	const fakePi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	};
	volna(fakePi);
	check(
		"подписки на события есть",
		["session_start", "before_agent_start", "tool_call", "session_before_compact", "agent_settled"].every((event) => handlers.has(event)),
	);

	const ctx: any = {
		cwd: dir,
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (key: string, text?: string) => {
				status[key] = text;
			},
			setWidget: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	const toolCall = (toolName: string, input: any) => handlers.get("tool_call")({ toolName, input }, ctx);

	check("без задачи шапки нет", (await handlers.get("before_agent_start")({ systemPrompt: "" }, ctx)) === undefined);
	check("без задачи правки не блокируются", (await toolCall("write", { path: join(dir, "src.js") })) === undefined);

	intake(dir, { assignment: "Добавить фильтр по дате в список заказов" });
	const task = readState(volnaDir).active!;
	await enterStage(dir, "analyze");

	const header = await handlers.get("before_agent_start")({ systemPrompt: "исходный промпт" }, ctx);
	check("шапка идёт отдельным сообщением", header?.message?.customType === "volna-header");
	check("в шапке этап и позиция", String(header.message.content).includes("этап analyze 2/11"));
	check("системный промпт не подменён", header.systemPrompt === "исходный промпт");

	const blocked = await toolCall("write", { path: join(dir, "src", "orders.js") });
	check("правка кода на analyze заблокирована", blocked?.block === true, String(blocked?.reason).slice(0, 60));
	check("правка внутри .volna разрешена", (await toolCall("edit", { path: join(volnaDir, "project.md") })) === undefined);
	check("чтение не блокируется", (await toolCall("read", { path: join(dir, "src.js") })) === undefined);

	// Лог итераций - история всех частей вместе с отвергнутыми подходами. Запрет держится
	// устройством, а не просьбой в промпте: просьбу видно один раз в начале хода, а тянется сессия
	// к логу тогда, когда уже потеряла нить.
	const ownLog = join(volnaDir, "journal", "logs", `TASK-${task}.log.md`);
	const foreignLog = join(volnaDir, "journal", "logs", "TASK-260101-chuzhaya.log.md");
	const logBlocked = await toolCall("read", { path: ownLog });
	check("свой лог итераций читать целиком нельзя", logBlocked?.block === true, String(logBlocked?.reason).slice(0, 60));
	check("в отказе назван адрес «Состояния»", String(logBlocked?.reason).includes("Состояние"), String(logBlocked?.reason).slice(0, 120));
	check("чужой лог тоже закрыт", (await toolCall("read", { path: foreignLog }))?.block === true);
	check("файл состояния задачи читается свободно", (await toolCall("read", { path: join(volnaDir, "journal", `TASK-${task}.md`) })) === undefined);
	const catLog = await toolCall("bash", { command: `cat ${ownLog}` });
	check("обход через оболочку закрыт тоже", catLog?.block === true, String(catLog?.reason).slice(0, 60));
	const grepLog = await toolCall("bash", { command: `grep -n "почему" ${ownLog}` });
	check("поиск по логу тоже закрыт: он дописывается, а не читается", grepLog?.block === true, String(grepLog?.reason).slice(0, 60));
	check("git оставлен: он кладёт журнал в коммит, а не читает", (await toolCall("bash", { command: `git add ${ownLog}` })) === undefined);
	check("обычная команда оболочки не задета", (await toolCall("bash", { command: "cat package.json" })) === undefined);

	await enterStage(dir, "implement", { reason: "правки по плану" });
	check("на implement правки разрешены", (await toolCall("write", { path: join(dir, "src", "orders.js") })) === undefined);

	await enterStage(dir, "plan", { reason: "вернулись к плану" });
	check("на plan гейт снова работает", (await toolCall("write", { path: join(dir, "a.js") }))?.block === true);
	writeFileSync(join(volnaDir, "project.md"), "# Проект\n\n## Профиль\n\n- гейт правок: нет\n", "utf8");
	check("строка профиля снимает гейт", (await toolCall("write", { path: join(dir, "a.js") })) === undefined);

	appendLogSection(volnaDir, task, { stage: "plan", fields: { что: "план готов", сделано: "план", осталось: "-" } });
	const manual = await handlers.get("session_before_compact")({ reason: "manual" }, ctx);
	check("сжатие отменено при отставшем журнале", manual?.cancel === true);
	check("модели ушла просьба дописать", sent.some((item) => item.message.customType === "volna-checkpoint"));
	check("человеку сказано, почему отложено", notices.some((note) => note.includes("сжатие отложено")));
	check("при переполнении сжатие не отменяется", (await handlers.get("session_before_compact")({ reason: "overflow" }, ctx)) === undefined);

	notices.length = 0;
	await enterStage(dir, "unit-tests");
	await toolCall("bash", { command: 'git commit -m "wip"' });
	check("коммит без записи по этапу предупреждён", notices.some((note) => note.includes("записи в журнале ещё нет")));

	await handlers.get("agent_settled")({}, ctx);
	check("статус этапа в футере", String(status.volna).includes("unit-tests"), String(status.volna));
}
