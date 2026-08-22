/**
 * Команды для человека. Каждая команда либо делает свою работу сама (init, status, doctor, off/on),
 * либо кладёт в контекст инструкцию этапа и запускает ход - тем же кодом, что вызывает модель
 * через volna_stage. Одна дорога на двух входах: расхождение между «человек нажал» и «модель
 * решила» было бы источником самых непонятных ошибок.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { enterStage, intake, skipStage, statusReport } from "./core.ts";
import { initVolna } from "./init.ts";
import { journalIssues, stamp } from "./journal.ts";
import { findVolnaDir, volnaPaths, workspaceRoot } from "./paths.ts";
import { loadActive, profileValue, readProfile, readState, writeState } from "./state.ts";
import { STAGES, STAGE_NAMES } from "./stages.ts";

/** Инструкция этапа кладётся в контекст без вывода человеку: ему хватает строки статуса. */
function deliverStage(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string, note: string): void {
	pi.sendMessage({ customType: "volna-stage", content: text, display: false }, { triggerTurn: true });
	ctx.ui.notify(note, "info");
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("volna:init", {
		description: "Волна: развернуть .volna в этом репозитории (профиль проекта, каталоги журнала, .gitignore)",
		handler: async (_args, ctx) => {
			const result = initVolna(ctx.cwd);
			ctx.ui.notify(`Волна развёрнута: ${result.volnaDir}`, "info");
			pi.sendMessage({ customType: "volna-init", content: result.message, display: true }, { triggerTurn: false });
		},
	});

	pi.registerCommand("volna:task", {
		description: "Волна: принять задание в работу (текст или путь к md-файлу) и открыть флоу",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			const assignment = args.trim();
			if (!assignment) {
				ctx.ui.notify("Нужно задание: /volna:task <текст задания или путь к md-файлу>", "warning");
				return;
			}
			const result = intake(ctx.cwd, { assignment });
			if (!result.ok) {
				ctx.ui.notify(result.message, "error");
				return;
			}
			deliverStage(pi, ctx, result.message, `Задача ${result.task} принята, этап intake`);
		},
	});

	for (const stage of STAGES) {
		if (stage.name === "intake") continue;
		pi.registerCommand(`volna:${stage.name}`, {
			description: `Волна: этап ${stage.name} (${stage.level}) - ${stage.title}`,
			handler: async (args, ctx) => {
				const result = enterStage(ctx.cwd, stage.name, { reason: args.trim() || undefined });
				if (!result.ok) {
					ctx.ui.notify(result.message, "error");
					return;
				}
				deliverStage(pi, ctx, result.message, `Этап ${stage.name}, итерация ${result.iteration}`);
			},
		});
	}

	pi.registerCommand("volna:skip", {
		description: "Волна: пропустить этап с причиной (причина уходит в журнал)",
		getArgumentCompletions: (prefix) => {
			const items = STAGE_NAMES.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [stage, ...rest] = args.trim().split(/\s+/);
			const reason = rest.join(" ");
			if (!stage || !reason) {
				ctx.ui.notify("Нужны этап и причина: /volna:skip unit-tests тестов на это нет", "warning");
				return;
			}
			const result = skipStage(ctx.cwd, stage, reason);
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
			if (result.ok) {
				pi.sendMessage({ customType: "volna-skip", content: result.message, display: true }, { triggerTurn: false });
			}
		},
	});

	pi.registerCommand("volna:status", {
		description: "Волна: состояние активной задачи - этап, прогресс, открытые вопросы, замечания к журналу",
		handler: async (_args, ctx) => {
			const text = statusReport(ctx.cwd);
			pi.sendMessage({ customType: "volna-status", content: text, display: true }, { triggerTurn: false });
		},
	});

	pi.registerCommand("volna:journal", {
		description: "Волна: дописать журнал активной задачи по текущему этапу",
		handler: async (args, ctx) => {
			const active = loadActive(ctx.cwd);
			if (!active) {
				ctx.ui.notify("Активной задачи нет", "warning");
				return;
			}
			const text = [
				"Допиши журнал активной задачи по текущему этапу.",
				args.trim() ? `Что зафиксировать: ${args.trim()}` : "",
				"Секция этапа - volna_journal с action=log, «Состояние» - action=state. Формат и метку времени",
				"ставит инструмент, markdown журнала руками не пиши.",
			]
				.filter(Boolean)
				.join("\n");
			pi.sendMessage({ customType: "volna-journal", content: text, display: false }, { triggerTurn: true });
			ctx.ui.notify("Записываю журнал", "info");
		},
	});

	pi.registerCommand("volna:checkpoint", {
		description: "Волна: чек-пойнт - дописать журнал до состояния, восстановимого с нуля (перед сжатием контекста)",
		handler: async (_args, ctx) => {
			const active = loadActive(ctx.cwd);
			if (!active) {
				ctx.ui.notify("Активной задачи нет", "warning");
				return;
			}
			const issues = journalIssues(active);
			const text = [
				"Чек-пойнт журнала. Проверь четыре вопроса и приведи журнал в порядок:",
				"1. По «Состоянию» задача восстанавливается с нуля, без остатков контекста?",
				"2. Всё, что решено и отвергнуто в этом ходе, попало в «Состояние»?",
				"3. Секция текущего этапа в логе записана?",
				"4. Открытые вопросы актуальны (open)?",
				issues.length ? `\nМашинные замечания:\n- ${issues.join("\n- ")}` : "\nМашинных замечаний нет.",
				"\nПиши через volna_journal (action=log, action=state, action=open).",
			].join("\n");
			pi.sendMessage({ customType: "volna-checkpoint", content: text, display: false }, { triggerTurn: true });
			ctx.ui.notify("Чек-пойнт: дописываю журнал", "info");
		},
	});

	pi.registerCommand("volna:doctor", {
		description: "Волна: проверить настройку - .volna, профиль, состояние, git, playwright, запуск адвоката",
		handler: async (_args, ctx) => {
			const text = doctorReport(ctx.cwd);
			pi.sendMessage({ customType: "volna-doctor", content: text, display: true }, { triggerTurn: false });
		},
	});

	pi.registerCommand("volna:off", {
		description: "Волна: заглушить шапку и подсказки (гейты остаются)",
		handler: async (_args, ctx) => {
			const volnaDir = findVolnaDir(ctx.cwd);
			if (!volnaDir) {
				ctx.ui.notify("Волна здесь не развёрнута", "warning");
				return;
			}
			writeState(volnaDir, { muted: true, updated: stamp() });
			ctx.ui.notify("Волна заглушена: шапки и подсказок не будет. Вернуть - /volna:on", "info");
		},
	});

	pi.registerCommand("volna:on", {
		description: "Волна: вернуть шапку и подсказки",
		handler: async (_args, ctx) => {
			const volnaDir = findVolnaDir(ctx.cwd);
			if (!volnaDir) {
				ctx.ui.notify("Волна здесь не развёрнута", "warning");
				return;
			}
			writeState(volnaDir, { muted: false, updated: stamp() });
			ctx.ui.notify("Волна снова сопровождает работу", "info");
		},
	});
}

/** Проверки настройки. Каждая строка отвечает на вопрос «что сломается, если этого нет». */
export function doctorReport(cwd: string): string {
	const lines: string[] = ["# Волна: проверка настройки", ""];
	const volnaDir = findVolnaDir(cwd);
	if (!volnaDir) {
		lines.push("- .volna: не найден. Флоу и журнал недоступны, разверни командой /volna:init.");
		return lines.join("\n");
	}
	const root = workspaceRoot(volnaDir);
	const paths = volnaPaths(volnaDir);
	lines.push(`- .volna: ${volnaDir}`);
	lines.push(`- рабочее дерево: ${root}`);

	const profile = readProfile(volnaDir);
	const keys = ["тесты", "сборка", "запуск", "визуальная проверка", "эталон", "трекер", "вики", "kb", "модель адвоката", "скриншот модели"];
	const unanswered = keys.filter((key) => profile[key] && !profileValue(profile, key));
	const missing = keys.filter((key) => !profile[key]);
	lines.push(
		existsSync(paths.project)
			? `- профиль: ${paths.project}${unanswered.length ? `; не заполнены: ${unanswered.join(", ")}` : ""}${missing.length ? `; строк нет: ${missing.join(", ")}` : ""}`
			: "- профиль: файла project.md нет. Этапы будут спрашивать про проект каждый раз.",
	);

	const state = readState(volnaDir);
	lines.push(`- активная задача: ${state.active ?? "нет"}${state.muted ? " (сопровождение заглушено)" : ""}`);
	if (state.unknown.length) {
		lines.push(`- ! в state.json неизвестные ключи: ${state.unknown.join(", ")}. Из-за них шапка и гейты молчат.`);
	}
	const active = loadActive(cwd);
	if (state.active && !active) {
		lines.push(`- ! журнала для задачи ${state.active} нет: проверь ${paths.journalDir}`);
	}
	if (active) {
		const issues = journalIssues(active);
		lines.push(issues.length ? `- ! журнал: ${issues.join("; ")}` : "- журнал: в порядке, задача восстановима");
	}

	lines.push(
		existsSync(join(root, ".git"))
			? "- git: репозиторий на месте (адвокат сравнивает дифф против HEAD)"
			: "- ! git: репозитория нет. Адвокату не с чем сравнивать - он вернёт «проверять нечего».",
	);

	const script = process.argv[1];
	lines.push(
		script && existsSync(script)
			? `- запуск адвоката: подпроцесс пойдёт через ${script}`
			: "- запуск адвоката: подпроцесс пойдёт командой pi из PATH",
	);

	lines.push(`- playwright: ${playwrightState(root)}`);
	lines.push("", `Проверено ${stamp()}.`);
	return lines.join("\n");
}

/** Есть ли playwright в проверяемом проекте. Визуальный этап опционален - его отсутствие не ошибка. */
function playwrightState(root: string): string {
	try {
		const requireFromProject = createRequire(join(root, "package.json"));
		requireFromProject.resolve("playwright");
		return "есть в проекте (визуальная проверка доступна)";
	} catch {}
	try {
		createRequire(import.meta.url).resolve("playwright");
		return "есть рядом с пакетом Волны";
	} catch {}
	return "нет. Визуальный этап пропустится: npm i -D playwright && npx playwright install chromium";
}
