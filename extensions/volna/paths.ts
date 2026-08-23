/**
 * Где лежит рабочий каталог «Волны» и её файлы. Без зависимостей: этим модулем пользуются
 * и расширение, и вспомогательные скрипты.
 *
 * Подъём за .volna останавливается на корне репозитория (каталог с .git): «Волна» работает
 * только там, где её развернули, а .volna соседнего проекта выше по дереву - чужая настройка.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VOLNA_DIR_NAME = ".volna";

/** Каталог .volna вверх от startDir либо null. */
export function findVolnaDir(startDir: string): string | null {
	let dir = resolve(startDir);
	for (let i = 0; i < 12; i++) {
		const candidate = join(dir, VOLNA_DIR_NAME);
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(dir, ".git"))) return null;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
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
 * Куда класть дифф, который читает адвокат: системный temp, а не .volna. Файл нужен ровно на один
 * прогон - дифф не идёт через промпт, - и в проекте ему делать нечего.
 *
 * Хвост из хэша пути разводит одноимённые задачи разных проектов: уборка на закрытии сносит
 * каталог целиком и чужие диффы задеть не должна.
 */
export function advocateDiffDir(volnaDir: string, task: string): string {
	const key = createHash("sha1").update(resolve(volnaDir).split("\\").join("/").toLowerCase()).digest("hex").slice(0, 8);
	return join(tmpdir(), "volna-advocate", `${task.replace(/[^\p{L}\p{N}._-]+/gu, "_")}-${key}`);
}

/** Корень пакета: отсюда читаются инструкции этапов, промпт адвоката и шаблоны. */
export function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Лежит ли путь внутри каталога. Разделители и регистр на Windows значения не имеют. */
export function isInside(child: string, parent: string): boolean {
	const norm = (p: string) => resolve(p).split("\\").join("/").replace(/\/+$/, "").toLowerCase();
	const c = norm(child);
	const p = norm(parent);
	return c === p || c.startsWith(`${p}/`);
}
