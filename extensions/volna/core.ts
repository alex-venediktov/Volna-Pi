/**
 * Ядро флоу: приём задания, переход на этап, пропуск этапа, шапка и сводка состояния.
 *
 * Переход делает код, а не текст в ответе модели: этап в журнале, номер итерации и метка времени
 * ставятся здесь, поэтому «перешёл на этап» и «этап записан» - одно и то же событие. Инструкция
 * этапа возвращается тем же вызовом, и модель продолжает работу в том же ходе.
 */
import { readFileSync } from "node:fs";
import { dropDiffs } from "./advocate.ts";
import { resolveAssignment } from "./assignment.ts";
import { dropSnapshot, needsSnapshot, snapshotExists, takeSnapshot } from "./changes.ts";
import {
	appendLogSection,
	createJournal,
	writeStateSection,
	freeTaskId,
	journalIssues,
	lastLogSection,
	nextIteration,
	stamp,
	stagesInLog,
} from "./journal.ts";
import { currentPart, markPart, partsFromState, partsHeadline, renderPartsText, unfinishedParts, writeParts } from "./parts.ts";
import { findVolnaDir, volnaPaths } from "./paths.ts";
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
	"Принять задание: /volna:task <текст задания или ссылка на файл с постановкой>.",
].join(" ");

/** Каталог .volna либо объяснение, почему работать нельзя. */
function requireVolna(cwd: string): { volnaDir: string } | { error: string } {
	const volnaDir = findVolnaDir(cwd);
	return volnaDir ? { volnaDir } : { error: NOT_INITIALIZED };
}

export interface IntakeOptions {
	/** Текст задания или ссылка на файл с постановкой: путь, @-упоминание, адрес file://. */
	assignment: string;
	title?: string;
	type?: string;
	id?: string;
}

/**
 * Этап 1: принять задание. Задание приходит текстом или ссылкой на файл, идентификатор собирается сам
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
			message: "Задание пустое. Передай текст задания или ссылку на файл с постановкой.",
			warnings: [],
		};
	}

	const resolved = resolveAssignment(cwd, volnaDir, raw);
	if ("error" in resolved) return { ok: false, message: resolved.error, warnings: [] };
	const { text: assignment, source } = resolved;

	const title = (options.title || firstMeaningfulLine(assignment, resolved.fallbackTitle)).trim().slice(0, 120);
	const task = options.id?.trim() || freeTaskId(volnaDir, title);
	const type = normalizeType(options.type);

	const previous = readState(volnaDir).active;
	const { journalPath, logPath } = createJournal(volnaDir, { task, title, type, source, assignment });
	writeState(volnaDir, { active: task, updated: stamp() });

	const warnings: string[] = [...resolved.warnings];
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

/**
 * Продолжение задачи после /clear: есть остаток по частям - поднять задачу и войти в spec следующей
 * части, не спрашивая «начинаем?». Ответ на этот вопрос человек дал, когда делил задачу.
 */
export function resumeTask(cwd: string): FlowResult {
	const guard = requireVolna(cwd);
	if ("error" in guard) return { ok: false, message: guard.error, warnings: [] };
	const active = loadActive(cwd);
	if (!active) {
		return {
			ok: false,
			message: "Активной задачи нет, продолжать нечего. Прими задание: текст или ссылка на файл с постановкой.",
			warnings: [],
		};
	}

	const parts = partsFromState(active.stateSection);
	const next = currentPart(parts);
	if (!parts.length || !next) {
		const stage = taskField(active.fm, "stage");
		return {
			ok: true,
			message: [
				`Задача ${active.task} уже в работе: ${taskField(active.fm, "title") || "(без названия)"}, этап ${stage} ${stagePosition(stage)}.`,
				parts.length ? "Все части сделаны - дальше полное закрытие (этап close)." : "На части задача не делится.",
				"Продолжить: volna_stage с нужным этапом.",
			].join(" "),
			stage,
			task: active.task,
			warnings: [],
		};
	}

	if (next.status === "не начата") writeParts(active.journalPath, markPart(parts, next.number, "в работе"));
	const result = enterStage(cwd, "spec", { reason: `часть ${next.number}/${parts.length}: ${next.title}` });
	if (!result.ok) return result;
	return {
		...result,
		message: [
			`# Продолжение задачи ${active.task}: часть ${next.number}/${parts.length} - ${next.title}`,
			"",
			"Задача та же, журнал тот же, ветка та же. Постановка и критерии приёмки пишутся на эту часть.",
			"",
			result.message,
		].join("\n"),
	};
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

	// Снимок дерева нужен до правок: в проекте без системы контроля версий сравнивать иначе нечем,
	// а понять задним числом, что было до правок, невозможно.
	if (stage.name === "implement" && needsSnapshot(volnaDir, readProfile(volnaDir)) && !snapshotExists(volnaDir, active.task)) {
		const snapshot = takeSnapshot(volnaDir, active.task, readProfile(volnaDir));
		warnings.push(
			`системы контроля версий в проекте нет - снял снимок дерева (${snapshot.files} файлов), по нему адвокат увидит правки`,
		);
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

export interface FinishOptions {
	/** Итог: что изменилось для пользователя, что проверено. */
	summary: string;
	hours?: string;
	left?: string;
	/** Закрыть только текущую часть: задача остаётся активной, ветка и снимок - тоже. */
	part?: boolean;
}

/**
 * Закрыть часть или задачу целиком. Часы и дату ставит код: по меткам журнала их можно проверить,
 * а на глаз - нет.
 *
 * Закрытие части - не закрытие задачи: активная задача, ветка и открытые вопросы остаются, потому
 * что работа продолжается следующей частью. Задача, у которой остались части, закрывается целиком
 * только с перечисленным остатком: иначе через неделю не отличить брошенную работу от сделанной.
 */
export function finishTask(cwd: string, options: FinishOptions): FlowResult & { closed: boolean } {
	const guard = requireVolna(cwd);
	if ("error" in guard) return { ok: false, message: guard.error, warnings: [], closed: false };
	const { volnaDir } = guard;
	const active = loadActive(cwd);
	if (!active) return { ok: false, message: "Активной задачи нет: завершать нечего.", warnings: [], closed: false };

	const parts = partsFromState(active.stateSection);
	const rest = unfinishedParts(parts);
	const title = taskField(active.fm, "title") || "задача";
	const warnings: string[] = [];

	if (options.part) {
		const current = currentPart(parts);
		if (!current) {
			return {
				ok: false,
				message: parts.length
					? "Все части уже закрыты: это полное закрытие задачи, вызывай без part."
					: "Задача на части не делится: закрывай её целиком, без part. Деление предлагается на spec и живёт в подпункте «части».",
				warnings: [],
				closed: false,
			};
		}

		const at = stamp();
		const note = [at.slice(0, 10), options.hours ? `${options.hours}ч` : ""].filter(Boolean).join(", ");
		const closedParts = markPart(parts, current.number, "сделано", note);
		const following = currentPart(closedParts);
		const { iteration } = appendLogSection(volnaDir, active.task, {
			stage: "close",
			fields: {
				что: `часть ${current.number}/${parts.length} закрыта: ${current.title}`,
				зачем: "итог и часы части фиксируются сразу: к полному закрытию их уже не восстановить",
				как: options.hours ? `часы по меткам журнала: ${options.hours}` : "часы не считались",
				сделано: options.summary,
				осталось: options.left ?? (following ? `часть ${following.number}: ${following.title}` : "-"),
			},
		});
		writeStateSection(
			active.journalPath,
			{
				goal: title,
				parts: renderPartsText(closedParts),
				done: options.summary,
				next: following
					? `часть ${following.number}/${parts.length}: ${following.title} - начать со spec после /clear`
					: "все части сделаны - полное закрытие задачи (этап close)",
				careful: options.left,
			},
			{ logText: readFileSync(active.logPath, "utf8") },
		);
		updateFrontmatter(active.journalPath, {
			stage: "close",
			stages_done: [...new Set([...taskList(active.fm, "stages_done"), "close"])],
			updated: at,
		});

		// Снимок дерева - база адвоката там, где системы контроля версий нет. Часть принята,
		// значит база сдвигается: иначе адвокат следующей части придёт с правками предыдущей.
		if (needsSnapshot(volnaDir, readProfile(volnaDir))) {
			const snapshot = takeSnapshot(volnaDir, active.task, readProfile(volnaDir));
			warnings.push(`снимок дерева пере-снят (${snapshot.files} файлов) - адвокат следующей части увидит только её правки`);
		}

		return {
			ok: true,
			closed: false,
			message: [
				`Часть ${current.number}/${parts.length} закрыта (${at}), запись close, итерация ${iteration}.`,
				following
					? `Осталось частей: ${rest.length - 1}. Следующая - ${following.number}: ${following.title}.`
					: "Это была последняя часть: дальше полное закрытие задачи.",
				"Задача остаётся активной, ветка та же, часы копятся до полного закрытия.",
				following ? "Продолжение: /clear, затем /volna:task без аргумента - поднимет эту задачу и войдёт в spec следующей части." : "",
			]
				.filter(Boolean)
				.join(" "),
			stage: "close",
			iteration,
			task: active.task,
			warnings,
		};
	}

	if (rest.length && !options.left?.trim()) {
		return {
			ok: false,
			closed: false,
			message: [
				`У задачи остались незакрытые части (${rest.map((part) => `${part.number}. ${part.title}`).join("; ")}).`,
				"Закрыть часть: тот же вызов с part=true. Закрыть задачу целиком с остатком - тоже законно,",
				"но остаток нужно назвать в left: незаписанный остаток через сессию неотличим от забытого.",
			].join(" "),
			warnings: [],
		};
	}

	const at = stamp();
	const dropped = rest.reduce((acc, part) => markPart(acc, part.number, "снята", "задача закрыта с остатком"), parts);
	const { iteration } = appendLogSection(volnaDir, active.task, {
		stage: "close",
		fields: {
			что: "задача закрыта",
			зачем: "зафиксировать итог и часы: после закрытия контекст исчезает",
			как: options.hours ? `часы по меткам журнала: ${options.hours}` : "часы не считались",
			сделано: options.summary,
			осталось: options.left ?? "-",
		},
	});
	writeStateSection(
		active.journalPath,
		{
			goal: title,
			parts: dropped.length ? renderPartsText(dropped) : undefined,
			done: options.summary,
			next: "задача закрыта, продолжения нет",
			careful: options.left,
		},
		{ logText: readFileSync(active.logPath, "utf8") },
	);
	updateFrontmatter(active.journalPath, {
		stage: "close",
		stages_done: [...new Set([...taskList(active.fm, "stages_done"), "close"])],
		updated: at,
	});
	writeState(volnaDir, { active: null, updated: at });
	if (rest.length) warnings.push(`незакрытых частей ${rest.length} - они помечены снятыми, остаток назван в итоге`);

	// Рабочие файлы задачи живут ровно столько, сколько задача: дифф адвоката пересобирается на
	// каждом прогоне, снимок дерева весит как всё дерево, а сравнивать с ним после закрытия нечего.
	const cleaned: string[] = [];
	if (dropDiffs(volnaDir, active.task)) cleaned.push("диффы адвоката");
	if (dropSnapshot(volnaDir, active.task)) cleaned.push("снимок дерева");

	return {
		ok: true,
		closed: true,
		message: [
			`Задача ${active.task} закрыта (${at}), запись close, итерация ${iteration}.`,
			"Активная задача снята: шапка и гейты по ней больше не работают.",
			`Журнал остался: ${displayPath(volnaDir, active.journalPath)}.`,
			cleaned.length ? `Убрано за задачей: ${cleaned.join(", ")}.` : "",
			"Следующую задачу начинай с чистого контекста: /new или /clear, затем /volna:task.",
		]
			.filter(Boolean)
			.join(" "),
		stage: "close",
		iteration,
		task: active.task,
		warnings,
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
	const parts = partsFromState(active.stateSection);
	if (parts.length) {
		lines.push(`Части: ${partsHeadline(parts)}, осталось ${unfinishedParts(parts).length} из ${parts.length}`);
		for (const part of parts) lines.push(`  ${part.number}. ${part.title} - ${part.status}${part.note ? ` (${part.note})` : ""}`);
	}
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
	const parts = partsHeadline(partsFromState(active.stateSection));
	if (parts) head.push(`· ${parts}`);
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
	const lines = ["## Task", ""];
	lines.push(`${active.task} — ${taskField(active.fm, "title") || "(no title)"} · type ${taskField(active.fm, "type") || "?"}`);
	const branch = taskField(active.fm, "branch");
	if (branch) lines.push(`branch: ${branch}`);
	const done = taskList(active.fm, "stages_done");
	if (done.length) lines.push(`passed: ${done.join(", ")}`);
	const skipped = taskList(active.fm, "skipped");
	if (skipped.length) lines.push(`skipped: ${skipped.join("; ")}`);
	const parts = partsFromState(active.stateSection);
	if (parts.length) {
		const current = currentPart(parts);
		lines.push(`parts: ${current ? `${current.number}/${parts.length} ${current.title}` : "all done"} - this stage is about this part only`);
	}
	const open = taskList(active.fm, "open");
	if (open.length) lines.push(`open: ${open.join("; ")}`);
	if (active.stateSection) lines.push("", "Status from the journal:", "", active.stateSection);
	else lines.push("", "No Status section yet - write it before handing the turn back.");
	lines.push("", `Journal: ${displayPath(volnaDir, active.journalPath)}. Read the log by address, never whole.`);
	return lines.join("\n");
}

/**
 * Профиль проекта: чего в проекте нет, того этап не делает - молча, без записи «пропущено».
 * Пустой профиль ничего не печатает: лишние строки в контексте платятся каждым ходом.
 */
function profileBlock(volnaDir: string): string {
	const profile = readProfile(volnaDir);
	const keys = ["тесты", "сборка", "запуск", "визуальная проверка", "эталон", "трекер", "вики", "kb"];
	const filled = keys.filter((key) => profileValue(profile, key)).map((key) => `${key}: ${profileValue(profile, key)}`);
	const unanswered = keys.filter((key) => profile[key] && !profileValue(profile, key));
	if (!filled.length && !unanswered.length) return "";
	const out = ["## Project profile", "", filled.join(" · ")];
	if (unanswered.length) out.push(`unanswered: ${unanswered.join(", ")} - ask the user, do not guess`);
	out.push("What the profile does not list, the stage does not do: an absent step, not a skipped stage.");
	return out.join("\n");
}

function firstMeaningfulLine(text: string, fallback?: string): string {
	for (const line of text.split(/\r?\n/)) {
		const clean = line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim();
		if (clean) return clean;
	}
	return fallback?.trim() || "задание без названия";
}

function normalizeType(value: string | undefined): string {
	const v = String(value ?? "").trim().toLowerCase();
	const known = ["bug", "story", "task", "research"];
	return known.includes(v) ? v : "task";
}
