/**
 * Вика выводов: разбор записи, сверка якорей с источником, сборка указателей, структурные
 * проверки и операции целиком. Проверяется то, что не зависит от модели: формат и арифметика.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initVolna } from "../extensions/volna/init.ts";
import { STAGE_NAMES, STAGES, stageInstructions } from "../extensions/volna/stages.ts";
import { DEFAULTS, field, loadSchema, parseAnchors, readRecords, unparsedLocators, verifyAnchor } from "../extensions/volna/wiki.ts";
import { planIndexes, planPlacement, planRoute } from "../extensions/volna/wiki-index.ts";
import { lint } from "../extensions/volna/wiki-lint.ts";
import { initWiki, runWiki, wikiRoot } from "../extensions/volna/wiki-ops.ts";
import { check, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	recordParsing();
	anchorVerification();
	indexPlanning();
	stageOrdering();
	lintFindings();
	operations();
	captureStage();
}

/** Запись в песочнице: каталог раздела заводится сам, путь возвращается целиком. */
function writeRecord(root: string, rel: string, text: string): string {
	const path = join(root, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf8");
	return path;
}

const RECORD = [
	"# Порог указателя считается в байтах, а не в строках",
	"",
	"**тип:** ограничение · **предмет:** порог указателя · **этапы:** capture",
	"",
	"**вывод:** строка указателя весит около трёхсот знаков, поэтому счёт строк пропускает лист",
	"на шестьдесят килобайт.",
	"",
	"**источник:**",
	"- `src/index.ts:3` — `const limit = 8000;`",
	"",
].join("\n");

/** Та же запись со связью: связь проверяется разбором, а линту висячая ссылка ни к чему. */
const LINKED_RECORD = `${RECORD}\n**связи:** [[wiki-record-is-one-claim]]\n`;

/** Поля, якорь и этапы читаются из записи; значение поля обрывается на разделителе строки. */
function recordParsing(): void {
	const dir = sandbox("wiki-parse");
	const root = join(dir, "wiki");
	writeRecord(root, "process/wiki-index-threshold.md", LINKED_RECORD);
	const { records, files } = readRecords(root);

	check("файл записи даёт одну запись", records.length === 1, String(records.length));
	const record = records[0];
	check("предмет читается без хвоста строки", record.subject === "порог указателя", record.subject);
	check("тип читается без хвоста строки", record.type === "ограничение", record.type);
	check("этапы разбираются в список", record.stages.join(",") === "capture", record.stages.join(","));
	check("якорь секции строится из заголовка", record.anchor.startsWith("порог-указателя-считается"), record.anchor);
	check("раздел берётся из каталога", record.section === "process", record.section);
	check("связь видна разбором", record.links[0] === "wiki-record-is-one-claim", record.links.join(","));
	check("файл посчитан один", files.length === 1, String(files.length));

	check("поле обрывается на разделителе", field("**тип:** гейт · **предмет:** формы", "тип") === "гейт");

	const locator = parseAnchors("- `src/index.ts:3` — `const limit = 8000;`")[0];
	check("локатор даёт путь, строку и цитату", locator?.path === "src/index.ts" && locator.line === 3 && locator.quote === "const limit = 8000;");
	const ascii = parseAnchors("- `src/index.ts:3` - «const limit = 8000;»")[0];
	check("дефис и «кавычки» - тот же локатор", ascii?.line === 3 && ascii.quote === "const limit = 8000;");
	check("нераспознанный локатор назван вслух", unparsedLocators("- `src/index.ts:3` без цитаты").length === 1);

	const schema = loadSchema(root);
	check("без SCHEMA.md берутся умолчания", schema.limits.record_lines === DEFAULTS.limits.record_lines);
	check("этапы умолчаний совпадают с флоу", schema.stages.join(",") === STAGE_NAMES.join(","), schema.stages.join(","));

	writeFileSync(join(root, "SCHEMA.md"), ["```yaml", "limits:", "  record_lines: 7", "topics:", "  wiki: вика выводов", "```", ""].join("\n"), "utf8");
	const merged = loadSchema(root);
	check("соглашения проекта поверх умолчаний", merged.limits.record_lines === 7, String(merged.limits.record_lines));
	check("незаданное из умолчаний остаётся", merged.limits.file_lines === DEFAULTS.limits.file_lines);
	check("реестр тем читается", merged.topics?.wiki === "вика выводов", String(merged.topics?.wiki));
}

/** Сверка якоря: совпадение, сдвиг, пропажа, короткий фрагмент и необъявленный корень. */
function anchorVerification(): void {
	const dir = sandbox("wiki-verify");
	const source = join(dir, "src");
	mkdirSync(source, { recursive: true });
	writeFileSync(join(source, "index.ts"), ["// шапка", "// вторая строка", "const limit = 8000;", ""].join("\n"), "utf8");
	const schema = { ...DEFAULTS, reference_roots: [{ root: dir.split("\\").join("/"), prefix: "", drift_window: 40 }] };

	check(
		"цитата на своей строке - точно",
		verifyAnchor({ path: "src/index.ts", line: 3, quote: "const limit = 8000;" }, schema).verdict === "точно",
	);
	const moved = verifyAnchor({ path: "src/index.ts", line: 1, quote: "const limit = 8000;" }, schema);
	check("цитата рядом - сдвиг с новым номером", moved.verdict === "сдвинулось" && moved.line === 3, `${moved.verdict} ${moved.line}`);
	check(
		"цитаты нет вовсе - не найдено",
		verifyAnchor({ path: "src/index.ts", line: 3, quote: "const limit = 9999;" }, schema).verdict === "не найдено",
	);
	check(
		"строка целиком совпала - длина не важна",
		verifyAnchor({ path: "src/index.ts", line: 1, quote: "// шапка" }, schema).verdict === "точно",
	);
	check(
		"короткий фрагмент доказательством не считается",
		verifyAnchor({ path: "src/index.ts", line: 3, quote: "limit" }, schema).verdict === "короткий фрагмент",
	);
	check(
		"файла нет - так и сказано",
		verifyAnchor({ path: "src/gone.ts", line: 3, quote: "const limit = 8000;" }, schema).verdict === "файла нет",
	);
	check(
		"без объявленного корня сверка не выполняется",
		verifyAnchor({ path: "src/index.ts", line: 3, quote: "const limit = 8000;" }, DEFAULTS).verdict === "корень не объявлен",
	);
	check("локатор без строки кодом не считается", verifyAnchor({ path: "docs/readme.md", line: null, quote: "x" }, schema).verdict === "не код");
}

/** Малый корпус собирается в плоский указатель; маршрут и место считаются по тому же дереву. */
function indexPlanning(): void {
	const dir = sandbox("wiki-index");
	const root = join(dir, "wiki");
	writeRecord(root, "process/wiki-index-threshold.md", RECORD);
	const { records } = readRecords(root);
	const plan = planIndexes(records);

	check("собран указатель раздела и корневой", plan.files.some((f) => f.rel === "process/INDEX.md") && plan.files.some((f) => f.rel === "INDEX.md"));
	check("малый корпус не шардируется", plan.sharded.length === 0);
	check("запись с этапами ждёт строки в указателе", plan.indexed.has(`${records[0].rel}#${records[0].anchor}`));
	check("запись положена в лист раздела", plan.placed.get(`${records[0].rel}#${records[0].anchor}`) === "process/INDEX.md");
	const table = plan.files.find((f) => f.rel === "process/INDEX.md")?.text ?? "";
	check("строка указателя несёт предмет", table.includes("порог указателя"));
	check("указатель предупреждает о ручной правке", table.includes("ручные правки будут затёрты"));

	const route = planRoute(records, "порог указателя вики");
	check("маршрут ведёт в лист раздела", route.routes[0]?.rel === "process/INDEX.md", route.routes[0]?.rel);
	check("маршрут называет ближайшую запись", route.hits[0]?.at.startsWith("process/wiki-index-threshold.md"));

	const place = planPlacement(records, "совсем другая тема про кофеварку");
	check("под незнакомую тему узел не выдумывается", !place.confident && place.suggestion !== null);
}

/** Шарды и колонка этапов идут в порядке флоу, а неизвестный этап уходит в конец. */
function stageOrdering(): void {
	const dir = sandbox("wiki-stage-order");
	const root = join(dir, "wiki");
	const record = (name: string, stage: string) =>
		writeRecord(root, `process/${name}.md`, [
			`# Вывод про ${name}`,
			"",
			`**тип:** ограничение · **предмет:** порядок этапов · **этапы:** ${stage}`,
			"",
			"**вывод:** запись существует ради строки в указателе и ничего больше не утверждает.",
			"",
		].join("\n"));
	record("late", "close");
	record("early", "intake");
	record("alien", "выдуманный");

	const { records } = readRecords(root);
	// Пороги занижены, чтобы плоский указатель не поместился: порядок этапов виден только в
	// оглавлении шардов, в плоском листе этап стоит колонкой самой записи
	const schema = { ...DEFAULTS, limits: { ...DEFAULTS.limits, index_file_lines: 6, index_file_bytes: 400 } };
	const plan = planIndexes(records, schema);
	const toc = plan.files.find((f) => f.rel === "process/INDEX.md")?.text ?? "";

	const listed = [...toc.matchAll(/^\| \[([^\]]+)\]\(INDEX--/gm)].map((m) => m[1]).join(", ");
	check("раздел шардирован по этапам", plan.sharded.includes("process"), plan.sharded.join(","));
	check("intake идёт раньше close", toc.indexOf("[intake]") >= 0 && toc.indexOf("[intake]") < toc.indexOf("[close]"), listed);
	check("неизвестный этап уходит в конец", toc.indexOf("[выдуманный]") > toc.indexOf("[close]"), listed);
}

/** Находки линта: обязательные поля, закрытые списки, постмортем без страховки, подавление. */
function lintFindings(): void {
	const dir = sandbox("wiki-lint");
	const root = join(dir, "wiki");
	writeRecord(root, "process/wiki-index-threshold.md", RECORD);
	writeRecord(root, "process/broken-record.md", [
		"# Заголовок",
		"",
		"**тип:** выдуманный · **предмет:** что-то · **этапы:** несуществующий",
		"",
		"**вывод:** одна строка и всё.",
		"",
	].join("\n"));
	writeRecord(root, "process/record-without-stages.md", [
		"# Запись без этапов никакому этапу не достанется",
		"",
		"**тип:** ограничение · **предмет:** отбор записей",
		"",
		"**вывод:** без поля этапов строка в указателе не появляется.",
		"",
	].join("\n"));
	writeRecord(root, "process/postmortem-without-cover.md", [
		"# Дефект прошёл сквозь проверки",
		"",
		"**тип:** постмортем · **предмет:** гейт правок · **этапы:** advocate",
		"",
		"**вывод:** проверка не смотрела на этот случай и потому молчала.",
		"**линт:** игнорировать K014 - запись коротка по существу",
		"",
	].join("\n"));

	const { records, files } = readRecords(root);
	const plan = planIndexes(records);
	const findings = lint({ records, files, indexed: plan.indexed });
	const codes = (rel: string) => findings.filter((f) => f.at.startsWith(rel)).map((f) => f.code);

	check("тип вне закрытого списка - ошибка", codes("process/broken-record.md").includes("K007"));
	check("этап вне набора флоу - ошибка", codes("process/broken-record.md").includes("K008"));
	check("постмортем без страховки - ошибка", codes("process/postmortem-without-cover.md").includes("K024"));
	check("объявленное исключение снимает находку", !codes("process/postmortem-without-cover.md").includes("K014"));
	check("запись без этапов ни в один указатель не попадает", codes("process/record-without-stages.md").includes("K001"));
	check("исправная запись находок не даёт", codes("process/wiki-index-threshold.md").length === 0, codes("process/wiki-index-threshold.md").join(","));
}

/** Операции: разворачивание, план против записи, уборка мёртвых шардов, коды возврата. */
function operations(): void {
	const dir = sandbox("wiki-ops");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	const root = wikiRoot(volnaDir);

	check("вика разворачивается вместе с .volna", existsSync(join(root, "SCHEMA.md")));
	check("разделы заведены пустыми", existsSync(join(root, "process", ".gitkeep")));
	check("вика в .gitignore не попадает", !readFileSync(join(dir, ".gitignore"), "utf8").includes(".volna/wiki"));
	check("повторное разворачивание соглашения не трогает", initWiki(root).skipped);

	writeRecord(root, "process/wiki-index-threshold.md", RECORD);
	const plan = runWiki("index", { root });
	check("без fix указатели только планируются", plan.code === 0 && !existsSync(join(root, "INDEX.md")));

	const written = runWiki("index", { root, fix: true });
	check("с fix указатели записаны", written.code === 0 && existsSync(join(root, "INDEX.md")));

	writeFileSync(join(root, "process", "INDEX-мёртвый.md"), "# остался от прежнего узла\n", "utf8");
	const swept = runWiki("index", { root, fix: true });
	check("мёртвый шард убирается сборкой", !existsSync(join(root, "process", "INDEX-мёртвый.md")), swept.text);

	// Корень сверки в соглашениях записан как «.»: он обязан читаться от корня проекта, а не от
	// текущего каталога процесса - иначе запуск из подкаталога превращает живые якоря в «файла нет»
	const missing = runWiki("verify", { root });
	check("источника нет - сверка это называет", missing.code === 1 && missing.text.includes("файла нет"), String(missing.code));

	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "index.ts"), ["// шапка", "// вторая строка", "const limit = 8000;", ""].join("\n"), "utf8");
	const verifyRun = runWiki("verify", { root });
	check("корень «.» отсчитывается от проекта, а не от cwd", verifyRun.code === 0 && verifyRun.text.includes("точно: 1"), verifyRun.text.slice(0, 80));

	const lintRun = runWiki("lint", { root });
	check("исправный корпус линт проходит чисто", lintRun.code === 0, lintRun.text.slice(0, 120));

	const stats = runWiki("stats", { root });
	check("счётчики называют число записей", stats.text.includes("записей: 1"), stats.text.slice(0, 60));

	const empty = runWiki("route", { root: join(dir, "нет-такой-вики") });
	check("каталога вики нет - сбой инструмента, а не пустой ответ", empty.code === 3);
}

/** Этап capture стоит перед доставкой и имеет свою инструкцию. */
function captureStage(): void {
	const names = STAGES.map((s) => s.name);
	check("capture стоит перед deliver", names.indexOf("capture") === names.indexOf("deliver") - 1, names.join(","));
	check("visual ведёт в capture", STAGES.find((s) => s.name === "visual")?.next === "capture");
	check("capture ведёт в deliver", STAGES.find((s) => s.name === "capture")?.next === "deliver");
	check("инструкция этапа лежит в скилле", stageInstructions("capture").startsWith("# Stage 9 · capture"));
}
