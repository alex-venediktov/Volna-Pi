/**
 * Ядро флоу: приём задания, переход на этап, пропуск этапа, шапка и сводка состояния.
 *
 * Переход делает код, а не текст в ответе модели: этап в журнале, номер итерации и метка времени
 * ставятся здесь, поэтому «перешёл на этап» и «этап записан» - одно и то же событие. Инструкция
 * этапа возвращается тем же вызовом, и модель продолжает работу в том же ходе.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { asList } from "./frontmatter.ts";
import {
	appendLogSection,
	createJournal,
	freeTaskId,
	journalIssues,
	lastLogSection,
	nextIteration,
	stamp,
	stagesInLog,
} from "./journal.ts";
import { findVolnaDir, volnaPaths, workspaceRoot } from "./paths.ts";
import {
	type ActiveTask,
	displayPath,
	loadActive,
	minutesSince,
	profileValue,
	readProfile,
	readState,
	taskField,
	taskList,
	updateFrontmatter,
	writeState,
} from "./state.ts";
import { findStage, STAGE_NAMES, STAGES, stageDuties, stageInstructions, stagePosition } from "./stages.ts";

export interface FlowResult {
	ok: boolean;
	/** Текст для модели: инструкция этапа либо объяснение отказа. */
	message: string;
	stage?: string;
	iteration?: number;
	task?: string;
	warnings: string[];
}

const NOT_INITIALIZED = [
	"«Волна» в этом каталоге не развёрнута: нет каталога .volna.",
	"Разверни её командой /volna:init - она создаст .volna/project.md и профиль проекта.",
	"Журнал и состояние в чужом репозитории создавать нельзя.",
].join(" ");

const NO_ACTIVE = [
	"Активной задачи нет.",
	"Принять задание: /volna:task <текст задания или путь к md-файлу>.",
].join(" ");

/** Каталог .volna либо объяснение, почему работать нельзя. */
function requireVolna(cwd: string): { volnaDir: string } | { error: string } {
	const volnaDir = findVolnaDir(cwd);
	return volnaDir ? { volnaDir } : { error: NOT_INITIALIZED };
}

export interface IntakeOptions {
	/** Текст задания или путь к md-файлу. */
	assignment: string;
	title?: string;
	type?: string;
	id?: string;
}

/**
 * Этап 1: принять задание. Задание приходит текстом или файлом, идентификатор собирается сам
 * (ГГММДД-слаг) - переспрашивать про него нечего, а руками собранный id разъезжается с именем файла.
 */
export function intake(cwd: string, options: IntakeOptions): FlowResult {
	const guard = requireVolna(cwd);
	if ("error" in guard) return { ok: false, message: guard.error, warnings: [] };
	const { volnaDir } = guard;

	const raw = options.assignment.trim();
	if (!raw) {
		return {
			ok: false,
			message: "Задание пустое. Передай текст задания или путь к md-файлу с постановкой.",
			warnings: [],
		};
	}

	let assignment = raw;
	let source = "текст в разговоре";
	const candidate = isAbsolute(raw) ? raw : resolve(workspaceRoot(volnaDir), raw);
	if (/\.(md|txt)$/i.test(raw) && existsSync(candidate)) {
		assignment = readFileSync(candidate, "utf8");
		source = displayPath(volnaDir, candidate);
	}

	const title = (options.title || firstMeaningfulLine(assignment)).trim().slice(0, 120);
	const task = options.id?.trim() || freeTaskId(volnaDir, title);
	const type = normalizeType(options.type);

	const previous = readState(volnaDir).active;
	const { journalPath, logPath } = createJournal(volnaDir, { task, title, type, source, assignment });
	writeState(volnaDir, { active: task, updated: stamp() });

	const warnings: string[] = [];
	if (previous && previous !== task) {
		warnings.push(`прежняя активная задача ${previous} снята с активной - её журнал остался на месте`);
	}

	const message = [
		`# Задача принята: ${task}`,
		"",
		`- название: ${title}`,
		`- тип: ${type}`,
		`- источник задания: ${source}`,
		`- журнал: ${displayPath(volnaDir, journalPath)}`,
		`- лог: ${displayPath(volnaDir, logPath)}`,
		"",
		"Задание записано в лог дословно, первая секция intake закрыта.",
		"",
		"Дальше по флоу - разбор задания. Продолжай сам, в этом же ходе: вызови volna_stage со",
		"stage=analyze. Останов человеку - только если постановка неоднозначна настолько, что",
		"разбирать нечего.",
		"",
		profileBlock(volnaDir),
	]
		.filter(Boolean)
		.join("\n");

	return { ok: true, message, stage: "intake", iteration: 1, task, warnings };
}

export interface EnterStageOptions {
	/** Причина возврата на пройденный этап: находка адвоката, красный тест, вердикт человека. */
	reason?: string;
}

/** Перейти на этап или открыть его новую итерацию. Возвращает инструкцию этапа для модели. */
export function enterStage(cwd: string, stageName: string, options: EnterStageOptions = {}): FlowResult {
	const guard = requireVolna(cwd);
	if ("error" in guard) return { ok: false, message: guard.error, warnings: [] };
	const { volnaDir } = guard;

	const stage = findStage(stageName);
	if (!stage) {
		return {
			ok: false,
			message: `Этапа «${stageName}» в флоу нет. Этапы: ${STAGE_NAMES.join(", ")}.`,
			warnings: [],
		};
	}
	if (stage.name === "intake") {
		return {
			ok: false,
			message: "Этап intake открывается приёмом задания: /volna:task <задание> или инструмент volna_task.",
			warnings: [],
		};
	}

	const active = loadActive(cwd);
	if (!active) return { ok: false, message: NO_ACTIVE, warnings: [] };

	const previousStage = taskField(active.fm, "stage");
	const iteration = nextIteration(active.logText, stage.name);
	const done = taskList(active.fm, "stages_done");
	const logged = stagesInLog(active.logText);
	if (previousStage && previousStage !== stage.name && logged.includes(previousStage) && !done.includes(previousStage)) {
		done.push(previousStage);
	}
	updateFrontmatter(active.journalPath, { stage: stage.name, stages_done: done, updated: stamp() });

	const warnings: string[] = [];
	if (previousStage && logged.includes(previousStage) === false && previousStage !== stage.name) {
		warnings.push(`этап ${previousStage} закрыт без записи в лог - запись придётся дописать (volna_journal, action=log)`);
	}

	const paths = volnaPaths(volnaDir);
	const header = [
		`# Этап ${stagePosition(stage.name)} · ${stage.name} · ${stage.title}`,
		"",
		iteration > 1
			? `Это итерация ${iteration} этого этапа. Прошлые секции лога не переписывать - история итераций и есть ценность журнала.`
			: `Итерация ${iteration}.`,
	];
	if (iteration > 1) {
		header.push(
			options.reason
				? `Причина возврата: ${options.reason}`
				: "Причина возврата не названа. Возьми её из хвоста разговора (находка адвоката, упавший тест, вердикт человека) или спроси - не придумывай.",
		);
	}

	const duties = stageDuties(stage, {
		task: active.task,
		journalRel: displayPath(volnaDir, paths.journal(active.task)),
		logRel: displayPath(volnaDir, paths.log(active.task)),
		iteration,
	});

	const message = [
		header.join("\n"),
		"",
		duties,
		"",
		"---",
		"",
		stageInstructions(stage.name),
		"",
		"---",
		"",
		taskContextBlock(active, volnaDir),
		profileBlock(volnaDir),
	]
		.filter(Boolean)
		.join("\n");

	return { ok: true, message, stage: stage.name, iteration, task: active.task, warnings };
}

/** Пропустить этап: причина уходит в журнал, иначе через сессию пропуск неотличим от забытого. */
export function skipStage(cwd: string, stageName: string, reason: string): FlowResult {
	const guard = requireVolna(cwd);
	if ("error" in guard) return { ok: false, message: guard.error, warnings: [] };
	const { volnaDir } = guard;

	const stage = findStage(stageName);
	if (!stage) {
		return { ok: false, message: `Этапа «${stageName}» в флоу нет. Этапы: ${STAGE_NAMES.join(", ")}.`, warnings: [] };
	}
	if (!reason.trim()) {
		return { ok: false, message: "Пропуск этапа - только с причиной: она уходит в журнал.", warnings: [] };
	}
	const active = loadActive(cwd);
	if (!active) return { ok: false, message: NO_ACTIVE, warnings: [] };
	if (stage.level === "required") {
		return {
			ok: false,
			message: `Этап ${stage.name} уровня required не пропускается: ${stage.title}. Решение о нём принимает человек в разговоре.`,
			warnings: [],
		};
	}

	const skipped = taskList(active.fm, "skipped");
	skipped.push(`${stage.name}: ${reason.trim()}`);
	const done = taskList(active.fm, "stages_done");
	if (!done.includes(stage.name)) done.push(stage.name);
	updateFrontmatter(active.journalPath, { skipped, stages_done: done, updated: stamp() });
	const { iteration } = appendLogSection(volnaDir, active.task, {
		stage: stage.name,
		fields: {
			что: "этап пропущен",
			зачем: "зафиксировать причину: иначе через сессию пропуск неотличим от забытого этапа",
			почему: reason.trim(),
			сделано: "запись о пропуске",
			осталось: "-",
		},
	});

	const next = STAGES.find((s) => s.name === stage.name)?.next;
	return {
		ok: true,
		message: [
			`Этап ${stage.name} пропущен, причина записана в журнал (итерация ${iteration}).`,
			next ? `Следующий по флоу - ${next}: volna_stage, stage=${next}.` : "Это был последний этап флоу.",
		].join(" "),
		stage: stage.name,
		iteration,
		task: active.task,
		warnings: [],
	};
}

/** Сводка по активной задаче: этап, прогресс, открытые вопросы, замечания к журналу. */
export function statusReport(cwd: string): string {
	const volnaDir = findVolnaDir(cwd);
	if (!volnaDir) return NOT_INITIALIZED;
	const state = readState(volnaDir);
	if (!state.active) return NO_ACTIVE;
	const active = loadActive(cwd);
	if (!active) {
		return `В state.json активна задача ${state.active}, но журнала для неё нет. Проверь .volna/journal/.`;
	}

	const lines: string[] = [];
	lines.push(`Задача ${active.task}: ${taskField(active.fm, "title") || "(без названия)"}`);
	const stage = taskField(active.fm, "stage");
	lines.push(`Этап: ${stage} (${stagePosition(stage)}), тип ${taskField(active.fm, "type") || "?"}`);
	const done = taskList(active.fm, "stages_done");
	if (done.length) lines.push(`Пройдено: ${done.join(", ")}`);
	const skipped = taskList(active.fm, "skipped");
	if (skipped.length) lines.push(`Пропущено: ${skipped.join("; ")}`);
	const branch = taskField(active.fm, "branch");
	if (branch) lines.push(`Ветка: ${branch}`);
	const open = taskList(active.fm, "open");
	if (open.length) lines.push(`Открыто: ${open.join("; ")}`);
	const last = lastLogSection(active.logText);
	if (last) lines.push(`Последняя запись лога: ${last.stage}, итерация ${last.iteration}, ${last.stamp}`);
	const mins = minutesSince(active.mtimeMs);
	if (mins !== null) lines.push(`Журнал трогали ${mins} мин назад`);
	for (const issue of journalIssues(active)) lines.push(`! ${issue}`);
	if (state.unknown.length) {
		lines.push(`! в state.json неизвестные ключи (${state.unknown.join(", ")}) - из-за них сопровождение молчит`);
	}
	lines.push(`Файлы: ${displayPath(volnaDir, active.journalPath)}, ${displayPath(volnaDir, active.logPath)}`);
	return lines.join("\n");
}

/** Строки шапки для ответа модели: коротко, потому что платятся токенами каждый ход. */
export function contextHeader(active: ActiveTask): string[] {
	const lines: string[] = [];
	const stage = taskField(active.fm, "stage");
	const head = [`Волна: задача ${active.task}`];
	const title = taskField(active.fm, "title");
	if (title) head.push(`«${title.slice(0, 60)}»`);
	head.push(`· этап ${stage} ${stagePosition(stage)}`);
	const branch = taskField(active.fm, "branch");
	if (branch) head.push(`· ${branch}`);
	head.push(`· сейчас ${stamp()}`);
	lines.push(head.join(" "));
	for (const item of taskList(active.fm, "open").slice(0, 3)) lines.push(`  открыто: ${item}`);
	return lines;
}

/** Замечания к журналу для человека: что мешает восстановить задачу после сжатия контекста. */
export function journalWarnings(active: ActiveTask): string[] {
	const warnings = journalIssues(active);
	const mins = minutesSince(active.mtimeMs);
	if (mins !== null && mins >= 30) {
		warnings.push(`журнал не дописан ${mins} мин - на этапе положена запись`);
	}
	return warnings;
}

/** Контекст задачи в инструкции этапа: то, что нужно после /clear, и ничего больше. */
function taskContextBlock(active: ActiveTask, volnaDir: string): string {
	const lines = ["## Контекст задачи", ""];
	lines.push(`- задача: ${active.task} — ${taskField(active.fm, "title") || "(без названия)"}`);
	lines.push(`- тип: ${taskField(active.fm, "type") || "?"}, источник задания: ${taskField(active.fm, "source") || "?"}`);
	const branch = taskField(active.fm, "branch");
	if (branch) lines.push(`- ветка: ${branch}`);
	const done = taskList(active.fm, "stages_done");
	if (done.length) lines.push(`- пройдено: ${done.join(", ")}`);
	const skipped = taskList(active.fm, "skipped");
	if (skipped.length) lines.push(`- пропущено: ${skipped.join("; ")}`);
	const open = taskList(active.fm, "open");
	if (open.length) lines.push(`- открыто: ${open.join("; ")}`);
	if (active.stateSection) {
		lines.push("", "«Состояние» из журнала (картина на сейчас):", "", active.stateSection);
	} else {
		lines.push("", "В журнале нет секции «Состояние» - перепиши её на границе отдачи хода.");
	}
	lines.push("", `Полный журнал: ${displayPath(volnaDir, active.journalPath)}. Лог читать адресно, не целиком.`);
	return lines.join("\n");
}

/**
 * Профиль проекта: чего в проекте нет, того этап не делает - молча, без записи «пропущено».
 * Пустой профиль ничего не печатает: лишние строки в контексте платятся каждым ходом.
 */
function profileBlock(volnaDir: string): string {
	const profile = readProfile(volnaDir);
	const keys = ["тесты", "сборка", "запуск", "визуальная проверка", "эталон", "трекер", "вики", "kb"];
	const lines: string[] = [];
	for (const key of keys) {
		const value = profileValue(profile, key);
		if (value) lines.push(`- ${key}: ${value}`);
	}
	const unanswered = keys.filter((key) => profile[key] && !profileValue(profile, key));
	if (!lines.length && !unanswered.length) return "";
	const out = ["## Профиль проекта", ""];
	out.push(...lines);
	if (unanswered.length) {
		out.push(
			"",
			`Не заполнены строки профиля: ${unanswered.join(", ")}. Понадобилась - спроси человека и впиши в .volna/project.md, не догадывайся.`,
		);
	}
	out.push("", "Чего в профиле нет - того этап не делает: это отсутствующий шаг, а не пропуск этапа.");
	return out.join("\n");
}

function firstMeaningfulLine(text: string): string {
	for (const line of text.split(/\r?\n/)) {
		const clean = line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim();
		if (clean) return clean;
	}
	return "задание без названия";
}

function normalizeType(value: string | undefined): string {
	const v = String(value ?? "").trim().toLowerCase();
	const known = ["bug", "story", "task", "research"];
	return known.includes(v) ? v : "task";
}
