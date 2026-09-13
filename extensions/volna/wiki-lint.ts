/**
 * Структурные проверки вики выводов. Детерминированные, без модели: их можно гонять часто.
 * Единица проверки - запись, а не файл: в плотных разделах запись это секция `##`.
 *
 * Находки делятся на ошибки и предупреждения, потому что на тысячах записей сплошной список
 * нечитаем. Запись вправе объявить осознанное исключение полем «линт».
 */
import {
	type Anchor,
	type AnchorCheck,
	DEFAULTS,
	field,
	fieldLong,
	unparsedLocators,
	type WikiFile,
	type WikiLimits,
	type WikiRecord,
	type WikiSchema,
} from "./wiki.ts";

const ERROR = "ошибка";
const WARN = "предупр.";

export type FindingLevel = typeof ERROR | typeof WARN;

export interface Finding {
	code: string;
	level: FindingLevel;
	at: string;
	what: string;
	fix: string;
}

/** Одна находка: код, уровень, адрес, что не так и что сделать. */
function finding(code: string, level: FindingLevel, at: string, what: string, fix: string): Finding {
	return { code, level, at, what, fix };
}

/** Объявлено ли в записи исключение для этого кода. */
function suppressed(record: WikiRecord, code: string): boolean {
	const v = field(record.body, "линт");
	return typeof v === "string" && v.includes(code);
}

export interface LintInput {
	records: WikiRecord[];
	files: WikiFile[];
	schema?: WikiSchema;
	/** Якоря, на которые есть строка в каком-либо указателе. Не передан - K001 не проверяется. */
	indexed?: Set<string> | null;
	/** Сверка якоря, если она доступна: иначе якоря не проверяются. */
	verify?: ((anchor: Anchor) => AnchorCheck) | null;
}

/**
 * Проверки корпуса. indexed - множество якорей, на которые есть строка в каком-либо указателе;
 * verify - функция сверки якоря, если она доступна (иначе якоря не проверяются).
 */
export function lint({ records, files, schema = DEFAULTS, indexed = null, verify = null }: LintInput): Finding[] {
	const out: Finding[] = [];
	const push = (r: WikiRecord, f: Finding) => {
		if (!suppressed(r, f.code)) out.push(f);
	};
	const limits: WikiLimits = { ...DEFAULTS.limits, ...(schema.limits ?? {}) };
	const types = new Set(schema.types ?? DEFAULTS.types);
	const stages = new Set(schema.stages ?? DEFAULTS.stages);
	const sections = schema.sections ?? DEFAULTS.sections;
	const topics = schema.topics ?? {};
	// Достижимость записи обеспечивает указатель, а не связи, поэтому поиск сирот выключен по
	// умолчанию: на массово извлечённом корпусе он даёт предупреждение почти на каждую запись
	const orphanCheck = schema.checks?.orphans === true;

	const anchorsOf = new Map<string, WikiRecord>();
	for (const r of records) {
		const base = r.rel.replace(/\.md$/, "").split("/").pop() ?? "";
		anchorsOf.set(`${base}#${r.anchor}`, r);
		anchorsOf.set(r.anchor, r);
		// В раскладке «файл на запись» ссылка идёт по имени файла, а не по заголовку; для файла
		// подтемы голое имя неоднозначно - там нужен якорь секции
		if (!r.sectioned) anchorsOf.set(base, r);
	}
	const incoming = new Map<WikiRecord, number>();
	for (const r of records) {
		for (const l of r.links) {
			const target = anchorsOf.get(l.toLowerCase());
			if (target) incoming.set(target, (incoming.get(target) ?? 0) + 1);
		}
	}

	const seen = new Map<string, string>();
	for (const r of records) {
		const at = `${r.rel}#${r.anchor}`;

		if (indexed && !indexed.has(at)) {
			push(r, finding("K001", ERROR, at, "запись не попала ни в один указатель", "пересобрать указатели"));
		}
		for (const l of r.links) {
			if (!anchorsOf.has(l.toLowerCase())) {
				push(r, finding("K003", ERROR, at, `связь [[${l}]] не разрешается`, "поправить якорь или завести запись"));
			}
		}
		if (orphanCheck && (incoming.get(r) ?? 0) === 0) {
			push(r, finding("K004", WARN, at, "сирота: ни одной входящей связи", "сослаться из смежной записи"));
		}
		for (const name of ["тип", "предмет", "этапы", "вывод"]) {
			if (!r.has(name)) push(r, finding("K005", ERROR, at, `нет обязательного поля «${name}»`, "дописать поле"));
		}
		if (!r.sectioned && r.has("раздел")) {
			const declared = field(r.body, "раздел");
			if (declared && declared !== r.section) {
				push(r, finding("K006", ERROR, at, `раздел «${declared}» не совпадает с каталогом «${r.section}»`, "перенести файл или поправить поле"));
			}
		}
		if (r.type && !types.has(r.type)) {
			push(r, finding("K007", ERROR, at, `тип «${r.type}» вне закрытого списка`, "выбрать тип из списка или расширить соглашения"));
		}
		for (const st of r.stages) {
			if (!stages.has(st)) push(r, finding("K008", ERROR, at, `этап «${st}» вне набора флоу`, "поправить перечень этапов"));
		}
		if (r.lines > limits.record_lines) {
			const hard = r.lines > limits.record_lines_hard;
			push(r, finding("K010", hard ? ERROR : WARN, at, `запись ${r.lines} строк при пороге ${limits.record_lines}`, "разделить на два вывода"));
		}
		const codeSection = sections[r.section]?.code;
		if (codeSection) {
			if (!r.anchors.length) {
				push(r, finding("K009", ERROR, at, "в кодовом разделе нет источников", "добавить локатор с номером строки"));
			}
			for (const a of r.anchors) {
				if (a.line == null && /\.(pas|cs|ts|tsx|py|go|java)$/i.test(a.path)) {
					push(r, finding("K009", ERROR, at, `локатор ${a.path} без номера строки`, "указать строку"));
				}
			}
		}
		// Неразобранный локатор в сверку не попадает вовсе, и запись выглядит проверенной (K023).
		for (const line of unparsedLocators(r.body)) {
			push(r, finding("K023", WARN, at, `локатор не разобран: ${line}`, "путь и цитата в обратных кавычках или «кавычках», между ними тире"));
		}
		if (r.heading && !/\s/.test(r.heading)) {
			push(r, finding("K011", WARN, at, "заголовок из одного слова: похоже на тему, а не на утверждение", "переписать заголовок утверждением"));
		}
		const key = `${r.type}|${r.subject}|${r.anchors[0]?.path ?? ""}`;
		if (r.type && r.subject) {
			if (seen.has(key)) push(r, finding("K012", WARN, at, `похоже на дубль записи ${seen.get(key)}`, "слить или развести предметы"));
			else seen.set(key, at);
		}
		if (r.lines && r.lines < limits.record_min_lines) {
			push(r, finding("K014", WARN, at, `запись ${r.lines} строк: заготовка, выданная за знание`, "дописать или удалить"));
		}
		if (codeSection && !r.verified) {
			push(r, finding("K015", WARN, at, "нет отметки о сверке якорей", "прогнать verify"));
		}
		if (r.type === "конфликт" && !r.has("разрешено") && !r.has("разрешить") && !r.has("эскалация")) {
			push(r, finding("K017", WARN, at, "конфликт без плана разрешения", "дописать «разрешить» с адресом исследования"));
		}
		// Постмортем без «страховки» - рассказ о дефекте без урока. Жанр существует ради ответа
		// на вопрос «что теперь ловит этот класс ошибок»: без него запись не отличается от истории
		// в логе задачи, которую никто не перечитывает.
		if (r.type === "постмортем" && !r.has("страховка")) {
			push(r, finding("K024", ERROR, at, "постмортем без страховки", "назвать проверку или правило, которое теперь ловит этот класс"));
		}
		const byRule = /правилом/.test(fieldLong(r.body, "разрешено") ?? "");
		if (r.has("разрешено") && !r.has("арбитр") && !byRule) {
			push(r, finding("K018", ERROR, at, "разрешение без арбитра", "добавить якоря, доказывающие исход"));
		}
		// Поле «разрешить» снимает проверку так же, как «разрешено» и «эскалация» (см. K017): исход
		// уже назначен, и переклеивать тип поздно. Вторая сторона конфликта бывает решением человека,
		// а у решения якоря нет и быть не может - тогда эвристика видит два кодовых якоря и советует
		// «расхождение», хотя код прямо признан неверным и обязан уйти
		if (r.type === "конфликт" && r.anchors.length >= 2
			&& !r.has("эскалация") && !r.has("разрешено") && !r.has("разрешить")) {
			const codeAnchors = r.anchors.filter((a) => a.line != null);
			if (codeAnchors.length === r.anchors.length && new Set(codeAnchors.map((a) => a.path)).size >= 1
				&& codeAnchors.length >= 2 && !r.has("область")) {
				push(r, finding("K019", WARN, at, "оба якоря - живой код: вероятно расхождение областей, а не конфликт", "сменить тип на «расхождение» и добавить область"));
			}
		}
		// Вывод бывает именно про отключённый код - тогда цитата комментария законна и есть по сути
		const aboutDisabled = /закомментирован|отключен|отключён|мёртв|не работает|никогда не строится/i
			.test(fieldLong(r.body, "вывод") ?? "");
		if (!aboutDisabled && r.anchors.length && r.anchors.every((a) => /^\s*\/\//.test(a.quote) || /^\s*\{/.test(a.quote))) {
			push(r, finding("K020", WARN, at, "единственный источник - закомментированная строка", "закомментированный код не источник действующего поведения"));
		}
		if (r.has("эскалация") && !/#\d|\.md/.test(fieldLong(r.body, "эскалация") ?? "")) {
			push(r, finding("K021", WARN, at, "эскалация без адреса", "назвать задачу или документ"));
		}
		// Узел без описания молча теряет колонку «описание» в указателе, и ветку выбирают вслепую;
		// в плоской раскладке он вдобавок не опознаётся в имени файла и уровнем не становится вовсе
		for (const seg of (Object.keys(topics).length ? r.node ?? [] : [])) {
			if (!topics[seg]) {
				push(r, finding("K022", WARN, at, `узел «${seg}» не описан в SCHEMA.md`, "дописать описание темы в ключ topics"));
			}
		}
		if (verify) {
			for (const a of r.anchors) {
				const v = verify(a);
				if (v.verdict === "не найдено" || v.verdict === "файла нет") {
					push(r, finding("K016", ERROR, at, `якорь ${a.path}:${a.line} - ${v.verdict}`, "перепроверить цитату"));
				}
			}
		}
	}

	for (const f of files) {
		if (f.lines > limits.file_lines) {
			const hard = f.lines > limits.file_lines_hard;
			out.push(finding("K010", hard ? ERROR : WARN, f.rel, `файл ${f.lines} строк при пороге ${limits.file_lines}`, "разделить подтему"));
		}
	}
	const perFile = new Map<string, boolean>();
	for (const r of records) {
		if (!r.sectioned) continue;
		const key = `${r.rel}#${r.anchor}`;
		if (perFile.has(key)) out.push(finding("K013", ERROR, key, "повторяющийся заголовок секции: якорь неоднозначен", "переименовать одну из секций"));
		perFile.set(key, true);
	}
	return out;
}

/** Отчёт для человека: по уровню, затем по адресу, с лимитом на объём. */
export function formatFindings(findings: Finding[], limit = 40): string {
	if (!findings.length) return "линт: находок нет";
	const order: Record<string, number> = { [ERROR]: 0, [WARN]: 1 };
	const sorted = [...findings].sort((a, b) => (order[a.level] - order[b.level]) || a.at.localeCompare(b.at, "ru"));
	const shown = sorted.slice(0, limit);
	const lines: string[] = [];
	let level: string | null = null;
	for (const f of shown) {
		if (f.level !== level) {
			level = f.level;
			lines.push(`\n${level === ERROR ? "ОШИБКИ" : "ПРЕДУПРЕЖДЕНИЯ"}`);
		}
		lines.push(`  ${f.code}  ${f.at}  ${f.what}  ->  ${f.fix}`);
	}
	if (sorted.length > shown.length) lines.push(`\n  и ещё ${sorted.length - shown.length}`);
	const errors = sorted.filter((f) => f.level === ERROR).length;
	lines.push(`\nвсего: ${sorted.length}, ошибок: ${errors}, предупреждений: ${sorted.length - errors}`);
	return lines.join("\n").trim();
}

export { ERROR, WARN };
