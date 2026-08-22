/** Дифф для адвоката и разбор вердикта. Настоящий git, без обращений к модели. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectDiff, parseVerdict } from "../extensions/volna/advocate.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { runVisualCheck } from "../extensions/volna/visual.ts";
import { check, exec, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	const dir = sandbox("advocate", { git: false });
	await exec("git", ["init", "-q", dir]);
	await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
	await exec("git", ["-C", dir, "config", "user.name", "test"]);
	writeFileSync(join(dir, "list.js"), "export function render(items) {\n  return items.map(String);\n}\n", "utf8");
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-q", "-m", "base"]);
	writeFileSync(join(dir, "list.js"), "export function render(items) {\n  if (!items.length) return ['пусто'];\n  return items.map(String);\n}\n", "utf8");
	writeFileSync(join(dir, "empty-state.js"), "export const EMPTY = 'пусто';\n", "utf8");
	writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));

	initVolna(dir);
	const volnaDir = join(dir, ".volna");

	const diff = await collectDiff(exec, volnaDir, "test-task", "HEAD");
	const body = readFileSync(diff.path, "utf8");
	check("дифф собран", !diff.empty);
	check("изменённая строка в диффе", body.includes("if (!items.length)"));
	check("новый файл в диффе", body.includes("empty-state.js") && body.includes("EMPTY"));
	check("бинарный файл не вставлен", body.includes("бинарный файл"), "blob.bin");
	check("сводка изменений есть", diff.stat.includes("list.js"));
	check("дифф лежит в .volna/advocate", diff.path.includes("advocate"));
	check("служебное «Волны» в дифф не попало", !body.includes("новый файл, ещё не в индексе: .volna"));

	check("вердикт разбирается", parseVerdict("...текст...\nВЕРДИКТ: дефекты") === "дефекты");
	check("вердикт не выдумывается", parseVerdict("всё хорошо") === "не определён");

	const visual = await runVisualCheck(exec, { volnaDir, task: "test-task", url: "http://127.0.0.1:9/" });
	check("визуальная проверка не падает без playwright", visual.verdict === "не выполнено", visual.verdict);
	check("сказано, чего не хватает", visual.summary.toLowerCase().includes("playwright"), visual.summary.slice(0, 80));
}
