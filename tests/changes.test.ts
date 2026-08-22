/** Источники изменений: git, снимок дерева, команда проекта. И unified diff своими силами. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectChanges, compareWithSnapshot, needsSnapshot, snapshotExists, takeSnapshot } from "../extensions/volna/changes.ts";
import { fileDiff } from "../extensions/volna/diff.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { intake } from "../extensions/volna/core.ts";
import { check, exec, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	await gitSource();
	await snapshotSource();
	await commandSource();
	unifiedDiff();
}

/** git: правки, новый файл и удаление видны, база - HEAD. */
async function gitSource(): Promise<void> {
	const dir = sandbox("changes-git", { git: false });
	await exec("git", ["init", "-q", dir]);
	await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
	await exec("git", ["-C", dir, "config", "user.name", "test"]);
	writeFileSync(join(dir, "keep.js"), "export const a = 1;\n", "utf8");
	writeFileSync(join(dir, "gone.js"), "export const b = 2;\n", "utf8");
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-q", "-m", "base"]);
	writeFileSync(join(dir, "keep.js"), "export const a = 42;\n", "utf8");
	rmSync(join(dir, "gone.js"));
	writeFileSync(join(dir, "fresh.js"), "export const c = 3;\n", "utf8");
	initVolna(dir);

	const changes = await collectChanges(exec, { volnaDir: join(dir, ".volna"), profile: {} });
	check("git выбран источником", changes.kind === "git", changes.kind);
	check("база - HEAD", changes.base === "HEAD");
	check("изменённый файл виден", changes.files.some((f) => f.path === "keep.js" && f.status === "изменён"));
	check("удалённый файл виден", changes.files.some((f) => f.path === "gone.js" && f.status === "удалён"));
	check("новый файл виден", changes.files.some((f) => f.path === "fresh.js" && f.status === "добавлен"));
	check("дифф содержит правку", changes.diff.includes("export const a = 42"));
	check("снимок при git не нужен", !needsSnapshot(join(dir, ".volna"), {}));
}

/** Без системы контроля версий: снимок дерева даёт и список файлов, и настоящий дифф. */
async function snapshotSource(): Promise<void> {
	const dir = sandbox("changes-snapshot", { git: false });
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
	writeFileSync(join(dir, "src", "list.js"), "function render(items) {\n  return items.map(String);\n}\n", "utf8");
	writeFileSync(join(dir, "src", "old.js"), "const removeMe = true;\n", "utf8");
	writeFileSync(join(dir, "node_modules", "junk", "index.js"), "module.exports = 1;\n", "utf8");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	const taken = intake(dir, { assignment: "Показать заглушку для пустого списка" });
	const task = taken.task!;

	check("без vcs снимок нужен", needsSnapshot(volnaDir, {}));
	const snapshot = takeSnapshot(volnaDir, task, {});
	check("снимок снят", snapshotExists(volnaDir, task) && snapshot.files >= 2, `${snapshot.files} файлов`);
	check("node_modules в снимок не попал", snapshot.files < 10, `${snapshot.files} файлов`);

	const nothing = compareWithSnapshot(volnaDir, task, {});
	check("сразу после снимка изменений нет", nothing.files.length === 0, JSON.stringify(nothing.files));

	writeFileSync(join(dir, "src", "list.js"), "function render(items) {\n  if (!items.length) return ['пусто'];\n  return items.map(String);\n}\n", "utf8");
	writeFileSync(join(dir, "src", "empty.js"), "export const EMPTY = 'пусто';\n", "utf8");
	rmSync(join(dir, "src", "old.js"));

	const changes = await collectChanges(exec, { volnaDir, profile: {} });
	check("источник - снимок", changes.kind === "снимок «Волны»", changes.kind);
	check("правка видна", changes.files.some((f) => f.path === "src/list.js" && f.status === "изменён"));
	check("новый файл виден", changes.files.some((f) => f.path === "src/empty.js" && f.status === "добавлен"));
	check("удаление видно", changes.files.some((f) => f.path === "src/old.js" && f.status === "удалён"));
	check("дифф построчный", changes.diff.includes("+  if (!items.length)") && changes.diff.includes("--- a/src/list.js"), changes.diff.split("\n").slice(0, 6).join(" | "));
	check("контекст в диффе есть", changes.diff.includes("   return items.map(String);") || changes.diff.includes(" function render(items) {"));

	// снимок без активной задачи и без vcs: честный отказ, а не пустой вердикт
	const empty = compareWithSnapshot(volnaDir, "нет-такой-задачи", {});
	check("нет снимка - сказано прямо", empty.notes.join(" ").includes("сравнивать не с чем"), empty.notes.join(" ").slice(0, 60));
}

/** Команда проекта: сюда подключаются TFVC, Perforce и всё, чего «Волна» не знает. */
async function commandSource(): Promise<void> {
	const dir = sandbox("changes-command", { git: false });
	writeFileSync(join(dir, "unit.pas"), "procedure Foo;\nbegin\nend;\n", "utf8");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");

	writeFileSync(join(dir, "list-changes.mjs"), "console.log('M unit.pas');\n", "utf8");
	writeFileSync(join(dir, "show-diff.mjs"), "console.log('--- a/unit.pas');\n", "utf8");
	const profile = { изменения: "node list-changes.mjs" };
	const changes = await collectChanges(exec, { volnaDir, profile });
	check("источник - команда проекта", changes.kind === "команда проекта", changes.kind);
	check("файл из вывода команды разобран", changes.files.some((f) => f.path === "unit.pas" && f.status === "изменён"), JSON.stringify(changes.files));
	check("без команды диффа содержимое вложено", changes.diff.includes("procedure Foo"), changes.diff.slice(0, 60));
	check("сказано, что это не дифф", changes.notes.join(" ").includes("не как правки"));

	const withDiff = await collectChanges(exec, {
		volnaDir,
		profile: { ...profile, дифф: "node show-diff.mjs" },
	});
	check("команда диффа используется", withDiff.diff.includes("--- a/unit.pas"));
	check("команда отменяет снимок", !needsSnapshot(volnaDir, profile));
}

/** Собственный unified diff: правка, добавление, удаление, слишком большой файл. */
function unifiedDiff(): void {
	const before = "line one\nline two\nline three\nline four\n";
	const after = "line one\nline two changed\nline three\nline four\nline five\n";
	const diff = fileDiff({ path: "a.txt", before, after });
	check("дифф помечает удалённую строку", diff.includes("-line two"));
	check("дифф помечает добавленную строку", diff.includes("+line two changed") && diff.includes("+line five"));
	check("дифф оставляет контекст", diff.includes(" line one"));
	check("заголовок куска на месте", /@@ -\d+,\d+ \+\d+,\d+ @@/.test(diff), diff.split("\n")[2]);
	check("одинаковые файлы диффа не дают", fileDiff({ path: "a.txt", before, after: before }) === "");
	check("новый файл целиком со плюсами", fileDiff({ path: "n.txt", before: null, after: "x\n" }).includes("+x"));
	check("удалённый файл целиком с минусами", fileDiff({ path: "d.txt", before: "x\n", after: null }).includes("-x"));

	const huge = `${"строка\n".repeat(5000)}`;
	check("огромный файл не сравнивается построчно", fileDiff({ path: "big.txt", before: huge, after: `${huge}хвост\n` }).includes("слишком большой"));
	check("причина недоступности содержимого доходит", fileDiff({ path: "b.bin", before: null, after: null, note: "бинарный файл" }).includes("бинарный файл"));
}
