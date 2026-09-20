/** Развёртывание: где «Волна» ищет свой каталог и что она заводит вне git. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blanketIgnoreRule, initVolna, repoRootFor } from "../extensions/volna/init.ts";
import { findVolnaDir, isJournalLog, logReadInCommand } from "../extensions/volna/paths.ts";
import { check, exec, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	await withoutGit();
	await searchBoundary();
	journalLogRecognised();
}

/** Вне git: .volna заводится, .gitignore - нет, и человеку сказано, чего в проекте не будет. */
async function withoutGit(): Promise<void> {
	const dir = sandbox("deploy-nogit", { git: false });
	writeFileSync(join(dir, "app.js"), "let x = 1;\n", "utf8");

	const result = initVolna(dir);
	check("вне git «Волна» всё равно разворачивается", existsSync(join(dir, ".volna", "project.md")));
	check("правила для отсутствующего git не заводятся", !existsSync(join(dir, ".gitignore")));
	check("сказано, что адвоката и доставки не будет", result.warnings.join(" ").includes("advocate"), result.warnings.join(" ").slice(0, 80));
	check("предупреждение видно и в сообщении человеку", result.message.includes("git-репозитория здесь нет"));

	const inGit = sandbox("deploy-git", { git: false });
	await exec("git", ["init", "-q", inGit]);
	const ok = initVolna(inGit);
	check("в git правила .gitignore дописываются", existsSync(join(inGit, ".gitignore")));
	check("в git предупреждать не о чем", ok.warnings.length === 0, ok.warnings.join("; "));

	await blanketIgnore();
}

/**
 * Правило «.volna/» прячет профиль проекта и вику выводов: git внутрь исключённого каталога не
 * заходит, поэтому точечные правила под ним мертвы. Init говорит об этом и своих не дописывает.
 */
async function blanketIgnore(): Promise<void> {
	const dir = sandbox("deploy-blanket", { git: false });
	await exec("git", ["init", "-q", dir]);
	writeFileSync(join(dir, ".gitignore"), "node_modules/\n.volna/\n", "utf8");

	const result = initVolna(dir);
	check("сплошное правило .volna найдено", blanketIgnoreRule(join(dir, ".gitignore")) === ".volna/");
	check("сказано, что профиль и вика не коммитятся", result.warnings.join(" ").includes("вику выводов"), result.warnings.join(" ").slice(0, 90));
	check(
		"мёртвые точечные правила под сплошным не дописываются",
		!readFileSync(join(dir, ".gitignore"), "utf8").includes(".volna/journal/"),
	);

	const check_ignore = await exec("git", ["-C", dir, "check-ignore", "-q", ".volna/wiki/SCHEMA.md"]);
	check("вика под таким правилом и правда невидима для git", check_ignore.code === 0);

	const clean = sandbox("deploy-clean-ignore", { git: false });
	await exec("git", ["init", "-q", clean]);
	writeFileSync(join(clean, ".gitignore"), "node_modules/\n", "utf8");
	check("обычный .gitignore сплошным правилом не считается", blanketIgnoreRule(join(clean, ".gitignore")) === "");
	check("и предупреждения не вызывает", initVolna(clean).warnings.length === 0);
}

/** Поиск .volna вверх: своя настройка находится, чужая - нет. */
async function searchBoundary(): Promise<void> {
	const outer = sandbox("deploy-outer", { git: false });
	const nested = join(outer, "pkg", "src");
	mkdirSync(nested, { recursive: true });
	initVolna(outer);

	check("из подкаталога своего проекта .volna находится", findVolnaDir(nested) === join(outer, ".volna"));

	mkdirSync(join(outer, "pkg", ".git"), { recursive: true });
	check("чужой репозиторий по дороге останавливает поиск", findVolnaDir(nested) === null);

	// граница подъёма (по умолчанию домашний каталог): .volna за ней - настройка не этого проекта
	const open = sandbox("deploy-boundary", { git: false });
	const deep = join(open, "lib", "src");
	mkdirSync(deep, { recursive: true });
	initVolna(open);
	check("за границей чужая .volna не подхватывается", findVolnaDir(deep, join(open, "lib")) === null);
	check("своя .volna внутри границы находится", findVolnaDir(deep, dirname(open)) === join(open, ".volna"));
	check("домашний каталог - граница по умолчанию", findVolnaDir(deep) === join(open, ".volna"));

	const plain = sandbox("deploy-plain", { git: false });
	check("вне проекта и без .volna поиск ничего не выдумывает", findVolnaDir(plain) === null);
	check("корень для развёртывания вне git - сам каталог", repoRootFor(plain).toLowerCase() === plain.toLowerCase());
}

/**
 * Лог итераций опознаётся по раскладке, а не по имени задачи: гейт чтения обязан закрывать и чужой
 * лог тоже. Чтение целиком отличается от адресного поиска - на этом различии гейт и стоит.
 */
function journalLogRecognised(): void {
	check("свой лог опознан", isJournalLog(".volna/journal/logs/TASK-260920-a.log.md"));
	check("чужой лог опознан так же", isJournalLog("/other/project/.volna/journal/logs/TASK-250101-b.log.md"));
	const windows = ["D:", "p", ".volna", "journal", "logs", "TASK-x.log.md"].join(String.fromCharCode(92));
	check("обратные слэши не мешают", isJournalLog(windows), windows);
	check("файл состояния логом не считается", !isJournalLog(".volna/journal/TASK-260920-a.md"));
	check("посторонний лог не считается", !isJournalLog("logs/app.log.md"));
	check("каталог логов сам по себе не файл", !isJournalLog(".volna/journal/logs"));

	const log = ".volna/journal/logs/TASK-260920-a.log.md";
	// Лог дописывается инструментом и не читается ничем. Послабление для адресного поиска стояло
	// здесь раньше и себя не оправдало: сессия вытаскивала им десятки строк за раз и набирала ту же
	// историю чужих частей, просто порциями.
	check("cat по логу закрыт", logReadInCommand(`cat ${log}`) === log);
	check("tail закрыт", logReadInCommand(`tail -100 ${log}`) === log);
	check("grep по логу тоже закрыт", logReadInCommand(`grep -n "почему" ${log}`) === log);
	check("адресная выборка закрыта", logReadInCommand(`sed -n "1,80p" ${log}`) === log);
	check("чтение за конвейером закрыто", logReadInCommand(`grep -n x ${log} | head -5`) === log);
	check("путь в кавычках опознан", logReadInCommand(`cat "${log}"`) === log);
	check("простое упоминание пути тоже закрыто", logReadInCommand(`ls -l ${log}`) === log);
	// Единственное исключение: git кладёт журнал в коммит, а не читает его.
	check("git add по логу разрешён", logReadInCommand(`git add ${log}`) === undefined);
	check("git commit разрешён", logReadInCommand(`cd /x && git add ${log} && git commit -m x`) === undefined);
	check("чтение постороннего файла не задето", logReadInCommand("cat package.json") === undefined);
}
