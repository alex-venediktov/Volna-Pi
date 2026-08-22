/**
 * «Волна» для pi: ведение одной задачи по флоу этапов с журналом работ.
 *
 * Что делает расширение: держит указатель активной задачи, ставит этап и метки времени, кладёт
 * шапку контекста в каждый ход, показывает состояние в футере, не даёт править код до этапа
 * реализации и не отдаёт контекст на сжатие, пока журнал отстаёт от работы.
 *
 * Границы: доставки (коммит, push, PR, трекер) в этой версии нет - работа кончается закрытием
 * задачи в журнале. Репозитории, трекер, вика и база знаний оставлены на будущее: профиль проекта
 * их уже описывает, этапы про них знают, но кода под них здесь нет.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { contextHeader, journalWarnings } from "./core.ts";
import { journalIssues, stagesInLog } from "./journal.ts";
import { findVolnaDir, isInside, volnaPaths } from "./paths.ts";
import { type ActiveTask, loadActive, profileValue, readProfile, readState, taskField, taskList } from "./state.ts";
import { stagePosition } from "./stages.ts";
import { registerTools } from "./tools.ts";

/** Этапы, на которых правки кода ещё не начались: до реализации работа - это чтение. */
const READ_ONLY_STAGES = new Set(["intake", "analyze", "spec", "plan"]);

export default function volna(pi: ExtensionAPI): void {
	registerTools(pi);
	registerCommands(pi);


	pi.on("session_start", async (_event, ctx) => {
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
			warnOnCommit(ctx, active, String(event.input.command ?? ""));
			return;
		}

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
	for (const item of taskList(active.fm, "open").slice(0, 3)) {
		lines.push(ctx.ui.theme.fg("muted", `открыто: ${item.slice(0, 70)}`));
	}
	for (const warning of journalWarnings(active).slice(0, 2)) {
		lines.push(ctx.ui.theme.fg("warning", warning.slice(0, 100)));
	}
	ctx.ui.setWidget("volna", lines);
}

/** Карточка возврата к задаче: то, что нужно после /clear и перезапуска, и ничего больше. */
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
	lines.push(
		"",
		"Продолжай с текущего этапа: volna_stage вернёт его инструкцию и контекст. Журнал пиши через volna_journal.",
	);
	return lines.join("\n");
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
 */
function warnOnCommit(ctx: ExtensionContext, active: ActiveTask, command: string): void {
	if (!/\bgit\s+(-[^\s]+\s+)*commit\b/i.test(command)) return;
	const stage = taskField(active.fm, "stage");
	if (stagesInLog(active.logText).includes(stage)) return;
	ctx.ui.notify(`Волна: по этапу ${stage} записи в журнале ещё нет - после коммита её будет нечем восстановить`, "warning");
}
