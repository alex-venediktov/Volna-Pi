/**
 * Что изменилось в рабочем дереве. Ответ нужен адвокату: он проверяет сделанные правки, а не весь
 * проект, и без списка изменений ему нечего проверять.
 *
 * Источник выбирается сам, по тому, что есть в проекте:
 *
 * | Признак | Источник |
 * |---|---|
 * | строка профиля «изменения: <команда>» | своя команда проекта - для TFVC, Perforce и всего прочего |
 * | каталог .git | git diff против базы |
 * | каталог .svn | svn status и svn diff |
 * | каталог .hg | hg status и hg diff |
 * | ничего из этого | снимок дерева, который «Волна» сняла сама |
 *
 * Снимок - последний рубеж, а не костыль: он работает там, где системы контроля версий нет вовсе
 * или где её клиент недоступен из этой оболочки, и даёт тот же ответ - список файлов и дифф.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { fileDiff } from "./diff.ts";
import { volnaPaths, workspaceRoot } from "./paths.ts";

export type ChangeSourceKind = "git" | "svn" | "hg" | "команда проекта" | "снимок «Волны»";

export interface ChangedFile {
	path: string;
	status: "изменён" | "добавлен" | "удалён";
}

export interface ChangeSet {
	kind: ChangeSourceKind;
	/** Что считается базой: HEAD, рабочая ревизия, снимок от такого-то времени. */
	base: string;
	files: ChangedFile[];
	diff: string;
	/** Что стоит знать про полноту ответа: клиента нет, снимка нет, дифф не строился. */
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
	profile: Record<string, string>;
	/** База сравнения для git: по умолчанию HEAD. Другие источники сравнивают с рабочей ревизией. */
	base?: string;
	signal?: AbortSignal;
}

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_SNAPSHOT_FILES = 20000;

/** Каталоги и файлы, которых в проверке правок не бывает. Дополняется строкой профиля «не смотреть». */
const DEFAULT_IGNORES = [
	".git",
	".svn",
	".hg",
	".volna",
	"node_modules",
	"dist",
	"build",
	"out",
	"bin",
	"obj",
	"target",
	"vendor",
	".vs",
	".vscode",
	".idea",
	"__pycache__",
	"venv",
	".venv",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	".gradle",
];

const BINARY_EXTENSIONS = new Set([
	"exe", "dll", "pdb", "lib", "obj", "so", "dylib", "zip", "7z", "rar", "gz", "bz2", "xz", "tar",
	"png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt",
	"pptx", "mp3", "mp4", "avi", "mov", "wav", "ttf", "otf", "woff", "woff2", "class", "jar", "res",
	"dcu", "bpl", "dcp",
]);

export async function collectChanges(exec: ExecLike, options: CollectOptions): Promise<ChangeSet> {
	const root = workspaceRoot(options.volnaDir);
	const custom = (options.profile["изменения"] ?? "").trim();
	if (custom && !/^<.*>$/.test(custom)) {
		return await fromCommand(exec, root, custom, (options.profile["дифф"] ?? "").trim(), options.signal);
	}
	if (existsSync(join(root, ".git"))) {
		const result = await fromGit(exec, root, options.base ?? "HEAD", options.signal);
		if (result) return result;
	}
	if (existsSync(join(root, ".svn"))) {
		const result = await fromSvn(exec, root, options.signal);
		if (result) return result;
	}
	if (existsSync(join(root, ".hg"))) {
		const result = await fromHg(exec, root, options.signal);
		if (result) return result;
	}
	return fromSnapshot(options.volnaDir, options.profile);
}

/** Есть ли в проекте система контроля версий, из которой видно правки. Решает, нужен ли снимок. */
export function needsSnapshot(volnaDir: string, profile: Record<string, string>): boolean {
	const custom = (profile["изменения"] ?? "").trim();
	if (custom && !/^<.*>$/.test(custom)) return false;
	const root = workspaceRoot(volnaDir);
	return !existsSync(join(root, ".git")) && !existsSync(join(root, ".svn")) && !existsSync(join(root, ".hg"));
}

// ─── git ────────────────────────────────────────────────────────────────────────────────────────

async function fromGit(exec: ExecLike, root: string, base: string, signal?: AbortSignal): Promise<ChangeSet | null> {
	const status = await exec("git", ["-C", root, "diff", "--name-status", base], { signal });
	if (status.code !== 0) return null;

	const files: ChangedFile[] = [];
	for (const line of status.stdout.split(/\r?\n/)) {
		const match = /^([A-Z])\d*\s+(.+)$/.exec(line.trim());
		if (!match) continue;
		files.push({ path: normalizePath(match[2]), status: gitStatus(match[1]) });
	}

	const diff = await exec("git", ["-C", root, "diff", base], { signal });
	const untracked = await exec("git", ["-C", root, "ls-files", "--others", "--exclude-standard"], { signal });
	const newFiles = untracked.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith(".volna/"));

	let body = diff.stdout;
	const notes: string[] = [];
	for (const file of newFiles) {
		files.push({ path: normalizePath(file), status: "добавлен" });
		const content = readTextFile(join(root, file));
		body += `\n\n${fileDiff({ path: normalizePath(file), before: null, after: content.text, note: content.note })}`;
	}
	if (newFiles.length) notes.push(`файлов вне индекса: ${newFiles.length} - они попали в дифф целиком`);

	return { kind: "git", base, files, diff: body.trim(), notes };
}

function gitStatus(letter: string): ChangedFile["status"] {
	if (letter === "A") return "добавлен";
	if (letter === "D") return "удалён";
	return "изменён";
}

// ─── svn и hg ───────────────────────────────────────────────────────────────────────────────────

/**
 * Разбор `svn status` и `hg status`: первая колонка - буква состояния, дальше путь. Формат у обоих
 * стабильный десятилетиями, но проверить его на этой машине нечем - клиента нет, и об этом
 * говорится в примечании честно, а не молча.
 */
async function fromSvn(exec: ExecLike, root: string, signal?: AbortSignal): Promise<ChangeSet | null> {
	const status = await exec("svn", ["status", "--non-interactive"], { cwd: root, signal });
	if (status.code !== 0) return null;
	const files = parseStatusLetters(status.stdout, { M: "изменён", A: "добавлен", D: "удалён", "?": "добавлен" });
	const diff = await exec("svn", ["diff", "--non-interactive"], { cwd: root, signal });
	return {
		kind: "svn",
		base: "рабочая ревизия",
		files,
		diff: diff.stdout.trim(),
		notes: ["дифф получен через svn diff: файлы вне версионирования (статус ?) в него не попадают"],
	};
}

async function fromHg(exec: ExecLike, root: string, signal?: AbortSignal): Promise<ChangeSet | null> {
	const status = await exec("hg", ["status"], { cwd: root, signal });
	if (status.code !== 0) return null;
	const files = parseStatusLetters(status.stdout, { M: "изменён", A: "добавлен", R: "удалён", "?": "добавлен" });
	const diff = await exec("hg", ["diff"], { cwd: root, signal });
	return {
		kind: "hg",
		base: "рабочая ревизия",
		files,
		diff: diff.stdout.trim(),
		notes: ["дифф получен через hg diff: файлы вне версионирования (статус ?) в него не попадают"],
	};
}

function parseStatusLetters(output: string, map: Record<string, ChangedFile["status"]>): ChangedFile[] {
	const files: ChangedFile[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const letter = line[0];
		const status = map[letter];
		if (!status) continue;
		const path = line.slice(1).trim().replace(/^[\s+MADRCIX?!~]*/, "").trim();
		if (path) files.push({ path: normalizePath(path), status });
	}
	return files;
}

// ─── своя команда проекта ───────────────────────────────────────────────────────────────────────

/**
 * Команда проекта, печатающая изменённые файлы по одному в строке: путь либо «статус путь».
 * Через неё подключается всё, чего «Волна» не знает - TFVC (`tf vc status`), Perforce (`p4 opened`),
 * самописные скрипты. Дифф - вторая команда, если проект её дал.
 */
async function fromCommand(
	exec: ExecLike,
	root: string,
	filesCommand: string,
	diffCommand: string,
	signal?: AbortSignal,
): Promise<ChangeSet> {
	const notes: string[] = [`список файлов получен командой проекта: ${filesCommand}`];
	const listed = await runShell(exec, filesCommand, root, signal);
	if (listed.code !== 0) {
		notes.push(`команда вернула код ${listed.code}: ${listed.stderr.trim().slice(-300) || "без сообщения"}`);
	}

	const files: ChangedFile[] = [];
	for (const line of listed.stdout.split(/\r?\n/)) {
		const clean = line.trim();
		if (!clean) continue;
		const match = /^([A-Za-zА-Яа-я?!]+)\s+(.+)$/.exec(clean);
		const raw = match ? match[2] : clean;
		const letter = match ? match[1].toUpperCase() : "";
		const status: ChangedFile["status"] =
			letter.startsWith("A") || letter === "?" ? "добавлен" : letter.startsWith("D") || letter.startsWith("R") ? "удалён" : "изменён";
		files.push({ path: normalizePath(raw), status });
	}

	let diff = "";
	if (diffCommand && !/^<.*>$/.test(diffCommand)) {
		const result = await runShell(exec, diffCommand, root, signal);
		diff = result.stdout.trim();
		notes.push(`дифф получен командой проекта: ${diffCommand}`);
	} else {
		diff = filesAsDiff(root, files);
		notes.push("команды диффа в профиле нет - изменённые файлы вложены целиком, читай их как содержимое, а не как правки");
	}

	return { kind: "команда проекта", base: "как решает команда проекта", files, diff, notes };
}

/** Запуск строки как есть, через оболочку: команда пришла из профиля и может быть с флагами и пайпами. */
function runShell(exec: ExecLike, command: string, cwd: string, signal?: AbortSignal) {
	return process.platform === "win32"
		? exec("cmd", ["/c", command], { cwd, signal, timeout: 60000 })
		: exec("sh", ["-c", command], { cwd, signal, timeout: 60000 });
}

/** Когда диффа нет, но список файлов есть: отдаём содержимое, честно называя это не диффом. */
function filesAsDiff(root: string, files: ChangedFile[]): string {
	const parts: string[] = [];
	for (const file of files.slice(0, 100)) {
		if (file.status === "удалён") {
			parts.push(`=== удалён: ${file.path} ===`);
			continue;
		}
		const content = readTextFile(join(root, file.path));
		parts.push(`=== ${file.status}: ${file.path} ===\n${content.note ?? content.text ?? ""}`);
	}
	if (files.length > 100) parts.push(`… и ещё ${files.length - 100} файлов`);
	return parts.join("\n\n");
}

// ─── снимок дерева ──────────────────────────────────────────────────────────────────────────────

interface SnapshotIndex {
	takenAt: string;
	files: Record<string, { size: number; hash: string; copied: boolean }>;
}

/**
 * Снять снимок рабочего дерева: хэши всех интересных файлов и копии текстовых. Делается перед
 * первой итерацией реализации - иначе сравнивать будет не с чем, а понять задним числом, что было
 * до правок, невозможно.
 */
export function takeSnapshot(volnaDir: string, task: string, profile: Record<string, string>): { files: number; skipped: number } {
	const root = workspaceRoot(volnaDir);
	const dir = snapshotDir(volnaDir, task);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, "files"), { recursive: true });

	const index: SnapshotIndex = { takenAt: new Date().toISOString(), files: {} };
	let skipped = 0;
	for (const path of walkTree(root, profile)) {
		const absolute = join(root, path);
		let size = 0;
		try {
			size = statSync(absolute).size;
		} catch {
			continue;
		}
		const text = size <= MAX_TEXT_BYTES ? readTextFile(absolute).text : null;
		if (text === null) {
			index.files[path] = { size, hash: `размер:${size}`, copied: false };
			skipped++;
			continue;
		}
		index.files[path] = { size, hash: hashText(text), copied: true };
		writeFileSync(join(dir, "files", copyName(path)), text, "utf8");
	}
	writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 1)}\n`, "utf8");
	return { files: Object.keys(index.files).length, skipped };
}

/** Убрать снимок задачи: после закрытия сравнивать с ним нечего, а весит он как всё дерево. */
export function dropSnapshot(volnaDir: string, task: string): boolean {
	const dir = snapshotDir(volnaDir, task);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}

export function snapshotExists(volnaDir: string, task: string): boolean {
	return existsSync(join(snapshotDir(volnaDir, task), "index.json"));
}

export function snapshotTakenAt(volnaDir: string, task: string): string | null {
	try {
		const index = JSON.parse(readFileSync(join(snapshotDir(volnaDir, task), "index.json"), "utf8")) as SnapshotIndex;
		return index.takenAt;
	} catch {
		return null;
	}
}

/** Сравнить дерево со снимком активной задачи. Снимка нет - об этом говорится, а не выдумывается. */
export function compareWithSnapshot(volnaDir: string, task: string, profile: Record<string, string>): ChangeSet {
	const root = workspaceRoot(volnaDir);
	const dir = snapshotDir(volnaDir, task);
	const notes: string[] = [];
	let index: SnapshotIndex | null = null;
	try {
		index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as SnapshotIndex;
	} catch {
		index = null;
	}
	if (!index) {
		return {
			kind: "снимок «Волны»",
			base: "снимка нет",
			files: [],
			diff: "",
			notes: [
				"системы контроля версий в проекте нет, а снимок дерева не снят - сравнивать не с чем.",
				"Снимок снимается сам при входе в implement; снять вручную - /volna:baseline.",
			],
		};
	}

	const current = new Map<string, { size: number; text: string | null }>();
	for (const path of walkTree(root, profile)) {
		const absolute = join(root, path);
		let size = 0;
		try {
			size = statSync(absolute).size;
		} catch {
			continue;
		}
		const text = size <= MAX_TEXT_BYTES ? readTextFile(absolute).text : null;
		current.set(path, { size, text });
	}

	const files: ChangedFile[] = [];
	const diffs: string[] = [];
	for (const [path, now] of current) {
		const before = index.files[path];
		if (!before) {
			files.push({ path, status: "добавлен" });
			diffs.push(fileDiff({ path, before: null, after: now.text, note: now.text === null ? "новый бинарный или слишком большой файл" : undefined }));
			continue;
		}
		const nowHash = now.text === null ? `размер:${now.size}` : hashText(now.text);
		if (nowHash === before.hash) continue;
		files.push({ path, status: "изменён" });
		const beforeText = before.copied ? safeRead(join(dir, "files", copyName(path))) : null;
		diffs.push(
			fileDiff({
				path,
				before: beforeText,
				after: now.text,
				note:
					beforeText === null || now.text === null
						? `файл изменён (${before.size} → ${now.size} байт), построчное сравнение недоступно: копии в снимке нет либо файл не текстовый`
						: undefined,
			}),
		);
	}
	for (const path of Object.keys(index.files)) {
		if (current.has(path)) continue;
		files.push({ path, status: "удалён" });
		const beforeText = index.files[path].copied ? safeRead(join(dir, "files", copyName(path))) : null;
		diffs.push(fileDiff({ path, before: beforeText, after: null, note: beforeText === null ? "файл удалён, копии в снимке нет" : undefined }));
	}

	notes.push(`сравнение со снимком «Волны» от ${index.takenAt.slice(0, 16).replace("T", " ")}`);
	notes.push("это не история версий: переименования видны как удаление и добавление");
	return {
		kind: "снимок «Волны»",
		base: `снимок от ${index.takenAt.slice(0, 16).replace("T", " ")}`,
		files,
		diff: diffs.filter(Boolean).join("\n\n"),
		notes,
	};
}

function fromSnapshot(volnaDir: string, profile: Record<string, string>): ChangeSet {
	const task = activeTaskName(volnaDir);
	if (!task) {
		return {
			kind: "снимок «Волны»",
			base: "снимка нет",
			files: [],
			diff: "",
			notes: ["активной задачи нет, а снимок дерева привязан к задаче"],
		};
	}
	return compareWithSnapshot(volnaDir, task, profile);
}

/** Имя активной задачи прямо из указателя: модуль состояния сюда тянуть незачем. */
function activeTaskName(volnaDir: string): string | null {
	try {
		const state = JSON.parse(readFileSync(volnaPaths(volnaDir).state, "utf8"));
		return state.active ? String(state.active) : null;
	} catch {
		return null;
	}
}

function snapshotDir(volnaDir: string, task: string): string {
	return join(volnaDir, "baseline", task);
}

function copyName(path: string): string {
	return `${createHash("sha1").update(path).digest("hex")}.txt`;
}

function hashText(text: string): string {
	return createHash("sha1").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function safeRead(absolute: string): string | null {
	try {
		return readFileSync(absolute, "utf8");
	} catch {
		return null;
	}
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

/** Обход дерева с игнором. Пути возвращаются относительными, с прямыми слэшами. */
function* walkTree(root: string, profile: Record<string, string>): Generator<string> {
	const ignores = new Set(DEFAULT_IGNORES);
	for (const item of (profile["не смотреть"] ?? "").split(",")) {
		const clean = item.trim();
		if (clean && !/^<.*>$/.test(clean)) ignores.add(clean);
	}

	let seen = 0;
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (ignores.has(entry)) continue;
			const absolute = join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(absolute).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				stack.push(absolute);
				continue;
			}
			if (seen++ > MAX_SNAPSHOT_FILES) return;
			yield normalizePath(relative(root, absolute));
		}
	}
}
