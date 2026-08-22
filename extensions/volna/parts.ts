/**
 * Задача из нескольких частей: работа не помещается в один заход, но остаётся одной задачей с одним
 * журналом и одной веткой. Части - её внутреннее деление: цикл spec → … → close проходится по разу
 * на каждую, между частями стоит /clear.
 *
 * Список частей живёт в подпункте «части» секции «Состояние» - там же, где всё остальное, что нужно
 * для продолжения. Отдельного файла плана не заводится: он разъехался бы с журналом на второй же
 * части. Номера `part`/`parts` во frontmatter считает код по списку, руками их не ставят.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type Frontmatter, splitFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";

export const PART_STATUSES = ["не начата", "в работе", "сделано", "снята"] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

export interface Part {
	number: number;
	title: string;
	status: PartStatus;
	/** Дата и часы у сделанной, причина у снятой. */
	note: string;
}

/** Пункт списка: «2. приём шага по форме - сделано (2026-08-16, 3ч)». */
const PART_LINE = /^\s*(\d+)[.)]\s*(.*)$/;

/** Разобрать список частей из текста: по строке на часть, статус на хвосте строки. */
export function parsePartsText(text: string): Part[] {
	const out: Part[] = [];
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const match = PART_LINE.exec(line);
		if (!match) continue;
		const rest = match[2].trim();
		if (!rest) continue;
		const { title, status, note } = splitStatus(rest);
		out.push({ number: out.length + 1, title, status, note });
	}
	return out;
}

/** Список частей из секции «Состояние». Подпункта нет - задача не разбита на части. */
export function partsFromState(stateSection: string | null): Part[] {
	const block = partsBlock(String(stateSection ?? ""));
	return block ? parsePartsText(block.text) : [];
}

/** Список частей строками: то, что кладётся в подпункт «части». */
export function renderPartsText(parts: Part[]): string {
	return parts
		.map((part, index) => `${index + 1}. ${part.title} - ${part.status}${part.note ? ` (${part.note})` : ""}`)
		.join("\n");
}

/** Часть в работе, а если такой нет - первая не начатая. Остатка нет - undefined. */
export function currentPart(parts: Part[]): Part | undefined {
	return parts.find((part) => part.status === "в работе") ?? parts.find((part) => part.status === "не начата");
}

/** Части, которые ещё не закрыты и не сняты: по ним решается, закрывается часть или задача. */
export function unfinishedParts(parts: Part[]): Part[] {
	return parts.filter((part) => part.status !== "сделано" && part.status !== "снята");
}

/** Тот же список с новым состоянием одной части. Номера частей - позиции в списке. */
export function markPart(parts: Part[], number: number, status: PartStatus, note = ""): Part[] {
	return parts.map((part) => (part.number === number ? { ...part, status, note } : part));
}

/** Строка для шапки и футера: «часть 2/3 приём шага по форме». Частей нет - пустая строка. */
export function partsHeadline(parts: Part[]): string {
	if (!parts.length) return "";
	const current = currentPart(parts);
	if (!current) return `части ${parts.length}/${parts.length} сделаны`;
	return `часть ${current.number}/${parts.length} ${current.title}`;
}

/**
 * Проставить `part`/`parts` во frontmatter по списку частей. У задачи без частей этих полей нет
 * вовсе: пустое поле в журнале выглядит как «часть есть, но не заполнена».
 */
export function applyPartsFields(fm: Frontmatter, parts: Part[]): Frontmatter {
	const next: Frontmatter = { ...fm };
	if (!parts.length) {
		delete next.part;
		delete next.parts;
		return next;
	}
	const current = currentPart(parts);
	next.part = String(current ? current.number : parts.length);
	next.parts = String(parts.length);
	return next;
}

/**
 * Переписать подпункт «части» в «Состоянии», не трогая остального, и пересчитать `part`/`parts`.
 * Секции «Состояние» ещё нет - писать некуда: список появится вместе с ней.
 */
export function writeParts(journalPath: string, parts: Part[]): boolean {
	const text = readFileSync(journalPath, "utf8");
	const { fm, body } = splitFrontmatter(text);
	if (!/^##\s+Состояние/m.test(body)) return false;
	const next = replacePartsBlock(body, parts);
	writeFileSync(journalPath, stringifyFrontmatter(applyPartsFields(fm, parts), next), "utf8");
	return true;
}

/**
 * Подпункт «части» в теле файла: где начинается, где кончается, что внутри.
 * Блок кончается следующим подпунктом «Состояния», новой секцией или пустой строкой.
 */
function partsBlock(body: string): { start: number; end: number; text: string } | null {
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((line) => /^\*\*части:\*\*/.test(line.trim()));
	if (start < 0) return null;
	let end = start + 1;
	while (end < lines.length) {
		const line = lines[end].trim();
		if (!line || line.startsWith("**") || line.startsWith("#")) break;
		end++;
	}
	const first = lines[start].replace(/^\s*\*\*части:\*\*\s*/, "");
	return { start, end, text: [first, ...lines.slice(start + 1, end)].join("\n") };
}

/** Тело файла с новым списком частей: пустой список подпункт убирает. */
function replacePartsBlock(body: string, parts: Part[]): string {
	const lines = body.split(/\r?\n/);
	const block = partsBlock(body);
	const rendered = parts.length ? [`**части:**`, ...renderPartsText(parts).split("\n")] : [];
	if (block) {
		lines.splice(block.start, block.end - block.start, ...rendered);
		return lines.join("\n");
	}
	if (!parts.length) return body;
	const goal = lines.findIndex((line) => /^\*\*цель:\*\*/.test(line.trim()));
	const at = goal < 0 ? lines.findIndex((line) => /^##\s+Состояние/.test(line.trim())) + 2 : goal + 1;
	lines.splice(Math.max(at, 0), 0, ...rendered);
	return lines.join("\n");
}

/** Отделить статус от названия части. Статуса нет - часть ещё не начата. */
function splitStatus(rest: string): { title: string; status: PartStatus; note: string } {
	const re = new RegExp(`^(.*?)\\s*[-—–:]\\s*(${PART_STATUSES.join("|")})\\s*(?:\\(([^)]*)\\))?\\s*$`, "i");
	const match = re.exec(rest);
	if (!match) return { title: rest, status: "не начата", note: "" };
	const status = PART_STATUSES.find((value) => value === match[2].toLowerCase()) ?? "не начата";
	return { title: match[1].trim() || rest, status, note: (match[3] ?? "").trim() };
}
