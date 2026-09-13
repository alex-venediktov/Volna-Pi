/**
 * Развернуть проектную часть «Волны» в текущем репозитории: .volna с профилем проекта,
 * каталоги журнала, вика выводов с соглашениями, правила .gitignore.
 *
 * Журналы и служебные файлы локальные и не коммитятся: они содержат ход работы одного человека
 * в одной сессии. Коммитится профиль проекта - он общий для команды.
 *
 * Разворачивать «Волну» вне git можно: журнал и этапы от него не зависят. Но правки она читает
 * только из git, поэтому этап advocate и доставка в таком проекте работать не будут - об этом
 * говорится сразу, а не на первом же вызове адвоката.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { packageRoot, VOLNA_DIR_NAME, volnaPaths } from "./paths.ts";
import { stamp } from "./journal.ts";
import { initWiki } from "./wiki-ops.ts";

export const IGNORE_RULES = [".volna/state.json", ".volna/journal/", ".volna/visual/"];

/**
 * Правила, прячущие весь .volna. Коммитятся профиль проекта и вика выводов, поэтому такое правило
 * означает, что знание команды не уедет ни одним коммитом: git не заходит внутрь исключённого
 * каталога, и отменить исключение изнутри нечем - точечные правила под ним мертвы.
 */
const BLANKET_RULES = new Set([".volna", ".volna/", "/.volna", "/.volna/", "**/.volna", "**/.volna/"]);

/** Строка .gitignore, прячущая .volna целиком, либо пустая строка. */
export function blanketIgnoreRule(gitignore: string): string {
	if (!existsSync(gitignore)) return "";
	try {
		return readFileSync(gitignore, "utf8").split(/\r?\n/).map((line) => line.trim()).find((line) => BLANKET_RULES.has(line)) ?? "";
	} catch {
		return "";
	}
}

/** Что сказать про правило, прячущее .volna: чего в проекте не будет и чем его заменить. */
export function blanketIgnoreWarning(rule: string): string {
	return (
		`в .gitignore есть правило «${rule}»: оно прячет весь .volna, включая профиль проекта и вику выводов - ` +
		"коммититься они не будут, и запись, сделанная этапом capture, не уедет тем же коммитом, что работа. " +
		"Внутрь исключённого каталога git не заходит, поэтому точечные правила под ним ничего не вернут: " +
		`замени строку на ${IGNORE_RULES.join(", ")}.`
	);
}

export interface InitResult {
	created: string[];
	skipped: string[];
	volnaDir: string;
	/** Чего в этом проекте не будет и почему: сейчас это отсутствие git. */
	warnings: string[];
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

	// Вика разворачивается вместе с проектной частью и в .gitignore не попадает: журнал - ход
	// работы одного человека, а вика - знание команды, и коммитится она тем же коммитом, что работа.
	const wiki = initWiki(paths.wikiDir);
	if (wiki.skipped) skipped.push(paths.wikiDir);
	else created.push(`${paths.wikiDir} (${wiki.created.join(", ")})`);

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

	// .gitignore заводится только там, где есть git: в проекте без него это правила для инструмента,
	// которого здесь нет, и первым же вопросом будет «кто это создал и зачем».
	const warnings: string[] = [];
	const inGit = existsSync(join(root, ".git"));
	const gitignore = join(root, ".gitignore");
	if (!inGit) {
		warnings.push(
			"git-репозитория здесь нет: правки «Волна» читает только из git, поэтому этап advocate и доставка " +
				"в этом проекте работать не будут. Журнал, этапы и остальной флоу - будут. Правила .gitignore не добавлены.",
		);
	} else if (blanketIgnoreRule(gitignore)) {
		// Дописывать точечные правила под сплошным бессмысленно: они не вернут ни профиль, ни вику,
		// а выглядели бы как сделанная работа. Правило человека «Волна» не переписывает сама.
		warnings.push(blanketIgnoreWarning(blanketIgnoreRule(gitignore)));
		skipped.push(gitignore);
	} else {
		const missing = IGNORE_RULES.filter((rule) => !ignoreHasRule(gitignore, rule));
		if (missing.length) {
			const prefix = existsSync(gitignore) && !readFileSync(gitignore, "utf8").endsWith("\n") ? "\n" : "";
			appendFileSync(gitignore, `${prefix}\n# Волна: журналы и служебное локальны, профиль проекта коммитится\n${missing.join("\n")}\n`, "utf8");
			created.push(`${gitignore} (+${missing.length} правил)`);
		} else {
			skipped.push(gitignore);
		}
	}

	const message = [
		`«Волна» развёрнута в ${root}.`,
		created.length ? `Создано: ${created.join(", ")}.` : "",
		skipped.length ? `Уже было: ${skipped.join(", ")}.` : "",
		warnings.length ? warnings.join(" ") : "",
		"",
		`Следующий шаг - заполнить профиль проекта в ${paths.project}: строки со значениями в угловых скобках`,
		"не заполнены, и этап, которому такая строка нужна, остановится и спросит.",
		"Принять первое задание: /volna:task <текст задания или ссылка на файл с постановкой>.",
	]
		.filter(Boolean)
		.join("\n");

	return { created, skipped, volnaDir, warnings, message };
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
