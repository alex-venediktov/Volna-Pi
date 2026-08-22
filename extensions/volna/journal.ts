/**
 * Журнал работ: два файла на задачу. TASK-<id>.md - frontmatter и переписываемая секция
 * «Состояние» (по ней задача восстанавливается с нуля), logs/TASK-<id>.log.md - append-only лог
 * итераций по этапам.
 *
 * Формат и метки времени ставит код, а не модель: метки берутся у часов машины, потому что по ним
 * на закрытии считаются часы, а модель текущего времени не знает и склонна его экстраполировать.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Frontmatter, splitFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import { volnaPaths } from "./paths.ts";

/** Метка времени журнала: локальное время машины, зона не пишется. */
export function stamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Дата для идентификатора задачи: ГГММДД. */
export function dateSlug(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

const TRANSLIT: Record<string, string> = {
	а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
	к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
	х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Слаг для идентификатора: латиница в kebab-case, до maxWords значимых слов. Русские слова
 * транслитерируются - id стоит в имени файла и в state.json, а кириллица в путях приносит
 * проблемы там, где их меньше всего ждёшь.
 */
export function slugify(text: string, maxWords = 4): string {
	const words = String(text)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.map((word) => word.replace(/\p{L}/gu, (ch) => TRANSLIT[ch] ?? ch))
		.map((word) => word.replace(/[^a-z0-9]/g, ""))
		.filter((word) => word.length > 2);
	const slug = words.slice(0, maxWords).join("-");
	return slug || "task";
}

/** Свободный идентификатор задачи: дата, слаг, при совпадении - числовой суффикс. */
export function freeTaskId(volnaDir: string, title: string): string {
	const base = `${dateSlug()}-${slugify(title)}`;
	const paths = volnaPaths(volnaDir);
	if (!existsSync(paths.journal(base))) return base;
	for (let i = 2; i < 50; i++) {
		const candidate = `${base}-${i}`;
		if (!existsSync(paths.journal(candidate))) return candidate;
	}
	return `${base}-${Date.now()}`;
}

export interface CreateJournalOptions {
	task: string;
	title: string;
	type: string;
	source: string;
	/** Текст задания дословно: уходит в первую секцию лога и остаётся там навсегда. */
	assignment: string;
	goal?: string;
}

/** Создать журнал задачи: файл состояния и лог с первой секцией intake. */
export function createJournal(volnaDir: string, options: CreateJournalOptions): { journalPath: string; logPath: string } {
	const paths = volnaPaths(volnaDir);
	const now = stamp();
	mkdirSync(paths.logsDir, { recursive: true });

	const fm: Frontmatter = {
		task: options.task,
		title: options.title,
		type: options.type,
		source: options.source,
		branch: "",
		stage: "intake",
		stages_done: [],
		skipped: [],
		open: [],
		state_sync: "intake/1",
		started: now,
		updated: now,
	};
	const body = renderStateSection(
		{
			goal: options.goal || options.title,
			done: "журнал создан, задание принято",
			next: "разбор задания: этап analyze",
		},
		now,
	);
	writeFileSync(paths.journal(options.task), stringifyFrontmatter(fm, `\n${body}`), "utf8");

	const header = [
		`# Лог работ по задаче ${options.task}`,
		"",
		`Задача: ${options.title}`,
		"",
		"Append-only: прошлые секции не переписываются, повторный заход на этап открывает новую итерацию.",
		"",
	].join("\n");
	writeFileSync(paths.log(options.task), `${header}\n`, "utf8");
	appendLogSection(volnaDir, options.task, {
		stage: "intake",
		iteration: 1,
		fields: {
			что: "принято задание, создан журнал",
			зачем: "работа должна быть восстановима по журналу без остатков контекста",
			как: `источник задания: ${options.source}`,
			сделано: `журнал .volna/journal/TASK-${options.task}.md`,
			осталось: "разбор задания",
			задание: options.assignment.trim() || "(текст задания не передан)",
		},
	});
	return { journalPath: paths.journal(options.task), logPath: paths.log(options.task) };
}

/** Порядок подпунктов секции лога. Всё, чего в списке нет, дописывается в конец как есть. */
const LOG_FIELD_ORDER = ["что", "зачем", "почему", "как", "сделано", "осталось", "нужно", "знания", "отменяет", "задание"];

export interface AppendLogOptions {
	stage: string;
	iteration?: number;
	fields: Record<string, string | undefined>;
	at?: Date;
}

/** Дописать секцию в конец лога. Номер итерации, если не задан, считается по самому логу. */
export function appendLogSection(
	volnaDir: string,
	task: string,
	options: AppendLogOptions,
): { iteration: number; stamp: string } {
	const paths = volnaPaths(volnaDir);
	const logPath = paths.log(task);
	mkdirSync(dirname(logPath), { recursive: true });
	const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
	const iteration = options.iteration ?? nextIteration(logText, options.stage);
	const at = stamp(options.at ?? new Date());

	const known = LOG_FIELD_ORDER.filter((key) => (options.fields[key] ?? "").trim() !== "");
	const extra = Object.keys(options.fields).filter(
		(key) => !LOG_FIELD_ORDER.includes(key) && (options.fields[key] ?? "").trim() !== "",
	);
	const lines = [`## ${options.stage} · итерация ${iteration} · ${at}`, ""];
	for (const key of [...known, ...extra]) {
		lines.push(...renderField(key, String(options.fields[key])));
	}
	lines.push("");
	const prefix = logText === "" || logText.endsWith("\n") ? "" : "\n";
	appendFileSync(logPath, `${prefix}${lines.join("\n")}\n`, "utf8");
	return { iteration, stamp: at };
}

/** Многострочное значение подпункта не ломает разметку: продолжение уходит с отступом. */
function renderField(key: string, value: string): string[] {
	const parts = value.trim().split(/\r?\n/);
	return [`- **${key}:** ${parts[0]}`, ...parts.slice(1).map((line) => `  ${line}`)];
}

/** Номер следующей итерации этапа: N+1 от последней его секции в логе. */
export function nextIteration(logText: string, stage: string): number {
	const re = new RegExp(`^##\\s+${escapeRe(stage)}\\s+·\\s+итерация\\s+(\\d+)`, "gmi");
	let max = 0;
	for (const match of logText.matchAll(re)) {
		max = Math.max(max, Number.parseInt(match[1], 10) || 0);
	}
	return max + 1;
}

/** Последняя секция лога: этап, итерация, метка. Лога нет - null. */
export function lastLogSection(logText: string): { stage: string; iteration: number; stamp: string } | null {
	const re = /^##\s+([^\s·]+)\s+·\s+итерация\s+(\d+)\s+·\s+([\d-]+\s[\d:]+)/gm;
	let last: { stage: string; iteration: number; stamp: string } | null = null;
	for (const match of logText.matchAll(re)) {
		last = { stage: match[1], iteration: Number.parseInt(match[2], 10), stamp: match[3] };
	}
	return last;
}

/** Этапы, по которым в логе есть запись, в порядке появления. */
export function stagesInLog(logText: string): string[] {
	const out: string[] = [];
	for (const match of logText.matchAll(/^##\s+([^\s·]+)\s+·\s+итерация/gm)) {
		if (!out.includes(match[1])) out.push(match[1]);
	}
	return out;
}

export interface StateFields {
	goal: string;
	established?: string;
	decision?: string;
	rejected?: string;
	done: string;
	next: string;
	careful?: string;
	wiki?: string;
}

/** Имена подпунктов «Состояния» фиксированы: подпункт с другим именем никто не найдёт. */
const STATE_LABELS: Array<[keyof StateFields, string]> = [
	["goal", "цель"],
	["established", "установлено"],
	["decision", "решение"],
	["rejected", "отвергнуто"],
	["done", "сделано"],
	["next", "следующий шаг"],
	["careful", "осторожно"],
	["wiki", "в вики"],
];

export function renderStateSection(fields: StateFields, at = stamp()): string {
	const lines = [`## Состояние · ${at}`, ""];
	for (const [key, label] of STATE_LABELS) {
		const value = (fields[key] ?? "").trim();
		if (!value) continue;
		const parts = value.split(/\r?\n/);
		lines.push(`**${label}:** ${parts[0]}`);
		for (const part of parts.slice(1)) lines.push(part);
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** Отметка «на какой секции лога переписано Состояние»: этап и итерация последней записи. */
export function logMarker(logText: string): string {
	const last = lastLogSection(logText);
	return last ? `${last.stage}/${last.iteration}` : "";
}

/**
 * Переписать «Состояние» целиком: секция единственная в файле, всё после неё заменяется.
 *
 * Вместе с секцией пишется `state_sync` - последняя секция лога на этот момент. По метке времени
 * отставание не поймать: запись в лог и перезапись «Состояния» попадают в одну минуту, а формат
 * меток - до минут. Отметка отвечает на вопрос точно: «Состояние» знает про эту итерацию или нет.
 */
export function writeStateSection(
	journalPath: string,
	fields: StateFields,
	options: { logText?: string; at?: string } = {},
): void {
	const at = options.at ?? stamp();
	const text = readFileSync(journalPath, "utf8");
	const { fm, body } = splitFrontmatter(text);
	const index = body.search(/^##\s+Состояние/m);
	const head = index < 0 ? body.trimEnd() : body.slice(0, index).trimEnd();
	const next = `${head ? `${head}\n\n` : "\n"}${renderStateSection(fields, at)}`;
	const patch: Frontmatter = { ...fm, updated: at };
	if (options.logText !== undefined) patch.state_sync = logMarker(options.logText);
	writeFileSync(journalPath, stringifyFrontmatter(patch, next), "utf8");
}

/**
 * Что мешает восстановить задачу по журналу. Это вопросы чек-пойнта, только проверяемые машиной:
 * отсутствие секции, отставание от лога, пропавшие обязательные подпункты, размер.
 */
export function journalIssues(input: {
	text: string;
	stateSection: string | null;
	logText: string;
	fm?: Frontmatter;
}): string[] {
	const issues: string[] = [];
	if (!input.stateSection) {
		issues.push("в журнале нет секции «## Состояние» - после сжатия контекста придётся читать лог целиком");
		return issues;
	}
	const size = Buffer.byteLength(input.stateSection, "utf8");
	if (size > 6144) {
		issues.push(`«Состояние» разрослось (${Math.round(size / 1024)} КБ) - ужми до экрана, история остаётся в логе`);
	}
	const missing = ["цель", "сделано", "следующий шаг"].filter(
		(label) => !new RegExp(`\\*\\*${label}:\\*\\*`).test(input.stateSection ?? ""),
	);
	if (missing.length) {
		issues.push(
			`в «Состоянии» нет подпунктов ${missing.map((m) => `«${m}»`).join(", ")} - в этом формате их никто не найдёт`,
		);
	}
	const last = lastLogSection(input.logText);
	if (!last) return issues;
	const marker = input.fm?.state_sync;
	const sync = typeof marker === "string" ? marker.trim() : "";
	const current = logMarker(input.logText);
	const stateStamp = /^##\s+Состояние\s+·\s+([\d-]+\s[\d:]+)/m.exec(input.text)?.[1];
	const stale = sync ? sync !== current : Boolean(stateStamp && last.stamp > stateStamp);
	if (stale) {
		issues.push(
			`«Состояние» отстало от лога (последняя запись: ${last.stage}, итерация ${last.iteration}, ${last.stamp}) - перепиши его`,
		);
	}
	return issues;
}

function escapeRe(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
