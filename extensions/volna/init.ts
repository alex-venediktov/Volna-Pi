/**
 * Развернуть проектную часть «Волны» в текущем репозитории: .volna с профилем проекта,
 * каталоги журнала, правила .gitignore.
 *
 * Журналы и служебные файлы локальные и не коммитятся: они содержат ход работы одного человека
 * в одной сессии. Коммитится профиль проекта - он общий для команды.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { packageRoot, VOLNA_DIR_NAME, volnaPaths } from "./paths.ts";
import { stamp } from "./journal.ts";

const IGNORE_RULES = [".volna/state.json", ".volna/journal/", ".volna/visual/", ".volna/advocate/", ".volna/baseline/"];

export interface InitResult {
	created: string[];
	skipped: string[];
	volnaDir: string;
	message: string;
}

/** Корень репозитория вверх от cwd; git не найден - сам cwd, «Волна» работает и без него. */
export function repoRootFor(cwd: string): string {
	let dir = resolve(cwd);
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(cwd);
}

export function initVolna(cwd: string): InitResult {
	const root = repoRootFor(cwd);
	const volnaDir = join(root, VOLNA_DIR_NAME);
	const paths = volnaPaths(volnaDir);
	const created: string[] = [];
	const skipped: string[] = [];

	for (const dir of [volnaDir, paths.journalDir, paths.logsDir]) {
		if (existsSync(dir)) skipped.push(dir);
		else {
			mkdirSync(dir, { recursive: true });
			created.push(dir);
		}
	}

	if (existsSync(paths.project)) {
		skipped.push(paths.project);
	} else {
		const template = readFileSync(join(packageRoot(), "templates", "project.template.md"), "utf8");
		writeFileSync(paths.project, template, "utf8");
		created.push(paths.project);
	}

	if (existsSync(paths.state)) {
		skipped.push(paths.state);
	} else {
		writeFileSync(paths.state, `${JSON.stringify({ active: null, updated: stamp(), muted: false }, null, 2)}\n`, "utf8");
		created.push(paths.state);
	}

	const gitignore = join(root, ".gitignore");
	const missing = IGNORE_RULES.filter((rule) => !ignoreHasRule(gitignore, rule));
	if (missing.length) {
		const prefix = existsSync(gitignore) && !readFileSync(gitignore, "utf8").endsWith("\n") ? "\n" : "";
		appendFileSync(gitignore, `${prefix}\n# Волна: журналы и служебное локальны, профиль проекта коммитится\n${missing.join("\n")}\n`, "utf8");
		created.push(`${gitignore} (+${missing.length} правил)`);
	} else {
		skipped.push(gitignore);
	}

	const message = [
		`«Волна» развёрнута в ${root}.`,
		created.length ? `Создано: ${created.join(", ")}.` : "",
		skipped.length ? `Уже было: ${skipped.join(", ")}.` : "",
		"",
		`Следующий шаг - заполнить профиль проекта в ${paths.project}: строки со значениями в угловых скобках`,
		"не заполнены, и этап, которому такая строка нужна, остановится и спросит.",
		"Принять первое задание: /volna:task <текст задания или путь к md-файлу>.",
	]
		.filter(Boolean)
		.join("\n");

	return { created, skipped, volnaDir, message };
}

function ignoreHasRule(gitignore: string, rule: string): boolean {
	if (!existsSync(gitignore)) return false;
	try {
		return readFileSync(gitignore, "utf8")
			.split(/\r?\n/)
			.some((line) => line.trim() === rule);
	} catch {
		return false;
	}
}
