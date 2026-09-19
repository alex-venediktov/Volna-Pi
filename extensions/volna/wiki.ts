/**
 * Ядро вики выводов: чтение соглашений, разбор записей, сверка якорей с источниками.
 * Без обращений к сети и без внешних зависимостей.
 *
 * Единица хранения - вывод, а не страница про сущность. В разделах с малой плотностью запись
 * лежит отдельным файлом, в плотных (эталонных) - секцией `##` внутри файла подтемы. Оба вида
 * разбираются одинаково: см. readRecords.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { STAGE_NAMES } from "./stages.ts";

export interface SectionRules {
	/** Раздел о коде: запись без локатора с номером строки в нём не доказательство. */
	code?: boolean;
	/** Докуда разбирать узлы в имени файла: дальше идёт имя документа. */
	depth?: number;
}

export interface ReferenceRoot {
	root: string;
	prefix?: string;
	drift_window?: number;
}

export interface WikiLimits {
	record_lines: number;
	record_lines_hard: number;
	record_min_lines: number;
	file_lines: number;
	file_lines_hard: number;
	index_file_lines: number;
	index_file_bytes: number;
	quote_min_chars: number;
	stale_days: number;
}

export interface WikiSchema {
	root: string;
	sections: Record<string, SectionRules>;
	types: string[];
	stages: string[];
	limits: WikiLimits;
	reference_roots: ReferenceRoot[];
	checks: { exec_enabled?: boolean; orphans?: boolean };
	topics?: Record<string, string>;
	index?: { shard_by?: string[]; topic_depth?: number };
}

/**
 * Назначение разделов словами. Нужно подсказке места: узел она берёт у существующих записей, а
 * пустой раздел предложить по ним нечем - он так и остаётся пустым, сколько бы записей ему ни
 * полагалось. Раздел, которого здесь нет, называется без пояснения.
 */
export const SECTION_PURPOSE: Record<string, string> = {
	process: "способы работы: приёмы, ловушки инструментов и окружения",
	project: "знание о самом продукте: правила, числа, зависимости предметной области",
	reference: "свойства эталонной реализации",
	volna: "работа самой «Волны»",
};

/** Значения по умолчанию, если в корне вики нет SCHEMA.md. */
export const DEFAULTS: WikiSchema = {
	root: ".volna/wiki",
	sections: { reference: { code: true }, project: { code: false }, process: { code: false }, volna: { code: false } },
	types: ["гейт", "magic-число", "направление", "особый случай", "порядок", "побочный эффект",
		"ограничение", "термин", "договорённость", "конфликт", "расхождение", "постмортем"],
	// Набор берётся у флоу, а не дублируется: расхождение списков забраковало бы записи с
	// законными этапами. Порядок значим - по нему идут колонка «этапы» и шарды указателя
	stages: [...STAGE_NAMES],
	limits: {
		record_lines: 20, record_lines_hard: 40, record_min_lines: 4, file_lines: 200,
		file_lines_hard: 400, index_file_lines: 300, index_file_bytes: 8000, quote_min_chars: 15,
		stale_days: 365,
	},
	reference_roots: [],
	checks: { exec_enabled: false },
};

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const cp1251 = new TextDecoder("windows-1251");

/**
 * Декодирование исходника с определением кодировки ПОФАЙЛОВО. Единой кодировки у эталона может
 * не быть: в одном корпусе встречаются utf-8 с BOM и cp1251, причём в главном файле - первая.
 * Кодировка как константа конфигурации даёт мохнатый текст на самом важном файле.
 */
export function decodeSource(buf: Uint8Array): string {
	try {
		const s = utf8Strict.decode(buf);
		return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
	} catch {
		return cp1251.decode(buf);
	}
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

/**
 * Разбор ограниченного подмножества YAML: вложенные отображения по отступам, списки через дефис,
 * встроенные `{a: b}` и `[a, b]`, скаляры. Полного YAML тут не нужно, а зависимостей нет.
 *
 * Своё вместо frontmatter.ts: тот знает плоские скаляры журнала, а соглашения вики вложенные.
 */
export function parseYamlSubset(text: string): YamlValue {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
	let i = 0;
	const scalar = (raw: string): YamlValue => {
		const v = raw.trim().replace(/\s+#.*$/, "");
		if (v === "") return "";
		if (v === "true") return true;
		if (v === "false") return false;
		if (v === "null") return null;
		if (/^-?\d+$/.test(v)) return Number(v);
		if (/^-?\d*\.\d+$/.test(v)) return Number(v);
		if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map((s) => scalar(s)).filter((s) => s !== "");
		if (/^\{.*\}$/.test(v)) {
			const out: Record<string, YamlValue> = {};
			for (const pair of v.slice(1, -1).split(",")) {
				const at = pair.indexOf(":");
				if (at > 0) out[pair.slice(0, at).trim()] = scalar(pair.slice(at + 1));
			}
			return out;
		}
		return v.replace(/^["']|["']$/g, "");
	};
	const indentOf = (l: string) => (l.match(/^\s*/) ?? [""])[0].length;
	// Список и отображение держатся порознь, а не в одном значении: на смешанном блоке эталон
	// падал вызовом push у объекта, а инструмент внутри pi обязан дочитать испорченный файл
	const parseBlock = (indent: number): YamlValue => {
		const isList = i < lines.length && indentOf(lines[i]) === indent && /^\s*-\s/.test(lines[i]);
		const list: YamlValue[] = [];
		const map: Record<string, YamlValue> = {};
		while (i < lines.length) {
			const line = lines[i];
			const ind = indentOf(line);
			if (ind < indent) break;
			if (ind > indent) {
				i++;
				continue;
			}
			if (/^\s*-\s/.test(line)) {
				const rest = line.replace(/^\s*-\s*/, "");
				if (rest.includes(":") && !/^[[{]/.test(rest)) {
					const at = rest.indexOf(":");
					const item: Record<string, YamlValue> = { [rest.slice(0, at).trim()]: scalar(rest.slice(at + 1)) };
					i++;
					list.push(item);
				} else {
					i++;
					list.push(scalar(rest));
				}
				continue;
			}
			const at = line.indexOf(":");
			if (at < 0) {
				i++;
				continue;
			}
			const key = line.slice(0, at).trim();
			const rest = line.slice(at + 1).trim();
			i++;
			if (rest === "") map[key] = parseBlock(indentOf(lines[i] ?? "") > indent ? indentOf(lines[i]) : indent + 2);
			else map[key] = scalar(rest);
		}
		return isList ? list : map;
	};
	return parseBlock(indentOf(lines[0] ?? ""));
}

export interface WikiDeps {
	readFile?: (path: string) => string;
	readBuf?: (path: string) => Uint8Array;
	listFiles?: () => string[];
}

/** Слияние соглашений проекта с умолчаниями: отсутствие SCHEMA.md - не ошибка. */
export function loadSchema(root: string, deps: WikiDeps = {}): WikiSchema {
	const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	let raw = "";
	try {
		raw = read(join(root, "SCHEMA.md"));
	} catch {
		return structuredClone(DEFAULTS);
	}
	const block = /```ya?ml\s*\n([\s\S]*?)```/.exec(raw);
	if (!block) return structuredClone(DEFAULTS);
	const parsed = parseYamlSubset(block[1]);
	const merged = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		for (const [k, v] of Object.entries(parsed)) {
			const base = merged[k];
			merged[k] = v && typeof v === "object" && !Array.isArray(v) && base && !Array.isArray(base)
				? { ...(base as object), ...(v as object) }
				: v;
		}
	}
	return merged as unknown as WikiSchema;
}

/**
 * Якорь секции: строчные буквы, пробелы в дефисы, пунктуация отброшена. Совпадает с тем, как
 * ссылку разрешает просмотрщик markdown, поэтому связи вида `[[подтема#заголовок]]` рабочие.
 */
export function slug(heading: string): string {
	return heading.toLowerCase()
		.replace(/[«»"'`(),.:;!?]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Значение поля записи. Поля идут одной строкой через разделитель, поэтому значение обрывается
 * на нём: иначе в «предмет» попадает весь хвост строки вместе с типом и этапами.
 */
export function field(text: string, name: string): string | undefined {
	const m = new RegExp(`\\*\\*${name}:\\*\\*\\s*([^\\n·]*)`).exec(text);
	return m ? m[1].trim() : undefined;
}

/**
 * Значение поля целиком, включая продолжение на следующих строках. Нужно там, где значение
 * длинное: обоснование разрешения, адрес эскалации, сам вывод. Однострочное чтение обрывало их
 * на первой строке и, например, не видело адреса документа, стоявшего в конце абзаца.
 */
export function fieldLong(text: string, name: string): string | undefined {
	const start = new RegExp(`\\*\\*${name}:\\*\\*[ \\t]*`, "m").exec(text);
	if (!start) return undefined;
	const rest = text.slice(start.index + start[0].length);
	const stop = /\n\s*\n\s*\*\*[^*]+:\*\*|\n\s*\n\s*##\s|\n\s*\n\s*- `/.exec(rest);
	return (stop ? rest.slice(0, stop.index) : rest).trim();
}

export interface Anchor {
	path: string;
	line: number | null;
	quote: string;
}

/**
 * Локаторы блока источников: `путь:строка` и дословная цитата через тире.
 *
 * Разделитель и обрамление цитаты принимаются в обеих формах намеренно. Прежний разбор требовал
 * длинного тире и цитаты в обратных кавычках, а конвенция проектов требует ASCII-пунктуации -
 * человек, следующий правилам проекта, писал локатор, которого инструмент не видел (наблюдалось:
 * 108 локаторов с номером строки, распознано 0). Цитата в «кавычках» вдобавок теряла номер
 * строки, и `verify` пропускал её как якорь без строки. Пояснение после цитаты тоже законно
 * («... - `git add -A` перед коммитом»): цитата берётся жадно до последней кавычки, поэтому
 * вложенные «кавычки» её не обрывают, а остаток строки в якорь не входит.
 */
export function parseAnchors(text: string): Anchor[] {
	const out: Anchor[] = [];
	for (const m of String(text || "").matchAll(/^- `([^`]+?)(?::(\d+))?`\s*[—–-]\s*(?:`(.+)`|«(.+)»)[^`«»]*$/gm)) {
		out.push({ path: m[1], line: m[2] ? Number(m[2]) : null, quote: m[3] ?? m[4] });
	}
	return out;
}

/**
 * Строки, похожие на локатор (путь с номером строки в обратных кавычках), которые разбор не
 * признал. Молчание тут дороже шума: неразобранная строка не попадает в сверку вовсе, и дрейф
 * якоря копится незамеченным, пока кто-нибудь не сверит цитаты руками.
 */
export function unparsedLocators(text: string): string[] {
	const out: string[] = [];
	for (const line of String(text || "").split(/\r?\n/)) {
		if (!/^- `[^`]+:\d+`/.test(line)) continue;
		if (parseAnchors(line).length) continue;
		out.push(line.trim());
	}
	return out;
}

/** Файл указателя: собирается инструментом и записью не является ни в одной раскладке. */
export function isIndexFile(name: string): boolean {
	return name === "INDEX.md" || name.startsWith("INDEX-");
}

/** Файлы записей под каталогом: указатели и соглашения записями не считаются. */
export function walkFiles(dir: string, acc: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== "indexes") walkFiles(p, acc);
		} else if (e.name.endsWith(".md") && !isIndexFile(e.name) && e.name !== "SCHEMA.md") acc.push(p);
	}
	return acc;
}

/**
 * Логический путь записи внутри раздела - то, по чему строится дерево указателей. Раскладок две,
 * и обе законны: узлы каталогами (`reference/ui/tabs/gates.md`) и плоская, где путь узла живёт
 * в имени файла через дефис (`reference/ui-tabs-gates.md`). Плоская нужна затем, чтобы указатель
 * ссылался на запись одним именем, а не четырьмя `../` - на длинном корпусе это и есть основной
 * вес указателя. Имя разбирается по реестру `topics`, жадно слева: узлом считается только
 * объявленная тема, остаток - имя документа. Поэтому тема с дефисом внутри (`down-view`) не
 * распадается на два уровня, а незнакомое слово не выдаёт себя за узел.
 *
 * Жадности мало: имя документа само может начинаться с темы («visual-compare/front-render-stand»
 * читается как узел `visual-compare/front`). Поэтому глубину узлов раздел объявляет сам -
 * `sections: {process: {depth: 1}}`, - и дальше разбор не идёт.
 */
export function nodeOf(rel: string, topics: Record<string, string> = {}, depth: number = Infinity): string[] {
	const parts = rel.split("/");
	const dirs = parts.slice(1, -1);
	const base = parts[parts.length - 1].replace(/\.md$/, "");
	const known = Object.keys(topics).sort((a, b) => b.length - a.length);
	const fromName: string[] = [];
	let rest = base;
	while (dirs.length + fromName.length < depth) {
		const hit = known.find((t) => rest === t || rest.startsWith(`${t}-`));
		// Остатка нет - это имя документа, совпавшее с темой, а не ещё один уровень
		if (!hit || rest === hit) break;
		fromName.push(hit);
		rest = rest.slice(hit.length + 1);
	}
	return [...dirs, ...fromName];
}

/** Логический путь записи с учётом соглашений раздела: глубина узлов и реестр тем. */
export function nodeOfRel(rel: string, schema: WikiSchema = DEFAULTS): string[] {
	const section = rel.split("/")[0];
	const declared = schema?.sections?.[section]?.depth;
	return nodeOf(rel, schema?.topics ?? {}, typeof declared === "number" ? declared : Infinity);
}

export interface WikiRecord {
	rel: string;
	path: string;
	section: string;
	node: string[];
	fileTitle: string;
	heading: string;
	anchor: string;
	body: string;
	sectioned: boolean;
	subject: string;
	type: string;
	stages: string[];
	verified: string;
	lines: number;
	anchors: Anchor[];
	links: string[];
	has: (name: string) => boolean;
}

export interface WikiFile {
	rel: string;
	path: string;
	lines: number;
}

/**
 * Все записи корпуса. Файл с секциями `##`, несущими поле типа, даёт запись на секцию; иначе
 * запись - сам файл. Так один разбор обслуживает обе раскладки, а раздел про них не знает.
 */
export function readRecords(
	root: string,
	deps: WikiDeps = {},
	schema: WikiSchema = DEFAULTS,
): { records: WikiRecord[]; files: WikiFile[] } {
	const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const list = deps.listFiles ?? (() => walkFiles(root));
	const records: WikiRecord[] = [];
	const files: WikiFile[] = [];
	for (const path of list()) {
		const rel = relative(root, path).split(sep).join("/");
		const section = rel.split("/")[0];
		const node = nodeOfRel(rel, schema);
		const text = read(path);
		const all = text.split(/\r?\n/);
		files.push({ rel, path, lines: all.length });
		const parts = text.split(/^## /m);
		const sectioned = parts.slice(1).filter((b) => /\*\*тип:\*\*/.test(b));
		// Заголовок файла описывает подтему целиком - указателю он нужен как описание ветки
		const fileTitle = (/^#\s+(.+)$/m.exec(text)?.[1] ?? "").trim();
		// Шапка файла подтемы несёт общие для всех секций поля: раздел, тема, отметка о сверке
		const header = sectioned.length ? parts[0] : "";
		const bodies = sectioned.length
			? sectioned.map((b) => ({ heading: b.split("\n")[0].trim(), body: b.slice(b.indexOf("\n") + 1) }))
			: [{ heading: (/^#\s+(.+)$/m.exec(text)?.[1] ?? rel).trim(), body: text }];
		for (const { heading, body } of bodies) {
			records.push({
				rel,
				path,
				section,
				node,
				fileTitle,
				heading,
				anchor: slug(heading),
				body,
				sectioned: sectioned.length > 0,
				subject: field(body, "предмет") ?? "",
				type: field(body, "тип") ?? "",
				stages: (field(body, "этапы") ?? "").split(/\s*,\s*/).filter(Boolean),
				verified: field(body, "проверено") ?? field(header, "проверено") ?? "",
				lines: body.split(/\r?\n/).filter((l) => l.trim()).length,
				anchors: parseAnchors(body),
				links: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]),
				has: (name: string) => new RegExp(`\\*\\*${name}:\\*\\*`).test(body),
			});
		}
	}
	return { records, files };
}

/** Разрешение локатора кода в корень эталона по объявленным префиксам. */
export function resolveReferencePath(
	schema: WikiSchema,
	path: string,
): { root: string; rel: string; drift: number } | null {
	for (const r of schema.reference_roots ?? []) {
		const prefix = r.prefix ?? "";
		if (!prefix || path.startsWith(prefix)) {
			return { root: r.root, rel: prefix ? path.slice(prefix.length) : path, drift: r.drift_window ?? 40 };
		}
	}
	return null;
}

export type AnchorVerdict =
	| "не код"
	| "корень не объявлен"
	| "файла нет"
	| "точно"
	| "короткий фрагмент"
	| "точно, фрагмент"
	| "сдвинулось"
	| "не найдено";

export interface AnchorCheck {
	verdict: AnchorVerdict;
	line?: number;
	length?: number;
	actual?: string;
}

/**
 * Сверка одного якоря с источником. Порядок проверок важен: сначала совпадение строки целиком -
 * оно доказательно при любой длине (`razriv:=8;` законная цитата из десяти символов), и только
 * потом ограничение длины, которое нужно фрагменту. Обратный порядок бракует короткие операторы,
 * а именно они и несут magic-числа.
 */
export function verifyAnchor(anchor: Anchor, schema: WikiSchema, deps: WikiDeps = {}): AnchorCheck {
	const readBuf = deps.readBuf ?? ((p: string) => readFileSync(p));
	const min = schema.limits?.quote_min_chars ?? DEFAULTS.limits.quote_min_chars;
	if (anchor.line == null) return { verdict: "не код" };
	const resolved = resolveReferencePath(schema, anchor.path);
	if (!resolved) return { verdict: "корень не объявлен" };
	let lines: string[];
	try {
		lines = decodeSource(readBuf(join(resolved.root, resolved.rel))).split(/\r?\n/);
	} catch {
		return { verdict: "файла нет" };
	}
	const at = anchor.line - 1;
	const actual = lines[at] ?? null;
	const q = anchor.quote.trim();
	if (actual != null && actual.trim() === q) return { verdict: "точно" };
	if (q.length < min) return { verdict: "короткий фрагмент", length: q.length };
	if (actual != null && actual.includes(q)) return { verdict: "точно, фрагмент" };
	for (let d = 1; d <= resolved.drift; d++) {
		if (lines[at - d]?.includes(q)) return { verdict: "сдвинулось", line: at - d + 1 };
		if (lines[at + d]?.includes(q)) return { verdict: "сдвинулось", line: at + d + 1 };
	}
	return { verdict: "не найдено", actual: actual?.trim() ?? "" };
}
