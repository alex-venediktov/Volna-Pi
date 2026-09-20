/**
 * «Волна» для pi: ведение одной задачи по флоу этапов с журналом работ.
 *
 * Что делает расширение: держит указатель активной задачи, ставит этап и метки времени, кладёт
 * шапку контекста в каждый ход, показывает состояние в футере, не даёт править код до этапа
 * реализации и не отдаёт контекст на сжатие, пока журнал отстаёт от работы.
 *
 * Границы: доставка есть только в git (ветка, коммит, push) и только по профилю проекта. Трекер,
 * PR, вика и база знаний оставлены на будущее: профиль их уже описывает, этапы про них знают, но
 * кода под них здесь нет.
 *
 * Там, где «Волна» не развёрнута, пакет спит: без каталога .volna в дереве модель не видит ни
 * инструментов, ни скиллов, ни флоу, а событиям нечего делать. Установленный пакет иначе платил бы
 * префиксом на каждом запросе в любом проекте и предлагал бы этапы там, где задачу никто не ведёт.
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { registerCommands, registerSetupCommands } from "./commands.ts";
import { contextHeader, journalWarnings } from "./core.ts";
import { journalIssues, logSinceClose, stagesInLog } from "./journal.ts";
import { currentPart, partsFromState, partsHeadline, unfinishedParts } from "./parts.ts";
import { findVolnaDir, isInside, isJournalLog, logReadInCommand, packageRoot, volnaPaths } from "./paths.ts";
import { type ActiveTask, displayPath, loadActive, profileValue, readProfile, readState, taskField, taskList } from "./state.ts";
import { stagePosition } from "./stages.ts";
import { registerTools } from "./tools.ts";

/** Этапы, на которых правки кода ещё не начались: до реализации работа - это чтение. */
const READ_ONLY_STAGES = new Set(["intake", "analyze", "spec", "plan"]);

export default function volna(pi: ExtensionAPI): void {
	const wake = waker(pi);
	registerSetupCommands(pi, wake);

	/**
	 * Скиллы «Волны» отдаёт расширение, а не pi.skills пакета: их описания лежат в системном
	 * промпте постоянно, и в проекте без .volna они там ни при чём.
	 */
	pi.on("resources_discover", async (event) => {
		if (!findVolnaDir(event.cwd)) return;
		return { skillPaths: [join(packageRoot(), "skills")] };
	});

	pi.on("session_start", async (_event, ctx) => {
		wake(ctx.cwd);
		const active = loadActive(ctx.cwd);
		refreshUi(ctx, active);
		if (!active || muted(ctx)) return;
		ctx.ui.notify(`Волна: активна задача ${active.task}, этап ${taskField(active.fm, "stage")}`, "info");
		pi.sendMessage(
			{ customType: "volna-resume", content: resumeCard(active), display: false },
			{ deliverAs: "nextTurn" },
		);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		wake(ctx.cwd);
		const active = loadActive(ctx.cwd);
		refreshUi(ctx, active);
		if (!active || muted(ctx)) return;
		const lines = contextHeader(active);
		return {
			message: { customType: "volna-header", content: lines.join("\n"), display: false },
			systemPrompt: event.systemPrompt,
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		refreshUi(ctx, loadActive(ctx.cwd));
	});

	/**
	 * Единственная блокировка: правка кода до этапа реализации. Она обратима и потому дешёвая,
	 * но именно она держит границу между «разбираюсь» и «делаю» - без неё этапы разбора и плана
	 * незаметно превращаются в правки без плана. Журнал и служебные файлы «Волны» не в счёт.
	 */
	pi.on("tool_call", async (event, ctx) => {
		const active = loadActive(ctx.cwd);
		if (!active) return;

		if (isToolCallEventType("bash", event)) {
			const command = String(event.input.command ?? "");
			warnOnCommit(ctx, active, command);
			const throughShell = logReadInCommand(command);
			if (throughShell) return refuseLogRead(throughShell, active);
			return;
		}

		const read = readPath(event);
		if (read && isJournalLog(read)) return refuseLogRead(read, active);

		const path = editPath(event);
		if (!path) return;
		const stage = taskField(active.fm, "stage");
		if (!READ_ONLY_STAGES.has(stage)) return;
		if (isInside(path, volnaPaths(active.volnaDir).root)) return;
		const profile = readProfile(active.volnaDir);
		const gate = profileValue(profile, "гейт правок").toLowerCase();
		if (gate === "нет" || gate === "no") return;

		return {
			block: true,
			reason: [
				`Волна: этап ${stage} - правки кода на нём не делаются, работа пока читающая.`,
				"Начни реализацию явно: volna_stage со stage=implement (в reason - что именно делаем).",
				"Так в журнале появится итерация implement, а не правка без этапа.",
				"Правило снимается строкой «гейт правок: нет» в .volna/project.md.",
			].join(" "),
		};
	});

	/**
	 * Сжатие контекста - точка невозврата для незаписанного: после него «почему так» уже не
	 * восстановить. Отстал журнал - сжатие отменяем и дописываем; при переполнении не отменяем
	 * никогда, иначе работа встанет совсем.
	 */
	pi.on("session_before_compact", async (event, ctx) => {
		const active = loadActive(ctx.cwd);
		if (!active || muted(ctx)) return;
		if (event.reason === "overflow") return;
		const issues = journalIssues(active);
		if (!issues.length) return;
		ctx.ui.notify("Волна: сжатие отложено - журнал отстал от работы. Дописываю, потом повтори /compact.", "warning");
		pi.sendMessage(
			{
				customType: "volna-checkpoint",
				content: [
					"Перед сжатием контекста журнал должен быть восстановим. Замечания:",
					`- ${issues.join("\n- ")}`,
					"",
					"Допиши: volna_journal с action=log по текущему этапу и action=state для «Состояния».",
					"Не пересказывай разговор - пиши то, по чему задачу можно продолжить с нуля.",
				].join("\n"),
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return { cancel: true };
	});
}

/**
 * Пробуждение пакета в каталоге, где «Волна» развёрнута: инструменты и команды флоу появляются
 * только вместе с .volna. Регистрация одноразовая - pi разрешает её и после старта, поэтому
 * развёрнутая посреди сессии «Волна» подхватывается со следующего события, без перезапуска.
 */
function waker(pi: ExtensionAPI): (cwd: string) => boolean {
	let awake = false;
	return (cwd: string) => {
		if (awake) return true;
		if (!findVolnaDir(cwd)) return false;
		awake = true;
		registerTools(pi);
		registerCommands(pi);
		return true;
	};
}

/** Заглушено ли сопровождение: гейты это не отключает, только шапку и подсказки. */
function muted(ctx: ExtensionContext): boolean {
	const volnaDir = findVolnaDir(ctx.cwd);
	return volnaDir ? readState(volnaDir).muted : false;
}

/** Футер и виджет: то, что человеку нужно видеть постоянно и за что не платится контекстом. */
function refreshUi(ctx: ExtensionContext, active: ActiveTask | null): void {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setStatus("volna", undefined);
		ctx.ui.setWidget("volna", undefined);
		return;
	}
	const stage = taskField(active.fm, "stage");
	ctx.ui.setStatus("volna", ctx.ui.theme.fg("accent", `волна ${stage} ${stagePosition(stage)}`));

	const lines: string[] = [];
	const title = taskField(active.fm, "title");
	lines.push(`${active.task}${title ? ` · ${title.slice(0, 50)}` : ""}`);
	const parts = partsFromState(active.stateSection);
	if (parts.length) lines.push(ctx.ui.theme.fg("muted", `${partsHeadline(parts)} · осталось ${unfinishedParts(parts).length}`));
	for (const item of taskList(active.fm, "open").slice(0, 3)) {
		lines.push(ctx.ui.theme.fg("muted", `открыто: ${item.slice(0, 70)}`));
	}
	for (const warning of journalWarnings(active).slice(0, 2)) {
		lines.push(ctx.ui.theme.fg("warning", warning.slice(0, 100)));
	}
	ctx.ui.setWidget("volna", lines);
}

/** Карточка возврата к задаче: то, что нужно после /new и перезапуска, и ничего больше. */
function resumeCard(active: ActiveTask): string {
	const stage = taskField(active.fm, "stage");
	const lines = [
		`Волна: продолжается задача ${active.task} — ${taskField(active.fm, "title") || "(без названия)"}.`,
		`Этап ${stage} ${stagePosition(stage)}, тип ${taskField(active.fm, "type") || "?"}.`,
		`Пройдено по логу: ${stagesInLog(active.logText).join(", ") || "ничего"}.`,
	];
	const open = taskList(active.fm, "open");
	if (open.length) lines.push(`Открыто: ${open.join("; ")}`);
	if (active.stateSection) lines.push("", active.stateSection);
	const parts = partsFromState(active.stateSection);
	const part = currentPart(parts);
	lines.push(
		"",
		part
			? `Задача разбита на части, текущая - ${part.number}/${parts.length}: ${part.title}. Работа идёт по ней одной; закончится - volna_finish с part=true.`
			: "Продолжай с текущего этапа: volna_stage вернёт его инструкцию и контекст. Журнал пиши через volna_journal.",
	);
	return lines.join("\n");
}

/** Путь, который инструмент собирается прочитать целиком. Поиск по файлам сюда не относится. */
function readPath(event: { toolName: string; input: any }): string | undefined {
	if (event.toolName !== "read") return undefined;
	const path = event.input?.path;
	return typeof path === "string" && path.trim() ? path : undefined;
}

/**
 * Отказ читать лог итераций целиком. Запрет держится устройством, а не просьбой в промпте: просьбу
 * сессия видит один раз в начале хода, а тянется к логу тогда, когда уже потеряла нить - и читает
 * историю всех частей вместе с отвергнутыми подходами. В чужом контексте брошенная гипотеза
 * читается как факт о проекте, и стоит это дороже, чем неудобство отказа.
 *
 * Адресный поиск не запрещён: им лог и читают, когда надо уточнить одну вещь.
 */
function refuseLogRead(path: string, active: ActiveTask): { block: true; reason: string } {
	return {
		block: true,
		reason: [
			`Волна: лог итераций целиком не читается (${path}).`,
			`Картина задачи - секция «Состояние» в ${displayPath(active.volnaDir, active.journalPath)}: по ней задача и восстанавливается.`,
			"Нужна подробность - ищи по логу адресно (grep по этапу, по «**почему:**», по номеру части), а не читай целиком:",
			"там история всех частей вместе с отвергнутыми подходами, и в чужом контексте брошенная гипотеза читается как факт.",
		].join(" "),
	};
}

/** Путь, который инструмент собирается изменить. Не правка файла - undefined. */
function editPath(event: { toolName: string; input: any }): string | undefined {
	if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
	const path = event.input?.path;
	return typeof path === "string" && path.trim() ? path : undefined;
}

/**
 * Коммит без записи по этапу: предупреждение человеку, не блокировка. Доставки в этой версии нет,
 * коммит - личное дело работающего, но потерянная запись стоит дороже, чем лишняя строка в футере.
 *
 * Считается запись текущей части, а не всей задачи: коммит на часть - норма, и запись прошлой части
 * про эту ничего не говорит.
 */
function warnOnCommit(ctx: ExtensionContext, active: ActiveTask, command: string): void {
	if (!/\bgit\s+(-[^\s]+\s+)*commit\b/i.test(command)) return;
	const stage = taskField(active.fm, "stage");
	if (stagesInLog(logSinceClose(active.logText)).includes(stage)) return;
	ctx.ui.notify(`Волна: по этапу ${stage} записи в журнале ещё нет - после коммита её будет нечем восстановить`, "warning");
}
