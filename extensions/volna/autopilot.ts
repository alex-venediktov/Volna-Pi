/**
 * Прогон незакрытых частей задачи по флоу «Волны», каждая часть - своей сессией pi.
 *
 * От прогона подагентами (`runner.ts`) отличается тем, кто делает флоу. Там подагент - работник:
 * расширения ему выключены, он делает работу части и отчитывается, а этапы, журнал и закрытие
 * остаются на оркестраторе-человеке. Здесь флоу ведёт сама сессия: расширения «Волны» включены,
 * этапы, журнал, адвокат и закрытие части идут внутри неё, а драйвер снаружи только подаёт часть,
 * сторожит молчание и читает итог.
 *
 * Чистый контекст между частями даёт процесс, а не вызов `new_session`: граница процесса заодно
 * переживает падение pi и не тащит в следующую часть ни кэша, ни подвисших инструментов.
 *
 * Итог части берётся с диска, а не из текста модели: статус в списке частей «Состояния» - тот же
 * источник правды, по которому задачу восстанавливают с нуля. Сказанное в ответе к делу не
 * относится, потому что закрывает часть инструмент, а не фраза.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { journalIssues, sectionsOf } from "./journal.ts";
import {
	type Part,
	type PartBrief,
	type PartStatus,
	partBriefForm,
	parsePartBriefs,
	partsFromState,
	takePart,
	unfinishedParts,
} from "./parts.ts";
import { volnaPaths } from "./paths.ts";
import { type RpcAsk, type RpcEvent, type RpcTurnResult, startRpcSession } from "./rpc.ts";
import { displayPath, isPlaceholder, loadActive, loadTask, readProfile, readState } from "./state.ts";

const runFile = promisify(execFile);

/** Чем кончился прогон. Всё, кроме закрытых частей, означает развилку и ход человека. */
export type StopReason =
	| "все части закрыты"
	| "нужен человек"
	| "часть не закрыта"
	| "молчание"
	| "тронута чужая часть"
	| "ход прерван наблюдением"
	| "работа за границей части"
	| "закрытие без человека"
	| "задача закрыта"
	| "ход не начался"
	| "сбой процесса"
	| "отменён";

export interface AutopilotReadiness {
	ok: boolean;
	message: string;
	parts: Part[];
	briefs: PartBrief[];
	/** Сколько частей осталось незакрытыми. */
	left: number;
	/** Незакрытые части без постановки: им неоткуда взять «готово, когда». */
	withoutBrief: number[];
	/** Что прогон не остановит, но человеку знать стоит до запуска. */
	warnings: string[];
	volnaDir: string;
	task: string;
}

/** Строки профиля, без которых этапы прогона останавливаются и спрашивают человека. */
const PROFILE_KEYS = ["тесты", "сборка", "запуск", "доставка", "ветка"];

/**
 * Можно ли запускать прогон. Проверки в коде, а не в просьбе к модели: запуск на отставшем журнале
 * даёт работу по устаревшей картине, и заметит это только человек - потом.
 *
 * Правила о единственной оставшейся части здесь нет, в отличие от прогона подагентами: там она
 * говорила «дешевле сделать самому», а тут делает ту же работу тот же флоу, только своей сессией.
 */
export function autopilotReadiness(cwd: string): AutopilotReadiness {
	const empty = {
		parts: [] as Part[],
		briefs: [] as PartBrief[],
		left: 0,
		withoutBrief: [] as number[],
		warnings: [] as string[],
		volnaDir: "",
		task: "",
	};
	const active = loadActive(cwd);
	if (!active) {
		return { ok: false, message: "Активной задачи нет: прогонять нечего. Принять задание - /volna:task.", ...empty };
	}
	const base = { ...empty, volnaDir: active.volnaDir, task: active.task };
	const parts = partsFromState(active.stateSection);
	const briefs = parsePartBriefs(active.logText);
	if (!parts.length) {
		return {
			ok: false,
			message: "Задача на части не разбита: прогонять нечего. Обычный ход - /volna:task или /volna:spec.",
			...base,
			briefs,
		};
	}
	const left = unfinishedParts(parts);
	const withoutBrief = left
		.filter((part) => !briefs.find((brief) => brief.number === part.number && brief.criterion.trim()))
		.map((part) => part.number);
	if (!left.length) {
		return {
			ok: false,
			message: "Незакрытых частей нет: задача идёт к закрытию (/volna:close).",
			...base,
			parts,
			briefs,
			withoutBrief,
		};
	}
	if (withoutBrief.length) {
		return {
			ok: false,
			message: [
				`Без постановки в логе: части ${withoutBrief.join(", ")} - у них нет «готово, когда», и сессии нечего дать.`,
				"Допиши подпункт «части» в секцию spec (volna_journal action=log, stage=spec) в этом виде:",
				partBriefForm(),
			].join("\n"),
			...base,
			parts,
			briefs,
			left: left.length,
			withoutBrief,
		};
	}
	// Сессия читает журнал с диска, а не пересказ драйвера: отставшее «Состояние» она примет за
	// правду. Замок чек-пойнта поэтому условие запуска, а не пожелание.
	const issues = journalIssues({ text: active.text, stateSection: active.stateSection, logText: active.logText, fm: active.fm });
	if (issues.length) {
		return {
			ok: false,
			message: ["Журнал отстал, а сессия читает его с диска:", ...issues.map((issue) => `- ${issue}`), "Чек-пойнт - /volna:checkpoint."].join(
				"\n",
			),
			...base,
			parts,
			briefs,
			left: left.length,
			withoutBrief,
		};
	}
	return {
		ok: true,
		message: "",
		...base,
		parts,
		briefs,
		left: left.length,
		withoutBrief,
		warnings: profileWarnings(active.volnaDir),
	};
}

/**
 * Чем профиль помешает прогону. Незаполненная строка не ошибка сама по себе, но этап, которому она
 * нужна, останавливается и спрашивает, а на вопрос прогон отвечает отказом - то есть встанет.
 */
export function profileWarnings(volnaDir: string): string[] {
	const profile = readProfile(volnaDir);
	const out: string[] = [];
	const unasked = PROFILE_KEYS.filter((key) => isPlaceholder(profile[key]));
	if (unasked.length) {
		out.push(
			`В профиле не спрошено: ${unasked.join(", ")}. Этап, которому нужна такая строка, остановится и спросит человека, а прогон отвечает на вопросы отказом.`,
		);
	}
	if ((profile["доставка"] ?? "").trim() === "commit+push") {
		out.push("Доставка commit+push: push спрашивает согласие человека, прогон его не даёт - этап встанет на отправке ветки.");
	}
	return out;
}

export interface PartPromptInput {
	volnaDir: string;
	task: string;
	part: Part;
	criterion: string;
	brief?: PartBrief;
}

/**
 * Задание сессии на одну часть. Задача уже активна, и шапка «Волны» показывает её при старте -
 * промпт не пересказывает журнал, а называет часть и границу остановки.
 */
export function partPrompt(input: PartPromptInput): string {
	const paths = volnaPaths(input.volnaDir);
	// Пустые строки разделяют блоки задания, поэтому отсутствующие поля отсеиваются внутри блока,
	// а не во всём тексте: общий отсев снял бы заодно и разделители.
	const bounds = [
		`Готово, когда: ${input.criterion}`,
		input.brief?.touches ? `Трогает: ${input.brief.touches}` : "",
		input.brief?.avoids ? `Не трогает: ${input.brief.avoids}` : "",
		input.brief?.depends ? `Зависит от: ${input.brief.depends}` : "",
	].filter((line) => line !== "");
	return [
		`Задача ${input.task}, часть ${input.part.number}: ${input.part.title}.`,
		bounds.join("\n"),
		[
			"Веди эту часть по флоу «Волны» до закрытия части.",
			`Картина задачи - секция «Состояние» в ${displayPath(input.volnaDir, paths.journal(input.task))}, по ней задача и восстанавливается.`,
			`Лог итераций (${displayPath(input.volnaDir, paths.log(input.task))}) целиком не читай и поиском по нему не ходи: это история всех частей, она вытеснит из контекста работу над твоей. Нужна подробность по своей части - смотри её секции.`,
			`Накопленное знание лежит в вике ${displayPath(input.volnaDir, volnaPaths(input.volnaDir).wikiDir)}, а не в логе.`,
		].join("\n"),
		[
			`Делай только часть ${input.part.number}. Другие части не трогай и закрывать их не смей: закрытие ставится ровно на эту часть и ни на какую другую.`,
			"Это автоматический прогон: человека рядом нет, и на любой вопрос он ответит отказом. Push не делай.",
			"Дошёл до проверки, которую может сделать только человек, или до развилки - останови работу, запиши это в журнал и скажи одной строкой, чего ждёшь.",
		].join("\n"),
	].join("\n\n");
}

/** Список частей, каким он лежит в журнале сейчас. Журнала нет - пустой список. */
export function partsNow(volnaDir: string, task: string): Part[] {
	const fresh = loadTask(volnaDir, task);
	return fresh ? partsFromState(fresh.stateSection) : [];
}

/**
 * Признаки того, что критерий части закрывает человек, а не машина. Список слов, а не разбор
 * смысла: критерий пишется прозой, и надёжнее опознать заявленную процедуру, чем угадать суть.
 */
const HUMAN_CHECK = /человек|глаз|руками|пальц|телефон|устройств|замер|демо/i;

/** Ждёт ли часть проверки человеком по своему критерию. */
export function needsHuman(criterion: string): boolean {
	return HUMAN_CHECK.test(criterion);
}

/**
 * Пути из поля `трогает`, приведённые к префиксам. Поле пишется прозой через запятую, поэтому
 * берутся только куски, похожие на путь или имя файла - остальное границей служить не может.
 */
export function touchedPrefixes(touches: string): string[] {
	return String(touches ?? "")
		.split(/[,;\n]/)
		.map((piece) => piece.trim().replace(/^[(«"']+|[)»"'.]+$/g, ""))
		.filter((piece) => /[\/]/.test(piece) || /\.[a-z0-9]{2,5}$/i.test(piece))
		.map((piece) => piece.replace(/\\/g, "/"));
}

/**
 * Файлы, тронутые за объявленной границей части. Граница берётся из поля `трогает` постановки, и
 * это не догадка: там она выписана явно. Пустое поле проверять нечем - тогда список пуст, и об
 * этом говорится отдельно, а не умалчивается.
 *
 * Журнал и вика не считаются: их правит сам флоу на каждом этапе, к границе части они не относятся.
 */
export function strayFiles(changed: string[], touches: string): string[] {
	const prefixes = touchedPrefixes(touches);
	if (!prefixes.length) return [];
	return changed
		.map((file) => file.replace(/\\/g, "/"))
		.filter((file) => file && !file.startsWith(".volna/"))
		.filter((file) => !prefixes.some((prefix) => file === prefix || file.startsWith(prefix) || file.endsWith(`/${prefix}`) || file.split("/").pop() === prefix.split("/").pop()));
}

/** Закрыта ли часть по журналу на диске. Часть исчезла из списка - считается незакрытой. */
export function partClosed(volnaDir: string, task: string, number: number): boolean {
	const part = partsNow(volnaDir, task).find((item) => item.number === number);
	return part?.status === "сделано" || part?.status === "снята";
}

/** Часть, которой сессия не занималась, а статус ей поменяла. */
export interface StrayChange {
	number: number;
	title: string;
	from: PartStatus;
	to: PartStatus;
}

/**
 * Статусы, поменявшиеся не у той части, над которой шла работа. Доказать, что часть сделана, в
 * общем виде нельзя, а вот поймать закрытие соседней части - можно точно: сессии дали одну часть,
 * и правка статуса любой другой означает, что закрытие поставлено не туда.
 */
export function strayChanges(before: Part[], after: Part[], current: number): StrayChange[] {
	const out: StrayChange[] = [];
	for (const part of after) {
		if (part.number === current) continue;
		const was = before.find((item) => item.number === part.number);
		if (!was || was.status === part.status) continue;
		out.push({ number: part.number, title: part.title, from: was.status, to: part.status });
	}
	return out;
}

export interface PartRunLog {
	part: number;
	title: string;
	closed: boolean;
	/** Сколько заданий подано в сессию: первое плюс продолжения и толчки сторожа. */
	prompts: number;
	nudges: number;
	asks: RpcAsk[];
	notes: string[];
	toolCalls: number;
	/** Статусы, поменянные не у своей части: закрытие, поставленное не туда. */
	stray: StrayChange[];
	/** Чем наблюдение прервало ход, если прервало. */
	stoppedBy: string;
	/** Файлы, тронутые за объявленной границей части. */
	strayPaths: string[];
	/** Последний ответ сессии: что она сказала, останавливаясь. */
	lastText: string;
	stderr: string;
}

export interface AutopilotReport {
	stop: StopReason;
	detail: string;
	runs: PartRunLog[];
	/** Номера частей, закрытых этим прогоном. */
	closed: number[];
}

export interface AutopilotOptions {
	cwd: string;
	readiness: AutopilotReadiness;
	/** Сколько миллисекунд молчания считать зависанием. */
	idleMs: number;
	/** Сколько ждать первого признака хода: холодная локальная модель отвечает не сразу. */
	startMs: number;
	/** Сколько раз сторож будит молчащую модель внутри одного задания. */
	maxNudges: number;
	/** Сколько раз просить продолжить часть, которая осела незакрытой. */
	maxContinues: number;
	/**
	 * Страховочный потолок вызовов на часть: он ловит сессию, которая не возвращает управления,
	 * а не ограничивает работу. Замеры частей - 58, 151 и 292 вызова, и все три были законной
	 * работой своей части, поэтому порог стоит заметно выше, чем стоит обычная часть. Точно
	 * границу держат проверки статуса и файлов, а не это число. Ноль снимает предел.
	 */
	maxToolCalls?: number;
	/** Потолок времени на одну часть в миллисекундах. Ноль снимает предел. */
	partMs?: number;
	/** Дальше этой части не идти: место, где человек знает про ручную проверку заранее. */
	until?: number;
	args?: string[];
	/** Чем поднимать сессии вместо самого pi. Нужно тесту цикла: живой pi требует модели. */
	exec?: { command: string; args: string[] };
	signal?: AbortSignal;
	onPart?: (part: Part, index: number, total: number) => void;
	onEvent?: (part: Part, event: RpcEvent) => void;
	onPartDone?: (log: PartRunLog) => void;
}

/**
 * Чем сессия входит в часть. Команда без аргумента поднимает активную задачу, ставит очередную
 * часть в работу и вводит её в spec (`core.ts:resumeTask`) - то самое продолжение, которое «Волна»
 * называет человеку на закрытии части. Без него сессия открывается на этапе, которым кончилась
 * предыдущая часть (`close`), и флоу не начинается вовсе: модель читает журнал и ходит кругами.
 *
 * Часть выбирает сама команда - ту, что «в работе», а если такой нет, первую не начатую. С
 * очередью драйвера это сходится потому, что часть помечена взятой строкой выше.
 */
const ENTER_PART = "/volna:task";

/** Чем просить продолжить часть, которая осела незакрытой без вопроса и без обрыва. */
const CONTINUE =
	"Часть ещё не закрыта. Либо доведи её до закрытия части, либо скажи одной строкой, что именно должен сделать человек, и остановись.";

/**
 * Гнать незакрытые части по одной, каждую своей сессией. Останавливается на первой развилке:
 * независимость частей - оценка, сделанная до работы, и работа по следующей части поверх спорной
 * предыдущей стоит дороже, чем остановка.
 */
/** Снимок дерева до части: на чём стоит HEAD и что уже было грязным. */
interface GitSnapshot {
	head: string;
	dirty: Set<string>;
}

/** Строки вывода git. Своя обёртка, потому что драйвер идёт обычным node, без API pi. */
async function gitLines(cwd: string, args: string[]): Promise<string[]> {
	try {
		const { stdout } = await runFile("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
		return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

export async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
	const head = (await gitLines(cwd, ["rev-parse", "HEAD"]))[0] ?? "";
	const dirty = new Set((await gitLines(cwd, ["status", "--porcelain"])).map(statusPath));
	return { head, dirty };
}

/** Путь из строки `git status --porcelain`: два знака состояния, дальше имя. */
function statusPath(line: string): string {
	return line.replace(/^..\s*/, "").replace(/^.*-> /, "").replace(/^"|"$/g, "");
}

/**
 * Файлы, тронутые за время части: и закоммиченные внутри неё, и оставшиеся в дереве. Грязное до
 * начала не считается - эта работа не её.
 */
export async function touchedSince(cwd: string, snapshot: GitSnapshot): Promise<string[]> {
	if (!snapshot.head) return [];
	const committed = await gitLines(cwd, ["diff", "--name-only", snapshot.head]);
	const now = (await gitLines(cwd, ["status", "--porcelain"])).map(statusPath);
	const touched = new Set<string>(committed);
	for (const file of now) if (!snapshot.dirty.has(file)) touched.add(file);
	return [...touched];
}

/** Сложить итог хода в отчёт части и сказать, кончился ли на нём прогон. */
function absorb(log: PartRunLog, turn: RpcTurnResult, signal?: AbortSignal): StopReason | null {
	log.prompts++;
	log.nudges += turn.nudges;
	log.toolCalls += turn.toolCalls;
	log.asks.push(...turn.asks);
	log.notes.push(...turn.notes);
	if (turn.texts.length) log.lastText = turn.texts[turn.texts.length - 1];
	log.stderr = turn.stderr;
	if (turn.stoppedBy) log.stoppedBy = turn.stoppedBy;
	if (turn.exited) return "сбой процесса";
	if (turn.stalled) return "ход не начался";
	if (turn.asks.length) return "нужен человек";
	if (turn.stoppedBy) return "ход прерван наблюдением";
	if (turn.aborted) return signal?.aborted ? "отменён" : "молчание";
	return null;
}

export async function runAutopilot(options: AutopilotOptions): Promise<AutopilotReport> {
	const report: AutopilotReport = { stop: "все части закрыты", detail: "", runs: [], closed: [] };
	const { volnaDir, task } = options.readiness;
	const queue = unfinishedParts(options.readiness.parts).filter((part) => !options.until || part.number <= options.until);

	for (const [index, part] of queue.entries()) {
		if (options.signal?.aborted) {
			report.stop = "отменён";
			report.detail = `Прогон отменён до части ${part.number}.`;
			return report;
		}
		// Часть могла закрыться внутри работы над предыдущей: список частей - снимок, сделанный до
		// прогона, а правда о статусе лежит в журнале.
		if (partClosed(volnaDir, task, part.number)) continue;
		// Часть видно начатой, пока сессия над ней работает: остановка на вопросе иначе выглядит
		// так, будто за часть никто не брался. Отметка идёт до показа хода, чтобы карта частей и
		// строка прогона говорили одно и то же.
		takePart(volnaPaths(volnaDir).journal(task), partsNow(volnaDir, task), part.number);
		const before = partsNow(volnaDir, task);
		const gitBefore = await gitSnapshot(options.cwd);
		options.onPart?.(part, index, queue.length);
		const brief = options.readiness.briefs.find((item) => item.number === part.number);
		const log: PartRunLog = {
			part: part.number,
			title: part.title,
			closed: false,
			prompts: 0,
			nudges: 0,
			asks: [],
			notes: [],
			toolCalls: 0,
			stray: [],
			stoppedBy: "",
			strayPaths: [],
			lastText: "",
			stderr: "",
		};

		const session = startRpcSession({
			cwd: options.cwd,
			args: options.args,
			exec: options.exec,
			idleMs: options.idleMs,
			startMs: options.startMs,
			maxNudges: options.maxNudges,
			signal: options.signal,
			onEvent: (event) => options.onEvent?.(part, event),
			// Наблюдение по ходу, а не после: сессия, которая закрыла свою часть и пошла дальше,
			// до разбора итога не доходит - управление возвращается только на оседании.
			watch: ({ toolCalls, elapsedMs }) => {
				const moved = strayChanges(before, partsNow(volnaDir, task), part.number);
				if (moved.length) return `тронута часть ${moved[0].number}`;
				if (options.maxToolCalls && toolCalls > options.maxToolCalls) return `вызовов инструментов больше ${options.maxToolCalls}`;
				if (options.partMs && elapsedMs > options.partMs) return `часть идёт дольше ${Math.round(options.partMs / 60000)} минут`;
				return null;
			},
		});
		let stop: StopReason | null = null;
		try {
			stop = absorb(log, await session.prompt(ENTER_PART), options.signal);
			let text = partPrompt({ volnaDir, task, part, criterion: brief?.criterion ?? "", brief });
			for (let attempt = 0; !stop && attempt <= options.maxContinues; attempt++) {
				stop = absorb(log, await session.prompt(text), options.signal);
				if (stop) break;
				log.closed = partClosed(volnaDir, task, part.number);
				if (log.closed) break;
				text = CONTINUE;
			}
		} finally {
			await session.close();
		}

		if (!log.closed) log.closed = partClosed(volnaDir, task, part.number);
		// Закрытие сессии берётся на веру только про свою часть: правка статуса соседней означает,
		// что закрытие поставлено не туда, и дальше идти нельзя - следующая часть уже пропущена.
		log.stray = strayChanges(before, partsNow(volnaDir, task), part.number);
		log.strayPaths = strayFiles(await touchedSince(options.cwd, gitBefore), brief?.touches ?? "");
		// Закрытая задача обрывает флоу целиком: активной задачи больше нет, гнать нечего, и
		// остаток частей записан итогом, которого никто не проверял.
		if (readState(volnaDir).active !== task && !stop) stop = "задача закрыта";
		if (log.stray.length && !stop) stop = "тронута чужая часть";
		if (log.strayPaths.length && !stop) stop = "работа за границей части";
		// Критерий, который закрывает человек, закрытый сессией без единого вопроса - закрытие в
		// обход приёмки. Доказать делом машина не может, а поймать обход процедуры - может.
		if (log.closed && !stop && needsHuman(brief?.criterion ?? "") && !log.asks.length) stop = "закрытие без человека";
		if (log.closed) report.closed.push(part.number);
		report.runs.push(log);
		options.onPartDone?.(log);

		if (log.closed && !stop) continue;
		report.stop = stop ?? "часть не закрыта";
		report.detail = stopDetail(report.stop, log);
		return report;
	}

	const restLeft = unfinishedParts(options.readiness.parts).filter((part) => options.until && part.number > options.until);
	report.detail = restLeft.length
		? `Дошли до части ${options.until}, как и просили. Осталось незакрытых: ${restLeft.map((part) => part.number).join(", ")}.`
		: "Незакрытых частей не осталось: задача идёт к закрытию (/volna:close).";
	return report;
}

/**
 * Вывод по задаче целиком: последняя сессия прогона, которая читает журнал и пишет в вику то, чего
 * не видно изнутри одной части.
 *
 * Отдельной работой, а не хвостом цикла, потому что вход у неё другой. Сессии части лог итераций
 * вреден - это история всех частей, она вытесняет работу над своей. Здесь он единственный источник:
 * контекста ни одной прошлой сессии уже нет, а журнал пережил их все - на том «Волна» и построена.
 *
 * Задачу не закрывает: `close` - решение человека, и прогон его не принимает.
 */
export async function runTaskCapture(options: TaskCaptureOptions): Promise<PartRunLog> {
	const log: PartRunLog = {
		part: 0,
		title: "вывод по задаче",
		closed: false,
		prompts: 0,
		nudges: 0,
		asks: [],
		notes: [],
		toolCalls: 0,
		stray: [],
		stoppedBy: "",
		strayPaths: [],
		lastText: "",
		stderr: "",
	};
	const session = startRpcSession({
		cwd: options.cwd,
		args: options.args,
		exec: options.exec,
		idleMs: options.idleMs,
		startMs: options.startMs,
		maxNudges: options.maxNudges,
		signal: options.signal,
		onEvent: options.onEvent,
	});
	try {
		const enter = absorb(log, await session.prompt(ENTER_CAPTURE), options.signal);
		if (!enter) absorb(log, await session.prompt(capturePrompt(options.volnaDir, options.task)), options.signal);
	} finally {
		await session.close();
	}
	return log;
}

export interface TaskCaptureOptions {
	cwd: string;
	volnaDir: string;
	task: string;
	idleMs: number;
	startMs: number;
	maxNudges: number;
	args?: string[];
	exec?: { command: string; args: string[] };
	signal?: AbortSignal;
	onEvent?: (event: RpcEvent) => void;
}

/** Чем сессия входит в вывод по задаче: тем же инструментом этапа, что и человек. */
const ENTER_CAPTURE = "/volna:capture";

/**
 * Задание на вывод по задаче. Материал кладётся в промпт, а не адресуется файлом, и это тот же
 * образец, по которому «Волна» даёт контекст адвокату (`tools.ts`, journalContext): «Состояние»
 * плюс названные секции лога.
 *
 * Лог целиком не отдаётся и читать его не предлагается. Он хранит все итерации вместе с
 * отвергнутыми подходами, и на входе сквозного вывода это не материал, а шум, в котором брошенная
 * гипотеза выглядит фактом. Итог части пишется на её закрытии - это и есть сжатая проверенная часть
 * истории, ради которой лог вообще перечитывают.
 */
export function capturePrompt(volnaDir: string, task: string): string {
	const paths = volnaPaths(volnaDir);
	const fresh = loadTask(volnaDir, task);
	const closes = fresh ? sectionsOf(fresh.logText, "close") : [];
	return [
		`Задача ${task}: все части закрыты. Твоя работа - вывод по задаче целиком, и только он.`,
		fresh?.stateSection ? `«Состояние» задачи:\n${fresh.stateSection.trim()}` : "",
		closes.length ? `Итоги закрытых частей:\n\n${closes.join("\n\n")}` : "",
		[
			`Записи по отдельным частям уже лежат в ${displayPath(volnaDir, paths.wikiDir)}: прочти их, чтобы не писать то же во второй раз.`,
			"Ищи то, чего не видно изнутри одной части: что повторилось в нескольких, что одна часть сломала в другой, чего стоило решение, принятое в начале.",
			"Нечего добавить - так и скажи одной строкой и остановись. Запись ради записи хуже её отсутствия: вика - знание команды, а не отчёт о проделанной работе.",
		].join("\n"),
		`Лог итераций (${displayPath(volnaDir, paths.log(task))}) целиком не читай: итоги частей уже выше, а остальное там - ход работы вместе с отвергнутыми подходами. Загляни в него точечно, если какой-то итог надо уточнить.`,
		"Код не правь, части и задачу не закрывай, ничего не коммить. Это автоматический прогон: человека рядом нет, на любой вопрос он ответит отказом.",
	]
		.filter((block) => block !== "")
		.join("\n\n");
}

/** Причина остановки словами человека: что случилось и с чем он остался. */
function stopDetail(stop: StopReason, log: PartRunLog): string {
	const head = log.closed
		? `Часть ${log.part} («${log.title}») закрыта, но прогон дальше не идёт.`
		: `Часть ${log.part} («${log.title}») не закрыта.`;
	if (stop === "нужен человек") {
		const ask = log.asks[0];
		return `${head} Сессия спросила человека: ${ask?.title || ask?.method}. Прогон ответил отказом и остановился.`;
	}
	if (stop === "молчание") {
		return `${head} Сессия молчала дольше порога и не продолжила после ${log.nudges} напоминаний.`;
	}
	if (stop === "тронута чужая часть") {
		const stray = log.stray.map((item) => `часть ${item.number} («${item.title}»): ${item.from} -> ${item.to}`).join("; ");
		return `${head} Сессия поменяла статус не своей части: ${stray}. Статус в журнале верить нельзя, пока человек не сверит его с работой.`;
	}
	if (stop === "ход прерван наблюдением") {
		return `${head} Ход прерван по ходу работы: ${log.stoppedBy}. Дальше сессия работала бы, не возвращая управления.`;
	}
	if (stop === "работа за границей части") {
		return `${head} Сессия правила файлы за объявленной границей: ${log.strayPaths.join(", ")}. Граница взята из поля «трогает» постановки этой части.`;
	}
	if (stop === "закрытие без человека") {
		return `Часть ${log.part} («${log.title}») закрыта сессией, но её критерий закрывает человек, а вопросов не было ни одного. Сверь работу с критерием и закрой часть сам, если она сделана.`;
	}
	if (stop === "задача закрыта") {
		return `${head} Сессия закрыла задачу целиком: активной задачи больше нет, остаток частей записан итогом, которого никто не проверял. Закрытие задачи - решение человека.`;
	}
	if (stop === "ход не начался") {
		return `${head} Сессия не подала ни одного признака работы: похоже, ход не начался вовсе.${log.stderr ? ` Поток ошибок: ${log.stderr.trim().slice(-400)}` : ""}`;
	}
	if (stop === "сбой процесса") {
		return `${head} Процесс pi завершился посреди хода.${log.stderr ? ` Поток ошибок: ${log.stderr.trim().slice(-400)}` : ""}`;
	}
	if (stop === "отменён") return `${head} Прогон отменён.`;
	return `${head} Сессия остановилась сама. Последнее, что сказала: ${log.lastText || "ничего"}`;
}
