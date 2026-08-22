/** Доставка в git: ветка задачи, коммит части, push. Настоящий git, удалённый - локальный bare. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchFor, commitChanges, deliverySettings, ensureBranch, gitState, pushBranch } from "../extensions/volna/git.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { intake } from "../extensions/volna/core.ts";
import { writeStateSection } from "../extensions/volna/journal.ts";
import { loadActive, readState } from "../extensions/volna/state.ts";
import { registerTools } from "../extensions/volna/tools.ts";
import { check, exec, sandbox, toolText } from "./harness.ts";

export async function run(): Promise<void> {
	const empty = deliverySettings({});
	check("без строки профиля доставка не задана", empty.mode === "" && empty.remote === "origin", empty.mode);
	check("«нет» выключает доставку", deliverySettings({ доставка: "нет" }).mode === "нет");
	check("push включается профилем", deliverySettings({ доставка: "commit+push" }).mode === "commit+push");
	check("плейсхолдер не считается ответом", deliverySettings({ доставка: "<нет | commit>" }).mode === "");
	check(
		"имя ветки собирается по шаблону",
		branchFor("<тип>/<задача>", { id: "260822-csv-export", type: "bug" }) === "bugfix/260822-csv-export",
		branchFor("<тип>/<задача>", { id: "260822-csv-export", type: "bug" }),
	);
	check("слаг без даты", branchFor("wip/<слаг>", { id: "260822-csv-export", type: "task" }) === "wip/csv-export");

	const dir = sandbox("deliver", { git: false });
	const remoteDir = join(dir, "..", "volna-test-deliver-remote");
	mkdirSync(dir, { recursive: true });
	rmSync(remoteDir, { recursive: true, force: true });
	await exec("git", ["init", "-q", "--bare", remoteDir]);
	await exec("git", ["init", "-q", dir]);
	await exec("git", ["-C", dir, "config", "user.email", "volna@test"]);
	await exec("git", ["-C", dir, "config", "user.name", "volna"]);
	await exec("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
	writeFileSync(join(dir, "app.js"), "export const step = 1;\n", "utf8");
	await exec("git", ["-C", dir, "add", "-A"]);
	await exec("git", ["-C", dir, "commit", "-q", "-m", "начало"]);
	await exec("git", ["-C", dir, "branch", "-m", "main"]);

	const before = await gitState(exec, dir, "origin");
	check("состояние репозитория читается", before.repo && before.branch === "main", `${before.repo} ${before.branch}`);
	check("удалённый найден", before.hasRemote);
	check("upstream ещё нет", before.upstream === null);

	const branch = await ensureBranch(exec, dir, { branch: "feature/260822-shagi", dirty: false });
	check("ветка задачи создана", branch.ok && branch.created, branch.message);
	check("повторный вызов ничего не ломает", (await ensureBranch(exec, dir, { branch: "feature/260822-shagi", dirty: false })).created === false);

	writeFileSync(join(dir, "app.js"), "export const step = 2;\n", "utf8");
	const first = await commitChanges(exec, dir, { message: "часть 1: шаги" });
	check("коммит части сделан", first.ok && first.committed && first.files.includes("app.js"), first.message);
	check("пустой коммит не делается", (await commitChanges(exec, dir, { message: "часть 1: шаги" })).committed === false);

	const pushed = await pushBranch(exec, dir, { remote: "origin", branch: "feature/260822-shagi", upstream: null });
	check("ветка отправлена", pushed.ok, pushed.message);
	const afterPush = await gitState(exec, dir, "origin");
	check("upstream появился", afterPush.upstream === "origin/feature/260822-shagi", String(afterPush.upstream));
	check("неотправленного не осталось", afterPush.ahead === 0, String(afterPush.ahead));

	writeFileSync(join(dir, "app.js"), "export const step = 3;\n", "utf8");
	await commitChanges(exec, dir, { message: "часть 2: продолжение" });
	const second = await gitState(exec, dir, "origin");
	check("вторая часть считается неотправленной", second.ahead === 1, String(second.ahead));
	check("та же ветка на обе части", second.branch === "feature/260822-shagi", second.branch);

	await throughTool(dir);
}

/** Тот же путь, каким доставку делает модель: через инструмент volna_deliver. */
async function throughTool(dir: string): Promise<void> {
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	writeFileSync(join(volnaDir, "project.md"), `# Проект

## Профиль

- доставка: commit+push
- ветка: <тип>/<задача>
- удалённый: origin
`, "utf8");

	const tools = new Map<string, any>();
	registerTools({ registerTool: (definition: any) => tools.set(definition.name, definition), registerCommand: () => {}, on: () => {}, exec } as any);
	const ctx: any = { cwd: dir, hasUI: false, mode: "print" };
	const call = (name: string, params: any) => tools.get(name).execute("call-1", params, undefined, undefined, ctx);

	intake(dir, { assignment: "Продолжить работу над шагами формы" });
	const task = readState(volnaDir).active!;
	writeStateSection(loadActive(dir)!.journalPath, {
		goal: "шаги",
		parts: "1. приём шага - в работе\n2. хранение - не начата",
		done: "части намечены",
		next: "первая часть",
	});

	check("инструмент доставки зарегистрирован", tools.has("volna_deliver"));

	let unasked = "";
	writeFileSync(join(volnaDir, "project.md"), "# Проект\n\n## Профиль\n\n- доставка: <нет | commit | commit+push>\n", "utf8");
	try {
		await call("volna_deliver", { action: "commit", message: "рано" });
	} catch (error: any) {
		unasked = String(error?.message ?? error);
	}
	check("незаполненный профиль не даёт коммитить", unasked.includes("не заполнена"), unasked.slice(0, 60));
	writeFileSync(join(volnaDir, "project.md"), "# Проект\n\n## Профиль\n\n- доставка: commit+push\n- ветка: <тип>/<задача>\n- удалённый: origin\n", "utf8");
	const branch = await call("volna_deliver", { action: "branch" });
	check("инструмент завёл ветку задачи", toolText(branch).includes(`feature/${task}`), toolText(branch));
	check("ветка записана в журнал", String(loadActive(dir)!.fm.branch) === `feature/${task}`, String(loadActive(dir)!.fm.branch));

	writeFileSync(join(dir, "app.js"), "export const step = 4;\n", "utf8");
	const status = await call("volna_deliver", { action: "status" });
	check("статус перечисляет незакоммиченное", toolText(status).includes("M app.js"), toolText(status));
	check("статус называет часть", toolText(status).includes("часть 1: приём шага"), toolText(status));

	let refusal = "";
	try {
		await call("volna_deliver", { action: "commit" });
	} catch (error: any) {
		refusal = String(error?.message ?? error);
	}
	check("коммит без сообщения не делается", refusal.includes("сообщение коммита"), refusal.slice(0, 60));

	const committed = await call("volna_deliver", { action: "commit", message: "часть 1: приём шага" });
	check("инструмент закоммитил", toolText(committed).includes("Коммит"), toolText(committed));
	check("коммит попал в журнал", loadActive(dir)!.logText.includes("часть 1: приём шага"));

	let pushRefusal = "";
	try {
		await call("volna_deliver", { action: "push" });
	} catch (error: any) {
		pushRefusal = String(error?.message ?? error);
	}
	check("push без согласия человека не делается", pushRefusal.includes("согласия"), pushRefusal.slice(0, 60));

	const pushed = await call("volna_deliver", { action: "push", confirmed: true });
	check("с согласия ветка уходит", toolText(pushed).includes("отправлена"), toolText(pushed));

	writeFileSync(join(dir, "app.js"), "export const step = 5;\n", "utf8");
	const closed = await call("volna_finish", { summary: "шаги приняты", hours: "2", part: true });
	check("закрытие предупреждает о недоставленном", toolText(closed).includes("работа не доставлена"), toolText(closed).slice(-120));
}
