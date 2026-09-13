/**
 * Сборка указателей вики. Указатель - маршрутизатор, а не контейнер: строка на каждую ссылку,
 * колонки «предмет», «тип» и «этапы» существуют затем, чтобы этап отбирал строку, не открывая
 * файл, - и одинаково у ссылки на вывод и у ссылки на соседний указатель.
 *
 * Шардирование обязательно, а не опционально: при тысячах записей плоский указатель нежизнеспособен.
 * Ось дробления задаёт проект в `SCHEMA.md` ключом `index.shard_by`, потому что осей две и выбор
 * между ними - свойство корпуса, а не инструмента. `stage` (по умолчанию) режет по этапу флоу:
 * этап открывает свою секцию. `topic` режет по узлам раздела и делает это рекурсивно, пока
 * узел не уместится в порог: получается дерево, по которому задача спускается к одному листу,
 * читая по дороге только оглавления.
 *
 * Все указатели раздела лежат в корне самого раздела и различаются суффиксом имени
 * (`reference/INDEX-ui-tabs.md`), а не подкаталогом: раздел задан каталогом, повторять его в
 * имени незачем, зато ссылка на запись становится одним именем файла вместо цепочки `../`.
 */
import { DEFAULTS, nodeOfRel, type WikiLimits, type WikiRecord, type WikiSchema } from "./wiki.ts";

const HINT = [
	"Строка на ссылку. Колонки «предмет», «тип» и «этапы» существуют затем, чтобы строка",
	"отбиралась без открытия файла. Файл собирается инструментом, ручные правки будут затёрты.",
];

const ROUTE_HINT = [
	"Маршрут выбирается по колонкам «предмет», «тип» и «описание»: открывать нужно один узел,",
	"а не раздел. Подходит несколько - открывать по одному, начиная с ближайшего к задаче.",
];

const HEAD = ["| Куда | Вид | Предмет | Тип | Этапы | Описание |", "|---|---|---|---|---|---|"];

export const INDEX_DEFAULTS = { shard_by: ["stage"], topic_depth: 1 };

/**
 * Относительная ссылка из файла указателя на файл записи. Адреса записей хранятся от корня вики,
 * а указатель лежит в корне своего раздела, поэтому в плоской раскладке ссылка сводится к имени
 * файла - ради этого раскладка и выпрямлена.
 */
function relLink(fromRel: string, toRel: string): string {
	const from = fromRel.split("/").slice(0, -1);
	const to = toRel.split("/");
	let i = 0;
	while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
	return [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
}

/** Строка-ссылка на вывод: заголовок ведёт прямо к секции записи. */
function recordRow(r: WikiRecord, fromRel: string): string {
	return `| [${r.heading}](${relLink(fromRel, r.rel)}#${r.anchor}) | вывод | ${r.subject || "-"} | ${r.type || "-"} | ${r.stages.join(", ") || "-"} | - |`;
}

/** Строка-ссылка на соседний указатель: те же колонки, но сведённые по всем записям ветки. */
function nodeRow(
	name: string,
	rows: WikiRecord[],
	target: string,
	fromRel: string,
	order: string[],
	topics: Record<string, string>,
	fallbackDesc = "",
): string {
	const desc = topics?.[name] ?? (fallbackDesc || "-");
	return `| [${name}](${relLink(fromRel, target)}) | узел · ${rows.length} | ${subjectsOf(rows, 3).join(", ") || "-"} | ${typesOf(rows, 3).join(", ") || "-"} | ${stagesOf(rows, order).join(", ") || "-"} | ${desc} |`;
}

/**
 * Этапы записей в порядке флоу; неизвестные уходят в конец. Позиция неизвестного берётся за концом
 * списка, а не арифметикой по модулю: формула `(indexOf + 99) % 100` уводила в хвост заодно и
 * первый этап флоу - `intake` вставал в колонке и в оглавлении после `close`.
 */
function stagesOf(rows: WikiRecord[], order: string[]): string[] {
	const at = (stage: string) => {
		const index = order.indexOf(stage);
		return index < 0 ? order.length : index;
	};
	return [...new Set(rows.flatMap((r) => r.stages))].sort((a, b) => at(a) - at(b));
}

/** Предметы узла, частые первыми: по ним выбирают ветку, не открывая её. */
function subjectsOf(rows: WikiRecord[], take = 5): string[] {
	const n: Record<string, number> = {};
	for (const r of rows) if (r.subject) n[r.subject] = (n[r.subject] ?? 0) + 1;
	return Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
		.slice(0, take).map(([s]) => s);
}

/** Типы выводов ветки с частотой: сразу видно, чего в ней ждать - гейтов или расхождений. */
function typesOf(rows: WikiRecord[], take = 3): string[] {
	const n: Record<string, number> = {};
	for (const r of rows) if (r.type) n[r.type] = (n[r.type] ?? 0) + 1;
	return Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
		.slice(0, take).map(([t, c]) => (c > 1 ? `${t} ×${c}` : t));
}

/**
 * Помещается ли указатель. Порогов два, и главный - в байтах: строка указателя весит около
 * трёхсот знаков, поэтому счёт строк пропускал лист на шестьдесят килобайт, а платит за него
 * тот, кто его открыл.
 */
function fits(lines: string[], limits: WikiLimits): boolean {
	// Байты, а не символы: указатель почти весь кириллический, и в utf-8 он вдвое тяжелее,
	// чем кажется по длине строки
	return lines.length <= limits.index_file_lines
		&& Buffer.byteLength(lines.join("\n"), "utf8") <= limits.index_file_bytes;
}

/** Выводы листа идут по предмету, а внутри предмета по заголовку: соседние строки об одном. */
function bySubject(rows: WikiRecord[]): WikiRecord[] {
	return [...rows].sort((a, b) => String(a.subject).localeCompare(String(b.subject), "ru")
		|| a.heading.localeCompare(b.heading, "ru"));
}

/** Тело листа: одна таблица на все выводы узла, этап - колонкой, а не секцией. */
function leafBody(title: string, rows: WikiRecord[], order: string[], rel: string): string[] {
	const body = [`# ${title}`, "", ...HINT, "", ...HEAD];
	for (const r of bySubject(rows)) body.push(recordRow(r, rel));
	return body;
}

/**
 * Резка листа на части по объёму. Порядок уже по предмету, поэтому граница ставится на его смене,
 * как только часть набрала большую долю порога: иначе части выходят механическими, и строка
 * оглавления «часть 2» не говорит ничего о том, что в ней.
 */
function splitByVolume(
	rows: WikiRecord[],
	title: string,
	order: string[],
	limits: WikiLimits,
	partRel: string,
): WikiRecord[][] {
	const overhead = [`# ${title}: часть 1`, "", ...HINT, "", ...HEAD];
	const enough = (l: string[]) => l.join("\n").length > limits.index_file_bytes * 0.7
		|| l.length > limits.index_file_lines * 0.7;
	const parts: WikiRecord[][] = [];
	let cur: WikiRecord[] = [];
	let lines = [...overhead];
	for (const r of rows) {
		const row = recordRow(r, partRel);
		const subjectChanged = cur.length > 0 && cur[cur.length - 1].subject !== r.subject;
		if (cur.length && (!fits([...lines, row], limits) || (subjectChanged && enough(lines)))) {
			parts.push(cur);
			cur = [];
			lines = [...overhead];
		}
		cur.push(r);
		lines.push(row);
	}
	if (cur.length) parts.push(cur);
	return parts;
}

export interface IndexFile {
	rel: string;
	text: string;
}

export interface IndexPlan {
	files: IndexFile[];
	/** Якоря записей, у которых есть этапы: их ждёт проверка K001. */
	indexed: Set<string>;
	sharded: string[];
	/** Запись -> лист указателя, в который она попала. */
	placed: Map<string, string>;
	shardBy: string[];
	axis: string;
}

/**
 * Планирует содержимое указателей, ничего не записывая: возвращает список файлов, множество
 * адресов записей, попавших в указатель (его ждёт проверка K001), и карту «запись -> лист
 * указателя», по которой команда `route` называет маршрут.
 */
export function planIndexes(records: WikiRecord[], schema: WikiSchema = DEFAULTS): IndexPlan {
	const limits: WikiLimits = { ...DEFAULTS.limits, ...(schema.limits ?? {}) };
	const order = schema.stages ?? DEFAULTS.stages;
	const idx = { ...INDEX_DEFAULTS, ...(schema.index ?? {}) };
	const shardBy = idx.shard_by ?? INDEX_DEFAULTS.shard_by;
	const topics = schema.topics ?? {};
	const topicFirst = shardBy[0] === "topic";
	const byStageToo = !topicFirst || shardBy.includes("stage");
	const bySection: Record<string, WikiRecord[]> = {};
	for (const r of records) (bySection[r.section] ??= []).push(r);

	const files: IndexFile[] = [];
	const indexed = new Set<string>();
	const sharded: string[] = [];
	const placed = new Map<string, string>();

	const at = (r: WikiRecord) => `${r.rel}#${r.anchor}`;
	const nodeRel = (section: string, segs: string[]) =>
		(segs.length ? `${section}/INDEX-${segs.join("-")}.md` : `${section}/INDEX.md`);
	const nodeOfRecord = (r: WikiRecord) => r.node ?? nodeOfRel(r.rel, schema);

	/** Сегмент логического пути на глубине узла: имя подузла либо null, если запись лежит здесь. */
	const segmentAt = (r: WikiRecord, depth: number): string | null => {
		const node = nodeOfRecord(r);
		return depth < node.length ? node[depth] : null;
	};

	/**
	 * Подтема записи - имя её файла без пути узла (`templates`, `sides`, `geometry`). Это последняя
	 * смысловая ось дробления: файл собран из взаимно контекстных выводов, поэтому лист «по файлу»
	 * называет себя сам, в отличие от нумерованной части.
	 */
	const fileTag = (r: WikiRecord): string => {
		const base = (r.rel.split("/").pop() ?? "").replace(/\.md$/, "");
		const prefix = `${nodeOfRecord(r).join("-")}-`;
		return base.startsWith(prefix) ? base.slice(prefix.length) : base;
	};

	/**
	 * Лист: таблица выводов. Не помещается - режется по этапу (если этап объявлен осью), а то, что
	 * не помещается и после, - на части по объёму. Часть режется по границе предмета, поэтому её
	 * строка в оглавлении честно называет, о чём она, и выбор идёт по предмету, а не по номеру.
	 */
	function emitLeaf(section: string, segs: string[], rows: WikiRecord[], title: string, tail: string[] = []): void {
		const rel = nodeRel(section, [...segs, ...tail]);
		const body = leafBody(title, rows, order, rel);
		if (fits(body, limits)) {
			files.push({ rel, text: body.join("\n") });
			for (const r of rows) placed.set(at(r), rel);
			return;
		}
		if (byStageToo && !tail.length) {
			const toc = [`# ${title}`, "", "Узел разбит по этапам: превышен порог объёма указателя.", "", ...ROUTE_HINT, "", ...HEAD];
			for (const st of stagesOf(rows, order)) {
				const stRows = rows.filter((r) => r.stages.includes(st));
				if (!stRows.length) continue;
				emitLeaf(section, segs, stRows, `${title}: этап ${st}`, [`-${st}`]);
				toc.push(nodeRow(st, stRows, nodeRel(section, [...segs, `-${st}`]), rel, order, topics));
			}
			files.push({ rel, text: toc.join("\n") });
			return;
		}
		// Смысловая ось перед механической: подтемы-файлы называют себя, номера частей - нет
		const byFile = new Map<string, WikiRecord[]>();
		for (const r of rows) {
			const tag = fileTag(r);
			if (!byFile.has(tag)) byFile.set(tag, []);
			byFile.get(tag)?.push(r);
		}
		// Раскладка «файл на запись» подтем не образует: дробить по ней значит выдать лист на запись
		if (byFile.size > 1 && rows.length / byFile.size >= 2) {
			const toc = [`# ${title}`, "", "Узел разбит по подтемам: превышен порог объёма указателя.", "", ...ROUTE_HINT, "", ...HEAD];
			for (const [tag, fileRows] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"))) {
				emitLeaf(section, segs, fileRows, `${title}: ${tag}`, [...tail, `-${tag}`]);
				toc.push(nodeRow(tag, fileRows, nodeRel(section, [...segs, ...tail, `-${tag}`]), rel, order, topics,
					fileRows[0]?.fileTitle ?? ""));
			}
			files.push({ rel, text: toc.join("\n") });
			return;
		}
		const parts = splitByVolume(bySubject(rows), title, order, limits, nodeRel(section, [...segs, ...tail, "-1"]));
		const toc = [`# ${title}`, "", "Узел разбит на части: превышен порог объёма указателя.", "", ...ROUTE_HINT, "", ...HEAD];
		for (const [i, part] of parts.entries()) {
			const partRel = nodeRel(section, [...segs, ...tail, `-${i + 1}`]);
			files.push({ rel: partRel, text: leafBody(`${title}: часть ${i + 1}`, part, order, partRel).join("\n") });
			for (const r of part) if (!placed.has(at(r))) placed.set(at(r), partRel);
			toc.push(nodeRow(`часть ${i + 1}`, part, partRel, rel, order, topics));
		}
		files.push({ rel, text: toc.join("\n") });
	}

	/** Узел дерева: помещается - лист, не помещается - оглавление по подузлам и рекурсия. */
	function emitNode(section: string, segs: string[], rows: WikiRecord[]): void {
		const title = segs.length ? `Указатель ${section}: ${segs.join("/")}` : `Указатель раздела ${section}`;
		const rel = nodeRel(section, segs);
		if (fits(leafBody(title, rows, order, rel), limits)) {
			emitLeaf(section, segs, rows, title);
			return;
		}
		// Цепочка из одного подузла промежуточного оглавления не заслуживает: спускаемся молча
		let path = segs;
		let groups = groupBySegment(rows, path.length);
		while (groups.size === 1 && !groups.has(null)) {
			path = [...path, [...groups.keys()][0] as string];
			groups = groupBySegment(rows, path.length);
		}
		if (groups.size === 0 || (groups.size === 1 && groups.has(null))) {
			emitLeaf(section, path, rows, title);
			return;
		}
		const nodeRelHere = nodeRel(section, path);
		const head = [`# ${title}`, "", "Узел разбит по темам: превышен порог объёма указателя.", "", ...ROUTE_HINT, "", ...HEAD];
		const nodeRows: string[] = [];
		const ownRows = groups.get(null) ?? [];
		for (const [seg, rs2] of [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "ru"))) {
			if (seg === null) continue;
			emitNode(section, [...path, seg], rs2);
			nodeRows.push(nodeRow(seg, rs2, nodeRel(section, [...path, seg]), nodeRelHere, order, topics));
		}
		// Записи самого уровня - строками той же таблицы: отдельный узел под них ничего не объясняет,
		// а лишний переход стоит открытия файла. Не поместились - только тогда выносим листом
		const own = [...ownRows].sort((a, b) => a.heading.localeCompare(b.heading, "ru"))
			.map((r) => recordRow(r, nodeRelHere));
		if (ownRows.length && fits([...head, ...nodeRows, ...own], limits)) {
			for (const r of ownRows) placed.set(at(r), nodeRelHere);
			files.push({ rel: nodeRelHere, text: [...head, ...nodeRows, ...own].join("\n") });
		} else {
			if (ownRows.length) {
				const leafSegs = [...path, "_"];
				emitLeaf(section, leafSegs, ownRows, `${title}: записи узла`);
				nodeRows.push(nodeRow("(записи узла)", ownRows, nodeRel(section, leafSegs), nodeRelHere, order, topics));
			}
			files.push({ rel: nodeRelHere, text: [...head, ...nodeRows].join("\n") });
		}
		// Оглавление сжатой цепочки: путь к нему должен быть виден из корня раздела
		if (nodeRelHere !== rel) {
			files.push({
				rel,
				text: [`# ${title}`, "", "Узел содержит единственную ветку.", "", ...HEAD,
					nodeRow(path.slice(segs.length).join("/"), rows, nodeRelHere, rel, order, topics)].join("\n"),
			});
		}
	}

	function groupBySegment(rows: WikiRecord[], depth: number): Map<string | null, WikiRecord[]> {
		const g = new Map<string | null, WikiRecord[]>();
		for (const r of rows) {
			const seg = segmentAt(r, depth);
			if (!g.has(seg)) g.set(seg, []);
			g.get(seg)?.push(r);
		}
		return g;
	}

	for (const [section, rs] of Object.entries(bySection)) {
		for (const r of rs) if (r.stages.length) indexed.add(at(r));
		const flatRel = `${section}/INDEX.md`;
		const flat = leafBody(`Указатель раздела ${section}`, rs, order, flatRel);
		if (fits(flat, limits)) {
			files.push({ rel: flatRel, text: flat.join("\n") });
			for (const r of rs) placed.set(at(r), flatRel);
			continue;
		}
		sharded.push(section);
		if (topicFirst) {
			emitNode(section, [], rs);
			continue;
		}
		const toc = [`# Указатель раздела ${section}`, "",
			"Указатель разбит по этапам: превышен порог объёма. Этап открывает только свой файл.", "",
			...ROUTE_HINT, "", ...HEAD];
		for (const st of stagesOf(rs, order)) {
			const rows = rs.filter((r) => r.stages.includes(st));
			if (!rows.length) continue;
			const rel = nodeRel(section, [`-${st}`]);
			files.push({ rel, text: leafBody(`Указатель раздела ${section}: этап ${st}`, rows, order, rel).join("\n") });
			for (const r of rows) if (!placed.has(at(r))) placed.set(at(r), rel);
			toc.push(nodeRow(st, rows, rel, flatRel, order, topics));
		}
		files.push({ rel: flatRel, text: toc.join("\n") });
	}

	const root = ["# Указатель", "", "Оглавление разделов. Содержание - в указателе раздела.", "", ...HEAD];
	for (const [section, rs] of Object.entries(bySection).sort()) {
		root.push(nodeRow(section, rs, `${section}/INDEX.md`, "INDEX.md", order, topics));
	}
	files.push({ rel: "INDEX.md", text: root.join("\n") });

	// shardBy отдаётся наружу, а не пересчитывается потребителем по схеме: иначе напечатанная ось
	// разойдётся с той, по которой план построен, - и разойдётся молча, при первой правке логики
	return { files, indexed, sharded, placed, shardBy, axis: axisName(shardBy) };
}

/** Ось дробления по-человечески: её печатают там, где решение принято инструментом, а не планом. */
export function axisName(shardBy: string[] = INDEX_DEFAULTS.shard_by): string {
	const names: Record<string, string> = { stage: "по этапам", topic: "по темам" };
	return shardBy.map((s) => names[s] ?? s).join(" и ");
}

/** Слова текста, годные для сопоставления: три буквы и длиннее, регистр снят. */
export function keywords(text: string): string[] {
	return [...new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
}

// Только для match(): у общего регулярного выражения с флагом g живёт lastIndex, и test/exec
// по нему через вызов начали бы отдавать разное на одном входе
const WORD_RE = /[\p{L}\p{N}]{3,}/gu;

/** Приведение текста к виду для сопоставления: регистр снят, «ё» и «е» не различаются. */
function normText(s: string | undefined): string {
	return String(s ?? "").toLowerCase().replace(/ё/g, "е");
}

/** Длина общего начала двух слов. */
function commonPrefix(a: string, b: string): number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i;
}

/**
 * Совпадение слова запроса со словом текста по общей ОСНОВЕ: словоформа меняет хвост, а начало
 * оставляет. Без этого указатель находил записи только теми словами, которыми их писали: предмет
 * «порог указателя» не отвечал на «указатель», предмет «профиль проекта» - на «профили проекта».
 *
 * Порог общего начала - пять знаков, а не четыре: на четырёх совпадают `порог` с `породой`
 * и `работа` с `рабочим`. Поэтому короткое слово и имя собственное (`ntfy`) основой не ищутся
 * вовсе - для них остаётся точное вхождение, и это правильно: имя канала ищут буквально.
 */
function stemHit(text: string, word: string): boolean {
	for (const token of normText(text).match(WORD_RE) ?? []) {
		const shared = commonPrefix(token, word);
		if (shared >= 5 && shared >= Math.min(token.length, word.length) - 2) return true;
	}
	return false;
}

/** Слово запроса в тексте: сначала точное вхождение, затем общая основа. */
function wordHit(text: string, word: string): boolean {
	return normText(text).includes(word) || stemHit(text, word);
}

/**
 * Доля лучшего веса, ниже которой совпадение маршрутом не выдаётся. Слабое совпадение годится,
 * когда сильного нет вовсе («шардирование указателя» находит смежные записи об указателе, потому
 * что записи ровно про это в корпусе нет), и становится шумом, когда сильное есть: без отсева
 * запрос «указатели вики» отдавал семь записей из тридцати шести - всем, у кого в предмете есть
 * частое слово «вики», - и вместо одного узла приходилось открывать раздел.
 */
const ROUTE_TAIL = 0.6;

export interface ScoredDir {
	dir: string;
	rows: WikiRecord[];
	score: number;
	covered: string[];
	coverage: number;
	segments: number;
	segmentHits: number;
	segmentCoverage: number;
}

/**
 * Сопоставление текста с деревом узлов вики: одно ядро на два входа - «куда положить новую
 * запись» и «какой указатель открыть под задачу». Вес считается по сегментам логического пути
 * (они и есть тема), по описанию темы из `SCHEMA.md`, по предметам и заголовкам записей узла.
 */
export function matchDirs(
	records: WikiRecord[],
	text: string,
	schema: WikiSchema = DEFAULTS,
): { words: string[]; dirs: ScoredDir[] } {
	const topics = schema.topics ?? {};
	const words = keywords(text);
	const byDir = new Map<string, WikiRecord[]>();
	for (const r of records) {
		const dir = [r.section, ...(r.node ?? nodeOfRel(r.rel, schema))].join("/");
		if (!byDir.has(dir)) byDir.set(dir, []);
		byDir.get(dir)?.push(r);
	}
	const scored: ScoredDir[] = [];
	for (const [dir, rows] of byDir) {
		const segs = dir.split("/");
		const segText = segs.join(" ").toLowerCase();
		const topicText = segs.map((s) => topics[s] ?? "").join(" ").toLowerCase();
		const subjText = rows.map((r) => r.subject ?? "").join(" ").toLowerCase();
		const headText = rows.map((r) => r.heading ?? "").join(" ").toLowerCase();
		let score = 0;
		const covered: string[] = [];
		for (const w of words) {
			// Сегмент пути весит больше предмета: он и есть заявленная тема узла, а предмет - частность
			const s = (segText.includes(w) ? 4 : 0) + (topicText.includes(w) ? 3 : 0)
				+ (subjText.includes(w) ? 2 : 0) + (headText.includes(w) ? 1 : 0);
			if (s) {
				score += s;
				covered.push(w);
			}
		}
		// Доля покрытых слов запроса на живой фразе всегда мала: в ней полно слов не про тему.
		// Узнан узел или нет, показывают его собственные сегменты - сколько из них назвала задача
		const own = segs.slice(1);
		const hitSegs = own.filter((s) => words.some((w) => s.toLowerCase().includes(w) || String(topics[s] ?? "").toLowerCase().includes(w)));
		if (score) {
			scored.push({
				dir,
				rows,
				score,
				covered,
				coverage: covered.length / (words.length || 1),
				segments: own.length,
				segmentHits: hitSegs.length,
				segmentCoverage: own.length ? hitSegs.length / own.length : 0,
			});
		}
	}
	scored.sort((a, b) => b.segmentHits - a.segmentHits || b.score - a.score || a.dir.localeCompare(b.dir, "ru"));
	return { words, dirs: scored };
}

export interface PlacementPlan {
	words: string[];
	dir: string | null;
	score: number;
	coverage: number;
	segmentHits: number;
	confident: boolean;
	alternatives: { dir: string; score: number }[];
	suggestion: { dir: string; parent: string; name: string | null; unmatched: string[] } | null;
}

/**
 * Куда положить новую запись. Возвращает подходящий узел существующей иерархии, а когда такого
 * нет - предложение завести узел: родителем берётся ближайший частично совпавший, именем
 * слово задачи, которого в дереве ещё нет. Новая ветка заводится только на «не нашлось».
 */
export function planPlacement(
	records: WikiRecord[],
	text: string,
	schema: WikiSchema = DEFAULTS,
	opts: { minSegments?: number; minScore?: number } = {},
): PlacementPlan {
	const minSegments = opts.minSegments ?? 2;
	const minScore = opts.minScore ?? 6;
	const { words, dirs } = matchDirs(records, text, schema);
	const best = dirs[0];
	// Узел считается найденным, когда задача назвала его темы, а не отдельные слова записей
	const confident = Boolean(best) && best.score >= minScore
		&& best.segmentHits >= Math.min(minSegments, best.segments);
	const result: PlacementPlan = {
		words,
		dir: best?.dir ?? null,
		score: best?.score ?? 0,
		coverage: best ? Number(best.coverage.toFixed(2)) : 0,
		segmentHits: best?.segmentHits ?? 0,
		confident,
		alternatives: dirs.slice(1, 4).map((d) => ({ dir: d.dir, score: d.score })),
		suggestion: null,
	};
	if (confident) return result;
	// Родителем нового узла годится только тот, чью тему задача действительно назвала: иначе
	// ветка прирастает к случайному соседу и дерево перестаёт что-либо значить
	const near = best && best.segmentHits >= 1 ? best.dir : null;
	const parent = near ?? best?.dir.split("/")[0] ?? [...new Set(records.map((r) => r.section))].sort()[0] ?? "reference";
	const known = new Set(records.flatMap((r) => [...r.rel.split("/"), ...(r.node ?? [])])
		.map((s) => s.replace(/\.md$/, "").toLowerCase()));
	const fresh = words.filter((w) => !known.has(w));
	// Имя узла не выдумывается за человека: латинское слово предложить можно, кириллицу - нет,
	// потому что узлы именуются латиницей и одним словом
	const name = fresh.find((w) => /^[a-z0-9-]+$/.test(w)) ?? null;
	result.suggestion = { dir: name ? `${parent}/${name}` : `${parent}/<новый узел>`, parent, name, unmatched: fresh.slice(0, 6) };
	return result;
}

export interface RouteHit {
	r: WikiRecord;
	score: number;
	at: string;
	index: string | undefined;
}

export interface Route {
	rel: string;
	score: number;
	count: number;
	subjects: string[];
}

/**
 * Маршрут к записям по словам задачи. Считает вес совпадения по предмету, заголовку, пути и типу,
 * складывает его по листам указателя и возвращает ветки, которые стоит открыть, - вместе с самими
 * записями, попавшими в счёт.
 */
export function planRoute(
	records: WikiRecord[],
	query: string,
	schema: WikiSchema = DEFAULTS,
	take = 5,
): { words: string[]; routes: Route[]; hits: RouteHit[] } {
	const { placed } = planIndexes(records, schema);
	const words = normText(query).match(WORD_RE) ?? [];
	if (!words.length) return { words, routes: [], hits: [] };
	const all: RouteHit[] = [];
	for (const r of records) {
		let score = 0;
		const matched: string[] = [];
		for (const w of words) {
			const inSubject = wordHit(r.subject, w);
			const inHeading = wordHit(r.heading, w);
			const inPath = wordHit(r.rel, w);
			const inType = wordHit(r.type, w);
			const s = (inSubject ? 3 : 0) + (inHeading ? 2 : 0) + (inPath ? 2 : 0) + (inType ? 1 : 0);
			if (s) {
				score += s;
				matched.push(w);
			}
		}
		// Совпадение по одному слову из многих - обычно шум, поэтому нужны два слова. Исключение -
		// вес от трёх: столько даёт попадание в предмет (он и есть заявленный ключ отбора) либо
		// совпадение сразу и в заголовке, и в имени файла. Одного такого слова довольно: без
		// исключения запрос «шардирование указателя» не находил ничего - слова «шардирование» в
		// корпусе нет вовсе, а «указателя» одного не хватало на порог
		if (score && (matched.length >= Math.min(2, words.length) || score >= 3)) {
			all.push({ r, score, at: `${r.rel}#${r.anchor}`, index: placed.get(`${r.rel}#${r.anchor}`) });
		}
	}
	// Хвост отсеивается относительно лучшего, а не по абсолютному порогу: на разных запросах вес
	// сильного совпадения разный, и постоянное число либо режет всё, либо не режет ничего
	const best = all.reduce((m, h) => Math.max(m, h.score), 0);
	const hits = all.filter((h) => h.score >= best * ROUTE_TAIL);
	hits.sort((a, b) => b.score - a.score || a.at.localeCompare(b.at, "ru"));
	const byIndex = new Map<string, { rel: string; score: number; rows: WikiRecord[] }>();
	for (const h of hits) {
		const key = h.index ?? "(вне указателя)";
		if (!byIndex.has(key)) byIndex.set(key, { rel: key, score: 0, rows: [] });
		const e = byIndex.get(key);
		if (!e) continue;
		e.score += h.score;
		e.rows.push(h.r);
	}
	const routes = [...byIndex.values()].sort((a, b) => b.score - a.score).slice(0, take)
		.map((e) => ({ rel: e.rel, score: e.score, count: e.rows.length, subjects: subjectsOf(e.rows, 4) }));
	return { words, routes, hits: hits.slice(0, take * 3) };
}
