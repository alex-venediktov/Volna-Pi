/** Инструменты вызываются тем же путём, каким их вызывает модель: через registerTools. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initVolna } from "../extensions/volna/init.ts";
import { loadActive, readState } from "../extensions/volna/state.ts";
import { registerTools } from "../extensions/volna/tools.ts";
import { check, exec, sandbox, toolText } from "./harness.ts";

const TOOL_NAMES = ["volna_task", "volna_stage", "volna_journal", "volna_advocate", "volna_visual", "volna_finish", "volna_recall"];

export async function run(): Promise<void> {
	const dir = sandbox("tools");
	const tools = new Map<string, any>();
	const fakePi: any = {
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: () => {},
		on: () => {},
		exec,
	};
	registerTools(fakePi);

	const ctx: any = { cwd: dir, hasUI: false, mode: "print" };
	const call = (name: string, params: any) => tools.get(name).execute("call-1", params, undefined, undefined, ctx);

	check("зарегистрированы все инструменты", TOOL_NAMES.every((name) => tools.has(name)), [...tools.keys()].join(", "));
	check("схема этапов перечисляет этапы", JSON.stringify(tools.get("volna_stage").parameters).includes("unit-tests"));
	check("у инструментов есть промпт-подсказки", [...tools.values()].every((tool) => typeof tool.promptSnippet === "string"));

	let refusal = "";
	try {
		await call("volna_task", { assignment: "что-нибудь" });
	} catch (error: any) {
		refusal = String(error?.message ?? error);
	}
	check("без .volna задание не принимается", refusal.includes("не развёрнута"), refusal.slice(0, 50));

	initVolna(dir);
	const volnaDir = join(dir, ".volna");

	check("задание принято инструментом", toolText(await call("volna_task", { assignment: "Добавить экспорт отчёта в CSV" })).includes("Задача принята"));
	const task = readState(volnaDir).active!;

	check("этап выдал обязанности", toolText(await call("volna_stage", { stage: "analyze" })).includes("Обязанности на этапе"));
	check("этап записан", loadActive(dir)!.fm.stage === "analyze");

	const logged = await call("volna_journal", {
		action: "log",
		what: "нашёл место экспорта",
		why: "понять, куда добавлять CSV",
		how: "src/reports/Export.tsx:31",
		done: "место найдено",
		left: "-",
	});
	check("секция записана инструментом", toolText(logged).includes("итерация 1"), toolText(logged));

	check("проверка видит отставание", toolText(await call("volna_journal", { action: "check" })).includes("отстало"));
	await call("volna_journal", {
		action: "state",
		goal: "отчёт выгружается в CSV",
		done: "место экспорта найдено",
		next: "постановка и критерии приёмки",
	});
	check("после записи «Состояния» журнал в порядке", toolText(await call("volna_journal", { action: "check" })).includes("в порядке"));

	await call("volna_journal", { action: "open", open: ["нужен пример файла CSV от заказчика"] });
	check("открытые вопросы записаны", (loadActive(dir)!.fm.open as string[])[0].includes("CSV"));

	check("поиск работает", toolText(await call("volna_recall", { query: "экспорт отчёта" })).includes("Найдено"));

	const advocate = await call("volna_advocate", {});
	check("адвокат на пустом дереве не падает", toolText(advocate).includes("проверять нечего"), toolText(advocate).slice(0, 70));

	writeFileSync(join(volnaDir, "project.md"), `# Проект

## Профиль

- endpoint браузера: http://127.0.0.1:9
`, "utf8");
	const visual = await call("volna_visual", { url: "http://127.0.0.1:9/" });
	check("визуальная проверка сообщает, что браузера нет", toolText(visual).includes("не отвечает"), toolText(visual).slice(0, 80));

	check("задача закрыта", toolText(await call("volna_finish", { summary: "CSV-экспорт добавлен, тест зелёный", hours: "1.5" })).includes("закрыта"));
	check("активная задача снята", readState(volnaDir).active === null);
	check("итог в «Состоянии»", readFileSync(join(volnaDir, "journal", `TASK-${task}.md`), "utf8").includes("CSV-экспорт добавлен"));
	check("часы в логе", readFileSync(join(volnaDir, "journal", "logs", `TASK-${task}.log.md`), "utf8").includes("часы по меткам журнала: 1.5"));
}
