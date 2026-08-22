/**
 * Состояние «Волны» на диске: указатель активной задачи, frontmatter журнала, профиль проекта.
 * Читается на каждом ходе (шапка, гейты), поэтому здесь только файловые операции без сети.
 *
 * Любая ошибка чтения трактуется как «настройки нет»: расширение не имеет права ломать работу
 * из-за битого файла. Исключение - неизвестные ключи state.json: о них говорим, потому что
 * именно из-за них сопровождение молча выключается.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { asList, asText, type Frontmatter, splitFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { findVolnaDir, volnaPaths, workspaceRoot } from "./paths.ts";

export const STATE_KEYS = ["active", "updated", "muted"];

export interface VolnaState {
	active: string | null;
	updated: string | null;
	muted: boolean;
	unknown: string[];
}

export interface ActiveTask {
	volnaDir: string;
	task: string;
	fm: Frontmatter;
	/** Текст файла состояния целиком: frontmatter плюс секция «Состояние». */
	text: string;
	/** Секция «## Состояние …» без заголовка либо null. */
	stateSection: string | null;
	logText: string;
	journalPath: string;
	logPath: string;
	mtimeMs: number | null;
}

export function readState(volnaDir: string): VolnaState {
	const empty: VolnaState = { active: null, updated: null, muted: false, unknown: [] };
	try {
		const raw = readFileSync(volnaPaths(volnaDir).state, "utf8");
		const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
		return {
			active: parsed.active ? String(parsed.active) : null,
			updated: parsed.updated ? String(parsed.updated) : null,
			muted: parsed.muted === true,
			unknown: Object.keys(parsed).filter((key) => !STATE_KEYS.includes(key)),
		};
	} catch {
		return empty;
	}
}

export function writeState(volnaDir: string, patch: Partial<Omit<VolnaState, "unknown">>): void {
	const current = readState(volnaDir);
	const next = {
		active: patch.active !== undefined ? patch.active : current.active,
		updated: patch.updated !== undefined ? patch.updated : current.updated,
		muted: patch.muted !== undefined ? patch.muted : current.muted,
	};
	mkdirSync(volnaDir, { recursive: true });
	writeFileSync(volnaPaths(volnaDir).state, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/** Активная задача целиком: frontmatter, «Состояние», лог. Нет задачи или журнала - null. */
export function loadActive(cwd: string): ActiveTask | null {
	const volnaDir = findVolnaDir(cwd);
	if (!volnaDir) return null;
	const { active } = readState(volnaDir);
	if (!active) return null;
	return loadTask(volnaDir, active);
}

export function loadTask(volnaDir: string, task: string): ActiveTask | null {
	const paths = volnaPaths(volnaDir);
	const journalPath = paths.journal(task);
	let text = "";
	try {
		text = readFileSync(journalPath, "utf8");
	} catch {
		return null;
	}
	const { fm, body } = splitFrontmatter(text);
	let logText = "";
	try {
		logText = readFileSync(paths.log(task), "utf8");
	} catch {
		logText = "";
	}
	let mtimeMs: number | null = null;
	try {
		mtimeMs = Math.max(statSync(journalPath).mtimeMs, existsSync(paths.log(task)) ? statSync(paths.log(task)).mtimeMs : 0);
	} catch {
		mtimeMs = null;
	}
	return {
		volnaDir,
		task,
		fm,
		text,
		stateSection: extractStateSection(body),
		logText,
		journalPath,
		logPath: paths.log(task),
		mtimeMs,
	};
}

/** Перезаписать frontmatter файла состояния, не тронув секцию «Состояние». */
export function updateFrontmatter(journalPath: string, patch: Frontmatter): Frontmatter {
	const text = readFileSync(journalPath, "utf8");
	const { fm, body } = splitFrontmatter(text);
	const merged: Frontmatter = { ...fm, ...patch };
	writeFileSync(journalPath, stringifyFrontmatter(merged, body), "utf8");
	return merged;
}

/** Секция «## Состояние …» из тела файла: то, чем восстанавливается контекст. */
export function extractStateSection(body: string): string | null {
	const match = /^##\s+Состояние[^\n]*\n([\s\S]*)$/m.exec(body);
	if (!match) return null;
	const rest = match[1];
	const next = rest.search(/^##\s/m);
	return (next < 0 ? rest : rest.slice(0, next)).trim();
}

/**
 * Профиль проекта из секции «## Профиль» файла project.md: строки «- ключ: значение».
 * Секции нет - пустой объект, и это значит «как было»: чего проект не назвал, потребитель
 * трактует по умолчанию.
 */
export function readProfile(volnaDir: string): Record<string, string> {
	let text = "";
	try {
		text = readFileSync(volnaPaths(volnaDir).project, "utf8");
	} catch {
		return {};
	}
	const match = /^##[ \t]+Профиль[ \t]*$/m.exec(text);
	if (!match) return {};
	const rest = text.slice(match.index + match[0].length);
	const next = rest.search(/^##[ \t]/m);
	const block = next < 0 ? rest : rest.slice(0, next);
	const out: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const kv = /^\s*[-*]\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
		if (!kv) continue;
		const value = kv[2].replace(/\s+#.*$/, "").trim();
		if (value) out[kv[1].trim().toLowerCase()] = value;
	}
	return out;
}

/** Значение профиля не заполнено: в файле остался плейсхолдер шаблона «<chrome-devtools|нет>». */
export function isPlaceholder(value: string | undefined): boolean {
	return /^<.*>$/.test(String(value ?? "").trim());
}

/** Строка профиля со снятым плейсхолдером: незаполненное значение равно отсутствию строки. */
export function profileValue(profile: Record<string, string>, key: string): string {
	const value = profile[key];
	return value && !isPlaceholder(value) ? value : "";
}

export function taskField(fm: Frontmatter, key: string): string {
	return asText(fm[key]).trim();
}

export function taskList(fm: Frontmatter, key: string): string[] {
	return asList(fm[key]).filter((item) => item.trim() !== "");
}

/** Путь для показа человеку: относительно корня рабочего дерева, с прямыми слэшами. */
export function displayPath(volnaDir: string, path: string): string {
	return relative(workspaceRoot(volnaDir), path).split("\\").join("/");
}

/** Сколько минут назад журнал трогали последний раз. Нет данных - null. */
export function minutesSince(mtimeMs: number | null): number | null {
	if (!mtimeMs) return null;
	return Math.max(0, Math.round((Date.now() - mtimeMs) / 60000));
}
