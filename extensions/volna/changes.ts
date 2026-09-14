/**
 * Что изменилось в рабочем дереве. Ответ нужен адвокату: он проверяет сделанные правки, а не весь
 * проект, и без списка изменений ему нечего проверять.
 *
 * Источник один - git. Другие системы контроля версий и снимок дерева, который «Волна» снимала
 * сама, отсюда убраны: снимок не знает правил игнорирования, поэтому тащил адвокату локальные
 * секреты, логи и кэши вместе с правками, а поддерживать второй, заведомо худший источник ради
 * проектов без git незачем. Нет git - адвокат честно отказывается, а не проверяет что попало.
 *
 * База сравнения приходит извне (`base`): обычно это коммит, на котором началась текущая часть
 * задачи. HEAD годится, только пока внутри части не сделано ни одного коммита.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileDiff } from "./diff.ts";
import { workspaceRoot } from "./paths.ts";

export interface ChangedFile {
	path: string;
	status: "изменён" | "добавлен" | "удалён";
}

export interface ChangeSet {
	/** Есть ли здесь git. Нет - files и diff пусты не потому, что правок нет. */
	repo: boolean;
	/** С чем сравнивали: коммит начала части, HEAD, «коммитов ещё нет». */
	base: string;
	files: ChangedFile[];
	diff: string;
	/** Что стоит знать про полноту ответа: git нет, база не найдена, файлы вне индекса. */
	notes: string[];
}

export interface ExecLike {
	(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<{
		stdout: string;
		stderr: string;
		code: number;
	}>;
}

export interface CollectOptions {
	volnaDir: string;
	/** База сравнения: коммит начала части из журнала. По умолчанию HEAD. */
	base?: string;
	signal?: AbortSignal;
}

const MAX_TEXT_BYTES = 256 * 1024;

const BINARY_EXTENSIONS = new Set([
	"exe", "dll", "pdb", "lib", "obj", "so", "dylib", "zip", "7z", "rar", "gz", "bz2", "xz", "tar",
	"png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt",
	"pptx", "mp3", "mp4", "avi", "mov", "wav", "ttf", "otf", "woff", "woff2", "class", "jar", "res",
	"dcu", "bpl", "dcp",
]);

/** Причина, по которой проверять нечего. Отдельным текстом: её показывают и адвокат, и доктор. */
export const NO_REPO_REASON = [
	"git-репозитория здесь нет, а других источников правок «Волна» не знает.",
	"Адвокат проверяет правки, а не проект целиком: сравнивать не с чем.",
].join(" ");

export async function collectChanges(exec: ExecLike, options: CollectOptions): Promise<ChangeSet> {
	const root = workspaceRoot(options.volnaDir);
	const inside = await exec("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { signal: options.signal });
	if (inside.code !== 0 || inside.stdout.trim() !== "true") {
		return { repo: false, base: "", files: [], diff: "", notes: [NO_REPO_REASON] };
	}

	const requested = (options.base ?? "").trim() || "HEAD";
	const notes: string[] = [];
	const resolved = await exec("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${requested}^{commit}`], {
		signal: options.signal,
	});
	// База не разрешается в коммит: свежий репозиторий без коммитов либо коммит, которого больше
	// нет (rebase, сброс ветки). Правки при этом есть - показываем их как новые файлы.
	const base = resolved.code === 0 ? requested : "";
	if (!base) {
		notes.push(
			requested === "HEAD"
				? "в репозитории ещё нет коммитов - всё дерево показано как новые файлы"
				: `база ${requested} в репозитории не найдена (сброшена или перебазирована) - показаны только файлы вне индекса`,
		);
	}

	const files: ChangedFile[] = [];
	let body = "";
	if (base) {
		const status = await exec("git", ["-C", root, "diff", "--name-status", base], { signal: options.signal });
		for (const line of status.stdout.split(/\r?\n/)) {
			const match = /^([A-Z])\d*\s+(.+)$/.exec(line.trim());
			if (!match) continue;
			files.push({ path: normalizePath(match[2]), status: gitStatus(match[1]) });
		}
		body = (await exec("git", ["-C", root, "diff", base], { signal: options.signal })).stdout;
	}

	const untracked = await exec("git", ["-C", root, "ls-files", "--others", "--exclude-standard"], { signal: options.signal });
	const newFiles = untracked.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith(".volna/"));
	for (const file of newFiles) {
		const name = normalizePath(file);
		files.push({ path: name, status: "добавлен" });
		const content = readTextFile(join(root, file));
		// Заголовок как у git: по нему дифф режется на файлы, когда адвокат идёт порциями, и файл
		// вне индекса не должен быть исключением из этого правила.
		body += `\n\ndiff --git a/${name} b/${name}\n${fileDiff({ path: name, before: null, after: content.text, note: content.note })}`;
	}
	if (newFiles.length) notes.push(`файлов вне индекса: ${newFiles.length} - они попали в дифф целиком`);

	return { repo: true, base: base || "коммитов нет", files, diff: body.trim(), notes };
}

function gitStatus(letter: string): ChangedFile["status"] {
	if (letter === "A") return "добавлен";
	if (letter === "D") return "удалён";
	return "изменён";
}

function readTextFile(absolute: string): { text: string | null; note?: string } {
	let size = 0;
	try {
		size = statSync(absolute).size;
	} catch {
		return { text: null, note: "файл недоступен" };
	}
	if (size > MAX_TEXT_BYTES) return { text: null, note: `файл ${Math.round(size / 1024)} КБ - в дифф не вставлен: ${absolute}` };
	if (looksBinary(absolute)) return { text: null, note: `бинарный файл, ${Math.round(size / 1024)} КБ: ${absolute}` };
	let buffer: Buffer;
	try {
		buffer = readFileSync(absolute);
	} catch {
		return { text: null, note: "файл недоступен" };
	}
	// расширение врёт чаще, чем содержимое: нулевой байт в начале файла - надёжный признак
	if (buffer.subarray(0, 8192).includes(0)) {
		return { text: null, note: `бинарный файл, ${Math.round(size / 1024)} КБ: ${absolute}` };
	}
	return { text: buffer.toString("utf8") };
}

function looksBinary(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BINARY_EXTENSIONS.has(ext);
}

function normalizePath(path: string): string {
	return path.replace(/^"|"$/g, "").split("\\").join("/");
}
