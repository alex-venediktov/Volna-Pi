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
	enterStage(dir, "analyze");

	const header = await handlers.get("before_agent_start")({ systemPrompt: "исходный промпт" }, ctx);
	check("шапка идёт отдельным сообщением", header?.message?.customType === "volna-header");
	check("в шапке этап и позиция", String(header.message.content).includes("этап analyze 2/10"));
	check("системный промпт не подменён", header.systemPrompt === "исходный промпт");

	const blocked = await toolCall("write", { path: join(dir, "src", "orders.js") });
	check("правка кода на analyze заблокирована", blocked?.block === true, String(blocked?.reason).slice(0, 60));
	check("правка внутри .volna разрешена", (await toolCall("edit", { path: join(volnaDir, "project.md") })) === undefined);
	check("чтение не блокируется", (await toolCall("read", { path: join(dir, "src.js") })) === undefined);

	enterStage(dir, "implement", { reason: "правки по плану" });
	check("на implement правки разрешены", (await toolCall("write", { path: join(dir, "src", "orders.js") })) === undefined);

	enterStage(dir, "plan", { reason: "вернулись к плану" });
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
	enterStage(dir, "unit-tests");
	await toolCall("bash", { command: 'git commit -m "wip"' });
	check("коммит без записи по этапу предупреждён", notices.some((note) => note.includes("записи в журнале ещё нет")));

	await handlers.get("agent_settled")({}, ctx);
	check("статус этапа в футере", String(status.volna).includes("unit-tests"), String(status.volna));
}
