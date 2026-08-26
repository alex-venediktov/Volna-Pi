/** Правки для адвоката: git против точки начала части, отказ без git. И unified diff своими силами. */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectChanges } from "../extensions/volna/changes.ts";
import { fileDiff } from "../extensions/volna/diff.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { check, exec, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	await gitSource();
	await withoutGit();
	await freshRepo();
	unifiedDiff();
}

/** git: правки, новый файл и удаление видны; база - переданный коммит, а не только HEAD. */
async function gitSource(): Promise<void> {
	const dir = sandbox("changes-git", { git: false });
	await exec("git", ["init", "-q", dir]);
	await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
	await exec("git", ["-C", dir, "config", "user.name", "test"]);
	writeFileSync(join(dir, "keep.js"), "export const a = 1;\n", "utf8");
	writeFileSync(join(dir, "gone.js"), "export const b = 2;\n", "utf8");
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-q", "-m", "base"]);
	const start = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
	writeFileSync(join(dir, "keep.js"), "export const a = 42;\n", "utf8");
	rmSync(join(dir, "gone.js"));
	writeFileSync(join(dir, "fresh.js"), "export const c = 3;\n", "utf8");
	writeFileSync(join(dir, ".gitignore"), "secret.env\n", "utf8");
	writeFileSync(join(dir, "secret.env"), "TOKEN=не-для-адвоката\n", "utf8");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");

	const changes = await collectChanges(exec, { volnaDir });
	check("git найден", changes.repo);
	check("база - HEAD, когда другой не задано", changes.base === "HEAD", changes.base);
	check("изменённый файл виден", changes.files.some((f) => f.path === "keep.js" && f.status === "изменён"));
	check("удалённый файл виден", changes.files.some((f) => f.path === "gone.js" && f.status === "удалён"));
	check("новый файл виден", changes.files.some((f) => f.path === "fresh.js" && f.status === "добавлен"));
	check("дифф содержит правку", changes.diff.includes("export const a = 42"));
	check("игнорируемый файл адвокату не показывается", !changes.diff.includes("не-для-адвоката"), "secret.env");
	check("служебное «Волны» в дифф не попало", !changes.files.some((f) => f.path.startsWith(".volna/")));

	// коммит внутри части: против HEAD правок уже нет, против точки начала части - есть
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-q", "-m", "часть"]);
	check("против HEAD после коммита пусто", (await collectChanges(exec, { volnaDir })).files.length === 0);
	const fromStart = await collectChanges(exec, { volnaDir, base: start });
	check("против точки начала части правки на месте", fromStart.files.length >= 3, JSON.stringify(fromStart.files));
	check("база названа явно", fromStart.base === start, fromStart.base);

	const lost = await collectChanges(exec, { volnaDir, base: "0000000000000000000000000000000000000000" });
	check("пропавшая база не выдумывается", lost.notes.join(" ").includes("не найдена"), lost.notes.join(" ").slice(0, 80));
}

/** Без git проверять нечего, и это сказано прямо, а не пустым списком правок. */
async function withoutGit(): Promise<void> {
	const dir = sandbox("changes-nogit", { git: false });
	writeFileSync(join(dir, "app.js"), "export const a = 1;\n", "utf8");
	initVolna(dir);

	const changes = await collectChanges(exec, { volnaDir: join(dir, ".volna") });
	check("без git репозитория нет", !changes.repo);
	check("правки не выдумываются", changes.files.length === 0 && changes.diff === "");
	check("причина названа человеку", changes.notes.join(" ").includes("git-репозитория здесь нет"), changes.notes.join(" ").slice(0, 70));
}

/** Свежий репозиторий без коммитов: базы нет, но работа видна как новые файлы. */
async function freshRepo(): Promise<void> {
	const dir = sandbox("changes-fresh", { git: false });
	await exec("git", ["init", "-q", dir]);
	writeFileSync(join(dir, "app.js"), "export const a = 1;\n", "utf8");
	initVolna(dir);

	const changes = await collectChanges(exec, { volnaDir: join(dir, ".volna") });
	check("репозиторий найден и без коммитов", changes.repo);
	check("отсутствие коммитов названо", changes.notes.join(" ").includes("ещё нет коммитов"), changes.notes.join(" ").slice(0, 70));
	check("файлы всё равно видны адвокату", changes.files.some((f) => f.path === "app.js" && f.status === "добавлен"));
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
