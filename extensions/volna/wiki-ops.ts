/**
 * Операции над викой: развернуть, пересобрать указатели, найти маршрут и место, проверить,
 * сверить якоря, посчитать. Порт команд CLI «Волны» в ядро пакета - у pi нет своего bin, и
 * инструмент с командой зовут одну и ту же функцию.
 *
 * Ни одна операция не пишет в файлы без `fix`: план сначала показывается человеку.
 * Коды возврата те же, что у CLI: 0 чисто, 1 ошибки, 2 только предупреждения, 3 сбой.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { volnaPaths } from "./paths.ts";
import {
	type Anchor,
	DEFAULTS,
	isIndexFile,
	loadSchema,
	readRecords,
	type ReferenceRoot,
	unparsedLocators,
	verifyAnchor,
	type WikiDeps,
	type WikiLimits,
	type WikiRecord,
	type WikiSchema,
	walkFiles,
} from "./wiki.ts";
import { planIndexes, planPlacement, planRoute } from "./wiki-index.ts";
import { ERROR, formatFindings, lint } from "./wiki-lint.ts";

export const SCHEMA_TEMPLATE = `# Соглашения вики выводов

Машиночитаемая часть - блок ниже. Отсутствие файла означает значения по умолчанию.

\`\`\`yaml
root: .volna/wiki
sections:
  reference: {code: true}
  project: {code: false}
  process: {code: false}
  volna: {code: false}
reference_roots:
  - root: "."
    prefix: ""
    drift_window: 40
limits:
  record_lines: 20
  record_lines_hard: 40
  record_min_lines: 4
  file_lines: 200
  file_lines_hard: 400
  index_file_lines: 300
  quote_min_chars: 15
  stale_days: 365
checks:
  exec_enabled: false
\`\`\`

## Корни сверки

\`reference_roots\` включает сверку локаторов: без блока \`verify\` не проверяет ни одного якоря, а
\`lint\` при этом выглядит чистым. По умолчанию корень - сам репозиторий, поэтому локатор вида
\`extensions/volna/core.ts:12\` сверяется без настройки. Эталон за пределами репозитория добавляется
своей строкой с \`prefix\`.

## Единица хранения

Одна запись - один вывод. Заголовок записи это утверждение, а не тема. В разделах с кодовым
признаком обязателен блок источников, и каждый локатор несёт номер строки и дословную цитату.

## Раскладка

В разделах малой плотности запись лежит отдельным файлом. В плотных - секцией \`##\` внутри файла
подтемы: соседние выводы взаимно контекстны, и порознь они вводят в заблуждение.
`;

export interface WikiOpsDeps extends WikiDeps {
	exists?: (path: string) => boolean;
	write?: (path: string, text: string) => void;
	listDir?: (path: string) => string[];
	isDir?: (path: string) => boolean;
	remove?: (path: string) => void;
}

export type WikiAction = "index" | "route" | "place" | "lint" | "verify" | "stats" | "pairs";

export interface WikiRunOptions {
	/** Корень вики. По умолчанию `.volna/wiki` рядом с найденной `.volna`. */
	root?: string;
	/** Слова задачи для `route`, текст записи для `place`. */
	query?: string;
	/** Записать то, что запланировано: без него ни одна операция в файлы не пишет. */
	fix?: boolean;
	/** Полный список находок линта вместо первых сорока. */
	all?: boolean;
	limit?: number;
	/**
	 * От чего отсчитываются относительные корни сверки (`root: "."` в SCHEMA.md). Это корень
	 * проекта, а не текущий каталог процесса: pi запускают и из подкаталога, и тогда «.» указал бы
	 * на чужое место, а сверка честно сказала бы «файла нет».
	 */
	base?: string;
}

export interface WikiResult {
	text: string;
	/** 0 чисто, 1 ошибки, 2 только предупреждения, 3 сбой инструмента. */
	code: number;
}

/** Корень вики: явно названный либо `.volna/wiki` развёрнутого проекта. */
export function wikiRoot(volnaDir: string, override?: string): string {
	return override?.trim() ? override.trim() : volnaPaths(volnaDir).wikiDir;
}

/**
 * Развернуть структуру вики: соглашения и пустые разделы. Уже развёрнутую не трогает - SCHEMA.md
 * правят руками, и перезапись стёрла бы объявленные корни сверки вместе с реестром тем.
 */
export function initWiki(root: string, deps: WikiOpsDeps = {}): { created: string[]; skipped: boolean } {
	const exists = deps.exists ?? existsSync;
	const write = deps.write ?? defaultWrite;
	if (exists(join(root, "SCHEMA.md"))) return { created: [], skipped: true };
	const created: string[] = [];
	write(join(root, "SCHEMA.md"), SCHEMA_TEMPLATE);
	created.push("SCHEMA.md");
	for (const section of Object.keys(DEFAULTS.sections)) {
		write(join(root, section, ".gitkeep"), "");
		created.push(`${section}/`);
	}
	return { created, skipped: false };
}

function defaultWrite(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}

/** Корень проекта по корню вики: `<проект>/.volna/wiki` - то, от чего отсчитывается «.». */
function projectRootOf(root: string): string {
	return dirname(dirname(root));
}

/** Относительный корень сверки - от корня проекта; абсолютный остаётся как записан. */
function rootedAgainst(roots: ReferenceRoot[] | undefined, base: string): ReferenceRoot[] {
	return (roots ?? []).map((r) => ({ ...r, root: isAbsolute(r.root) ? r.root : resolve(base, r.root) }));
}

/**
 * Одна дорога для инструмента и команды: действие, корень, флаги - и текст для человека.
 * Разбор корпуса общий, потому что любое действие начинается с него.
 */
export function runWiki(action: WikiAction, options: WikiRunOptions, deps: WikiOpsDeps = {}): WikiResult {
	const exists = deps.exists ?? existsSync;
	const root = options.root ?? "";
	if (!root) return { text: "корень вики не задан", code: 3 };
	if (!exists(root)) {
		return { text: `каталога вики нет: ${root}\nразвернуть: /volna:init`, code: 3 };
	}

	let schema: WikiSchema;
	let records: WikiRecord[];
	let files: ReturnType<typeof readRecords>["files"];
	try {
		schema = loadSchema(root, deps);
		schema.reference_roots = rootedAgainst(schema.reference_roots, options.base ?? projectRootOf(root));
		({ records, files } = readRecords(root, deps, schema));
	} catch (error) {
		return { text: `не удалось прочитать вику: ${(error as Error)?.message ?? error}`, code: 3 };
	}
	if (!records.length) return { text: `в ${root} нет записей`, code: 3 };

	const plan = planIndexes(records, schema);
	const log: string[] = [];
	const say = (line: string) => log.push(line);
	const done = (code: number): WikiResult => ({ text: log.join("\n"), code });

	if (action === "index") {
		if (!options.fix) {
			say(`план указателей (без fix ничего не записано): файлов ${plan.files.length}`);
			for (const f of plan.files) say(`  ${f.text.split("\n").length} строк  ${f.rel}`);
			// Ось называется настоящая: жёсткая строка «по этапам» лгала бы при shard_by: [topic].
			// Решение о раскладке принимает инструмент, значит он и обязан его назвать
			if (plan.sharded.length) say(`шардированы ${plan.axis}: ${plan.sharded.join(", ")} (ось index.shard_by в SCHEMA.md)`);
			return done(0);
		}
		const write = deps.write ?? defaultWrite;
		for (const f of plan.files) write(join(root, f.rel), f.text);
		// Шард, оставшийся от переименованного или опустевшего узла, живым не выглядит - агент
		// откроет его и получит устаревший перечень. Убираем всё, чего нет в плане
		const planned = new Set(plan.files.map((f) => f.rel));
		const listDir = deps.listDir ?? ((p: string) => (existsSync(p) ? readdirSync(p) : []));
		const isDir = deps.isDir ?? ((p: string) => existsSync(p) && statSync(p).isDirectory());
		const remove = deps.remove ?? ((p: string) => rmSync(p, { recursive: true }));
		const dead: string[] = [];
		// Подметаем только указатели: они собираются инструментом, а всё прочее в разделе - записи.
		// Прежняя раскладка держала их в каталоге `indexes`, нынешняя - в корне раздела с суффиксом
		// имени, поэтому обход берёт оба места
		const sweep = (relDir: string) => {
			for (const name of listDir(join(root, relDir))) {
				const rel = `${relDir}/${name}`;
				// Каталог прежней раскладки принадлежит инструменту целиком: записей там не бывает
				if (isDir(join(root, rel))) {
					if (name === "indexes") {
						remove(join(root, rel));
						dead.push(`${rel}/`);
					}
					continue;
				}
				if (name.endsWith(".md") && isIndexFile(name) && !planned.has(rel)) {
					remove(join(root, rel));
					dead.push(rel);
				}
			}
		};
		for (const section of new Set(records.map((r) => r.section))) sweep(section);
		say(`указателей записано: ${plan.files.length}${plan.sharded.length ? `, шардированы ${plan.axis}: ${plan.sharded.join(", ")}` : ""}`);
		if (dead.length) say(`мёртвых шардов удалено: ${dead.length} (${dead.join(", ")})`);
		return done(0);
	}

	if (action === "route") {
		const query = (options.query ?? "").trim();
		if (!query) return { text: "нужны слова задачи: route «экспорт вида слева размеры»", code: 3 };
		const { words, routes, hits } = planRoute(records, query, schema);
		if (!routes.length) {
			say(`по словам «${words.join(", ")}» совпадений нет: открыть корневой указатель INDEX.md`);
			return done(0);
		}
		say(`слова: ${words.join(", ")}`);
		say("\nмаршруты, начиная с ближайшего:");
		for (const r of routes) say(`  ${String(r.count).padStart(3)} зап.  ${r.rel}\n           ${r.subjects.join(", ")}`);
		say("\nближайшие записи:");
		for (const h of hits.slice(0, 8)) say(`  ${h.at}`);
		return done(0);
	}

	if (action === "place") {
		const text = (options.query ?? "").trim();
		if (!text) return { text: "нужен текст записи: place «Шаг ряда размеров равен десяти»", code: 3 };
		const p = planPlacement(records, text, schema);
		say(`слова: ${p.words.join(", ")}`);
		if (p.confident) {
			say(`\nместо в существующей иерархии: ${p.dir}`);
			say(`  совпало сегментов: ${p.segmentHits}, вес ${p.score}`);
			if (p.alternatives.length) say(`  рядом: ${p.alternatives.map((a) => a.dir).join(", ")}`);
			return done(0);
		}
		say(`\nподходящего узла нет${p.dir ? ` (ближайший ${p.dir}, вес ${p.score})` : ""}`);
		say(`завести: ${p.suggestion?.dir}`);
		if (p.suggestion?.unmatched.length) say(`  слова задачи без узла: ${p.suggestion.unmatched.join(", ")}`);
		say("  имя узла - одно слово; описание темы дописать в SCHEMA.md, ключ topics");
		return done(0);
	}

	if (action === "verify") {
		const counts: Record<string, number> = {
			"точно": 0, "точно, фрагмент": 0, "сдвинулось": 0, "не найдено": 0,
			"файла нет": 0, "короткий фрагмент": 0, "корень не объявлен": 0,
		};
		const problems: string[] = [];
		const moves: { r: WikiRecord; a: Anchor; to: number }[] = [];
		let total = 0;
		for (const r of records) {
			for (const a of r.anchors) {
				if (a.line == null) continue;
				total++;
				const v = verifyAnchor(a, schema, deps);
				counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
				const at = `${r.rel}#${r.anchor}`;
				if (v.verdict === "сдвинулось" && v.line != null) {
					moves.push({ r, a, to: v.line });
					problems.push(`СДВИГ ${v.line - a.line > 0 ? "+" : ""}${v.line - a.line}  ${at}  ${a.path}:${a.line} -> :${v.line}`);
				} else if (v.verdict === "не найдено") {
					problems.push(`НЕ НАЙДЕНО  ${at}  ${a.path}:${a.line}\n    ожидалось: ${a.quote}\n    на строке: ${v.actual}`);
				} else if (v.verdict === "файла нет") problems.push(`НЕТ ФАЙЛА  ${at}  ${a.path}`);
				else if (v.verdict === "короткий фрагмент") {
					problems.push(`КОРОТКИЙ ФРАГМЕНТ  ${at}  ${a.path}:${a.line} (${v.length} симв., строка целиком не совпала)`);
				} else if (v.verdict === "корень не объявлен") {
					problems.push(`КОРЕНЬ НЕ ОБЪЯВЛЕН  ${at}  ${a.path} - дописать reference_roots в SCHEMA.md`);
				}
			}
		}
		// Неразобранный локатор молча выпадает из сверки, а «якорей кода: 0» читается как «всё сошлось».
		const unparsed: string[] = [];
		for (const r of records) for (const l of unparsedLocators(r.body)) unparsed.push(`${r.rel}#${r.anchor}  ${l}`);
		const withSources = records.filter((r) => r.has("источник")).length;
		say(`записей: ${records.length}, якорей кода: ${total}`);
		for (const [k, v] of Object.entries(counts)) if (v) say(`  ${k}: ${v}`);
		if (!total && withSources) say(`  сверка не выполнялась: записей с блоком источника ${withSources}, локатора с номером строки ни одного`);
		if (unparsed.length) {
			say("");
			say(`ЛОКАТОР НЕ РАЗОБРАН: ${unparsed.length} - формат строки, сверка их не касалась`);
			for (const u of unparsed) say(`  ${u}`);
		}
		if (problems.length) {
			say("");
			for (const p of problems) say(p);
		}
		if (options.fix && moves.length) {
			const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
			const write = deps.write ?? defaultWrite;
			const byFile = new Map<string, typeof moves>();
			for (const m of moves) {
				if (!byFile.has(m.r.path)) byFile.set(m.r.path, []);
				byFile.get(m.r.path)?.push(m);
			}
			for (const [path, ms] of byFile) {
				let text = read(path);
				for (const m of ms) text = text.replace(`\`${m.a.path}:${m.a.line}\``, `\`${m.a.path}:${m.to}\``);
				write(path, text);
			}
			say(`\nномера строк поправлены: ${moves.length}`);
			return done(0);
		}
		const bad = counts["не найдено"] + counts["файла нет"] + counts["корень не объявлен"];
		return done(bad ? 1 : (counts["сдвинулось"] + counts["короткий фрагмент"] ? 2 : 0));
	}

	if (action === "lint") {
		const rooted = (schema.reference_roots ?? []).length;
		const verify = rooted ? (a: Anchor) => verifyAnchor(a, schema, deps) : null;
		const findings = lint({ records, files, schema, indexed: plan.indexed, verify });
		say(formatFindings(findings, options.all ? Infinity : Number(options.limit ?? 40)));
		// Чистый линт без сверки и чистый линт со сверкой - разные утверждения, а выглядят одинаково:
		// проверка K016 при пустых корнях не выполняется вовсе, и записи с битым локатором проходят
		if (!rooted) say("\nякоря не проверялись: reference_roots не объявлен в SCHEMA.md - K016 выключен");
		const errors = findings.filter((f) => f.level === ERROR).length;
		return done(errors ? 1 : (findings.length ? 2 : 0));
	}

	if (action === "pairs") {
		// Кандидаты на смысловую сверку: записи, говорящие об одном предмете из разных мест.
		// Машина отбирает пары, судит модель - иначе ей пришлось бы читать раздел целиком.
		const byKey = new Map<string, WikiRecord[]>();
		for (const r of records) {
			if (!r.subject) continue;
			const key = r.subject.toLowerCase().replace(/[ёе]/g, "е");
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key)?.push(r);
		}
		const pairs = [...byKey.entries()].filter(([, rs]) => rs.length > 1);
		if (!pairs.length) return { text: "пар с общим предметом нет", code: 0 };
		say(`предметов с несколькими записями: ${pairs.length}`);
		for (const [subject, rs] of pairs.sort((a, b) => b[1].length - a[1].length)) {
			say(`\n${subject} (${rs.length})`);
			for (const r of rs) say(`  ${r.type.padEnd(16)} ${r.rel}#${r.anchor}`);
		}
		return done(0);
	}

	if (action === "stats") {
		const bySection: Record<string, number> = {};
		const byType: Record<string, number> = {};
		let anchored = 0;
		let verified = 0;
		for (const r of records) {
			bySection[r.section] = (bySection[r.section] ?? 0) + 1;
			if (r.type) byType[r.type] = (byType[r.type] ?? 0) + 1;
			if (r.anchors.length) anchored++;
			if (r.verified) verified++;
		}
		say(`корень: ${root}`);
		say(`записей: ${records.length}, файлов: ${files.length}`);
		say("разделы:");
		for (const [k, v] of Object.entries(bySection).sort((a, b) => b[1] - a[1])) say(`  ${String(v).padStart(4)}  ${k}`);
		say("типы:");
		for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) say(`  ${String(v).padStart(4)}  ${k}`);
		say(`с якорями: ${anchored}, со сверкой: ${verified}`);
		// «с якорями: 0» читается как «якорей не заводили», а не как «сверка выключена»: без корней
		// verify не проверяет ни одного локатора, и номера строк живут в записях непроверенными
		if (!(schema.reference_roots ?? []).length) {
			say("якоря не сверяются: reference_roots не объявлен в SCHEMA.md (сверка выключена целиком)");
		}
		const limits: WikiLimits = { ...DEFAULTS.limits, ...(schema.limits ?? {}) };
		const big = files.filter((f) => f.lines > limits.file_lines);
		if (big.length) {
			say(`файлы сверх порога ${limits.file_lines} строк:`);
			for (const f of big) say(`  ${f.lines}  ${f.rel}`);
		}
		if (plan.sharded.length) say(`указатели шардированы ${plan.axis}: ${plan.sharded.join(", ")}`);
		return done(0);
	}

	return { text: `неизвестное действие: ${action}`, code: 3 };
}

export { walkFiles };
