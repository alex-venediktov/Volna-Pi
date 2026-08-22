/**
 * Минимальный YAML для frontmatter журнала: плоские скаляры и плоские массивы строк.
 * Своё вместо зависимости потому, что формат журнала намеренно узкий, а лишняя зависимость
 * в pi-пакете тянется в каждую установку.
 *
 * Массивы пишутся в одну строку (`stages_done: [intake, analyze]`), читаются и такие, и
 * блочные списки - журнал правят руками, и ручная правка не должна ломать разбор.
 */

export type FmValue = string | string[];
export type Frontmatter = Record<string, FmValue>;

/** Разобрать документ на frontmatter и тело. Блока нет - пустой frontmatter и весь текст телом. */
export function splitFrontmatter(text: string): { fm: Frontmatter; body: string; hasBlock: boolean } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!match) return { fm: {}, body: text, hasBlock: false };
	return { fm: parseFrontmatter(match[1]), body: text.slice(match[0].length), hasBlock: true };
}

/** Разбор тела блока: `ключ: значение`, плюс блочные списки под ключом без значения. */
export function parseFrontmatter(block: string): Frontmatter {
	const out: Frontmatter = {};
	const lines = block.split(/\r?\n/);
	let listKey: string | null = null;
	for (const line of lines) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) {
			(out[listKey] as string[]).push(unquote(item[1]));
			continue;
		}
		const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!kv) continue;
		const key = kv[1];
		const raw = kv[2].trim();
		if (raw === "") {
			listKey = key;
			out[key] = [];
			continue;
		}
		listKey = null;
		out[key] = raw.startsWith("[") ? parseInlineList(raw) : unquote(raw);
	}
	return out;
}

/** Собрать документ обратно. Порядок ключей сохраняется - журнал читают глазами. */
export function stringifyFrontmatter(fm: Frontmatter, body: string): string {
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(fm)) {
		lines.push(Array.isArray(value) ? `${key}: [${value.map(quoteItem).join(", ")}]` : `${key}: ${quoteScalar(value)}`);
	}
	lines.push("---", "");
	return `${lines.join("\n")}${body.startsWith("\n") ? body.slice(1) : body}`;
}

/** Значение как массив: поля вроде open[] читаются и когда в них одна строка. */
export function asList(value: FmValue | undefined): string[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : value.trim() === "" ? [] : [value];
}

/** Значение как строка: массив склеивается, чтобы вызывающий не проверял тип каждый раз. */
export function asText(value: FmValue | undefined): string {
	if (value === undefined) return "";
	return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Разбор списка в одну строку. Запятая внутри кавычек - часть значения: причина пропуска этапа
 * («visual: выхода нет, проверять нечего») обычная строка с запятыми, и разбивать её по ним
 * значит терять пункт списка и портить файл на следующей же перезаписи.
 */
function parseInlineList(raw: string): string[] {
	const inner = raw.replace(/^\[/, "").replace(/\]$/, "").trim();
	if (!inner) return [];
	const items: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (quote) {
			if (ch === "\\" && inner[i + 1] === quote) {
				current += quote;
				i++;
				continue;
			}
			if (ch === quote) {
				quote = null;
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ",") {
			items.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	items.push(current.trim());
	return items.filter((item) => item !== "");
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (/^"[\s\S]*"$/.test(trimmed) || /^'[\s\S]*'$/.test(trimmed)) return trimmed.slice(1, -1);
	return trimmed;
}

/** Кавычки только там, где без них разбор сломается: двоеточие, кавычки, скобки, решётка. */
function quoteScalar(value: string): string {
	const v = String(value);
	if (v === "") return '""';
	if (/^[[{]|[:#"']|^\s|\s$/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
	return v;
}

function quoteItem(value: string): string {
	const v = String(value);
	if (/[,\]["']|^\s|\s$/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
	return v;
}
