/**
 * Пакет в проекте, где «Волна» не развёрнута: инструментов, команд флоу и скиллов быть не должно.
 *
 * Проверяется именно то, за что платит любой другой проект, если правило нарушить: префикс
 * системного промпта. Инструменты и скиллы лежат в нём на каждом запросе, поэтому спящий пакет -
 * это не удобство, а условие, при котором «Волну» можно держать установленной постоянно.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import volna from "../extensions/volna/index.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { packageRoot } from "../extensions/volna/paths.ts";
import { check, sandbox } from "./harness.ts";

/** Поддельный pi: считает, что расширение успело зарегистрировать к этому моменту. */
function fake() {
	const handlers = new Map<string, any>();
	const tools = new Set<string>();
	const commands = new Set<string>();
	const notices: string[] = [];
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (definition: any) => tools.add(definition.name),
		registerCommand: (name: string) => commands.add(name),
		sendMessage: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	};
	const ctx = (cwd: string): any => ({
		cwd,
		hasUI: false,
		mode: "tui",
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
		reload: async () => {},
	});
	volna(pi);
	return { pi, handlers, tools, commands, notices, ctx };
}

export async function run(): Promise<void> {
	await withoutVolna();
	await withVolna();
	await deployedMidSession();
	await deployedByCommand();
}

/** Без .volna: модель не видит ни инструментов, ни скиллов, а события молчат. */
async function withoutVolna(): Promise<void> {
	const dir = sandbox("dormant-plain");
	const { handlers, tools, commands, ctx } = fake();

	check("до старта сессии инструментов нет", tools.size === 0, [...tools].join(", "));
	check("развернуть и проверить настройку можно и без .volna", commands.has("volna:init") && commands.has("volna:doctor"));
	check("команд флоу без .volna нет", ![...commands].some((name) => name === "volna:task" || name === "volna:analyze"), [...commands].join(", "));

	await handlers.get("session_start")({ reason: "startup" }, ctx(dir));
	check("старт сессии в чужом проекте инструментов не добавляет", tools.size === 0, [...tools].join(", "));
	check("скиллы без .volna не отдаются", (await handlers.get("resources_discover")({ cwd: dir, reason: "startup" })) === undefined);
	check("шапки контекста без .volna нет", (await handlers.get("before_agent_start")({ systemPrompt: "" }, ctx(dir))) === undefined);
	check("правки в чужом проекте не блокируются", (await handlers.get("tool_call")({ toolName: "write", input: { path: join(dir, "a.js") } }, ctx(dir))) === undefined);
	check("сжатие в чужом проекте не отменяется", (await handlers.get("session_before_compact")({ reason: "manual" }, ctx(dir))) === undefined);
}

/** С .volna: старт сессии поднимает инструменты, команды этапов и скиллы. */
async function withVolna(): Promise<void> {
	const dir = sandbox("dormant-deployed");
	initVolna(dir);
	const { handlers, tools, commands, ctx } = fake();

	await handlers.get("session_start")({ reason: "startup" }, ctx(dir));
	check("в проекте с .volna инструменты появляются", tools.has("volna_task") && tools.has("volna_stage") && tools.has("volna_journal"), [...tools].join(", "));
	check("команды этапов появляются вместе с инструментами", commands.has("volna:analyze") && commands.has("volna:status"));

	const skills = await handlers.get("resources_discover")({ cwd: dir, reason: "startup" });
	const skillDir = join(packageRoot(), "skills");
	check("скиллы отдаёт расширение, а не манифест пакета", skills?.skillPaths?.[0] === skillDir, String(skills?.skillPaths));
	check("отданный каталог скиллов существует", existsSync(skillDir), skillDir);
}

/** .volna, развёрнутая руками посреди сессии, подхватывается на следующем ходе. */
async function deployedMidSession(): Promise<void> {
	const dir = sandbox("dormant-late");
	const { handlers, tools, ctx } = fake();

	await handlers.get("session_start")({ reason: "startup" }, ctx(dir));
	check("пока .volna нет, инструментов нет", tools.size === 0);

	initVolna(dir);
	await handlers.get("before_agent_start")({ systemPrompt: "" }, ctx(dir));
	check("после развёртывания инструменты появляются без перезапуска", tools.has("volna_task"), [...tools].join(", "));
}

/** /volna:init разворачивает «Волну» и тем же вызовом включает остальной пакет. */
async function deployedByCommand(): Promise<void> {
	const dir = sandbox("dormant-command");
	const handlers = new Map<string, any>();
	const tools = new Set<string>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const pi: any = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (definition: any) => tools.add(definition.name),
		registerCommand: (name: string, options: any) => commands.set(name, options),
		sendMessage: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	};
	volna(pi);

	let reloaded = false;
	await commands.get("volna:init").handler("", {
		cwd: dir,
		hasUI: false,
		mode: "tui",
		ui: { notify: (message: string) => notices.push(message), setStatus: () => {}, setWidget: () => {}, theme: { fg: (_c: string, t: string) => t } },
		reload: async () => {
			reloaded = true;
		},
	});

	check("команда развернула .volna", existsSync(join(dir, ".volna", "project.md")));
	check("инструменты доступны сразу после развёртывания", tools.has("volna_task"), [...tools].join(", "));
	check("команды этапов доступны сразу после развёртывания", commands.has("volna:plan"));
	check("ресурсы перезагружены, чтобы подхватились скиллы", reloaded);
	check("человеку сказано, где развёрнута", notices.some((note) => note.includes("Волна развёрнута")), notices.join(" | "));
}
