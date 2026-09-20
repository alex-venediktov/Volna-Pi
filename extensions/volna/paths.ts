/**
 * Где лежит рабочий каталог «Волны» и её файлы. Без зависимостей: этим модулем пользуются
 * и расширение, и вспомогательные скрипты.
 *
 * Подъём за .volna останавливается на корне репозитория (каталог с .git): «Волна» работает
 * только там, где её развернули, а .volna соседнего проекта выше по дереву - чужая настройка.
 * Вне репозитория такой границы нет, поэтому подъём не заходит в домашний каталог пользователя и
 * выше: .volna, найденный там, принадлежит не этому проекту, а всему, что под ним лежит.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VOLNA_DIR_NAME = ".volna";

/**
 * Каталог .volna вверх от startDir либо null. `stopAbove` - каталог, в который подъём уже не
 * заходит; по умолчанию домашний каталог пользователя, и параметр он только ради тестов.
 */
export function findVolnaDir(startDir: string, stopAbove: string = homedir()): string | null {
	let dir = resolve(startDir);
	for (let i = 0; i < 12; i++) {
		const candidate = join(dir, VOLNA_DIR_NAME);
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(dir, ".git"))) return null;
		const parent = dirname(dir);
		if (parent === dir || isNotAProject(parent, stopAbove)) break;
		dir = parent;
	}
	return null;
}

/**
 * Корень диска, граничный каталог или что-то выше него. Проектом такой каталог не бывает, а .volna,
 * развёрнутая когда-то не там, молча стала бы настройкой для всего, что под ним лежит.
 */
function isNotAProject(dir: string, stopAbove: string): boolean {
	if (dirname(dir) === dir) return true;
	const boundary = norm(stopAbove);
	const candidate = norm(dir);
	return candidate === boundary || boundary.startsWith(`${candidate}/`);
}

/** Корень рабочего дерева: каталог, в котором лежит .volna. */
export function workspaceRoot(volnaDir: string): string {
	return dirname(volnaDir);
}

/** Пути внутри .volna. Одно место на весь пакет: раскладка меняется здесь и только здесь. */
export function volnaPaths(volnaDir: string) {
	return {
		root: volnaDir,
		state: join(volnaDir, "state.json"),
		project: join(volnaDir, "project.md"),
		journalDir: join(volnaDir, "journal"),
		logsDir: join(volnaDir, "journal", "logs"),
		visualDir: join(volnaDir, "visual"),
		wikiDir: join(volnaDir, "wiki"),
		journal: (task: string) => join(volnaDir, "journal", `TASK-${task}.md`),
		log: (task: string) => join(volnaDir, "journal", "logs", `TASK-${task}.log.md`),
	};
}

/**
 * Куда класть дифф, который читает адвокат: внутрь `.volna`, а не в системный temp.
 *
 * Temp не годится по двум причинам сразу, и обе видны только на живом прогоне. Каталог лежит вне
 * рабочего дерева подпроцесса, а путь к нему на Windows проходит через домашний каталог, и тот
 * бывает кириллическим (`C:\Users\Алексей\...`). Модель такой путь не воспроизвела, `wc` на
 * выдуманном пути упал, и запасной ветвью пошёл `find /` по всему диску - прогон встал молча, без
 * нагрузки на процессор, до таймаута адвоката.
 *
 * Внутри проекта путь короткий, относительный и читается любым инструментом. Каталог одноразовый:
 * уборка на закрытии задачи сносит его целиком, а `.gitignore` держит его вне коммитов.
 */
export function advocateDiffDir(volnaDir: string, task: string): string {
	return join(volnaDir, "advocate", task.replace(/[^\p{L}\p{N}._-]+/gu, "_"));
}

/** Корень пакета: отсюда читаются инструкции этапов, промпт адвоката и шаблоны. */
export function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Лежит ли путь внутри каталога. Разделители и регистр на Windows значения не имеют. */
export function isInside(child: string, parent: string): boolean {
	const c = norm(child);
	const p = norm(parent);
	return c === p || c.startsWith(`${p}/`);
}

/** Путь к сравнимому виду: абсолютный, с прямыми слэшами, без хвостового слэша, в нижнем регистре. */
function norm(path: string): string {
	return resolve(path).split("\\").join("/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Лог итераций ли это - свой или чужой. Признак берётся из раскладки, а не из имени задачи:
 * `.volna/journal/logs/<что угодно>.log.md`. Чужой лог опаснее своего: в нём история задачи, к
 * которой сессия отношения не имеет, и брошенная там гипотеза читается как факт о проекте.
 */
export function isJournalLog(path: string): boolean {
	const p = String(path ?? "").split("\\").join("/").toLowerCase();
	return /(^|\/)\.volna\/journal\/logs\/[^/]+\.log\.md$/.test(p);
}

/** Команды оболочки, которые выдают файл целиком. `grep`, `rg` и адресная выборка сюда не входят. */
const WHOLE_FILE_READERS = ["cat", "head", "tail", "more", "less", "type", "get-content", "bat", "nl"];

/**
 * Читает ли команда оболочки лог итераций целиком. Возвращает найденный путь - он идёт в объяснение,
 * иначе отказ выглядит как каприз.
 *
 * Разбор грубый и намеренно такой: полноценный парсер оболочки здесь не нужен, а цена ошибки
 * несимметрична. Пропущенный обход стоит засорённого контекста, лишний отказ - одной попытки:
 * рядом сказано, чем читать вместо этого.
 */
export function logReadInCommand(command: string): string | undefined {
	const text = String(command ?? "");
	// Команда разбирается на слова, а не выражением: путь и читатель могут стоять в любом порядке и
	// через конвейер, а выражение на такой разбор получается хрупким.
	const tokens = text.split(/[\s"'|;&<>()]+/).filter((token) => token !== "");
	// Читатель должен стоять именно перед путём, а не где-то в той же строке: `grep ... лог | tail -1`
	// читает лог адресно, и хвост тут относится к выводу grep, а не к файлу.
	for (let i = 0; i < tokens.length; i++) {
		if (!WHOLE_FILE_READERS.includes(basename(tokens[i]).toLowerCase())) continue;
		for (let j = i + 1; j < tokens.length; j++) {
			// Ключи и их числовые значения пропускаем: `head -n 50 лог` - то же чтение целиком.
			if (tokens[j].startsWith("-") || /^\d+$/.test(tokens[j])) continue;
			if (isJournalLog(tokens[j])) return tokens[j];
			break;
		}
	}
	return undefined;
}
