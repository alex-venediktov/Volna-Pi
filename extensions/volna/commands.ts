/**
 * Команды для человека. Каждая команда либо делает свою работу сама (init, status, doctor, off/on),
 * либо кладёт в контекст инструкцию этапа и запускает ход - тем же кодом, что вызывает модель
 * через volna_stage. Одна дорога на двух входах: расхождение между «человек нажал» и «модель
 * решила» было бы источником самых непонятных ошибок.
 *
 * Регистрация разделена надвое. `registerSetupCommands` есть в любом каталоге: развернуть «Волну» и
 * проверить настройку нужно ровно там, где её ещё нет. Остальное - `registerCommands` - появляется
 * вместе с .volna: команда этапа без журнала не сделала бы ничего, кроме сообщения об ошибке.
 */
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { probeEndpoint, resolveEndpoint } from "./cdp.ts";
import type { ExecLike } from "./changes.ts";
import { NO_REPO_REASON } from "./changes.ts";
import { enterStage, intake, resumeTask, skipStage, statusReport } from "./core.ts";
import { deliverySettings, gitState } from "./git.ts";
import { initVolna } from "./init.ts";
import { journalIssues, stamp } from "./journal.ts";
import { findVolnaDir, volnaPaths, workspaceRoot } from "./paths.ts";
import { loadActive, loadTask, profileValue, readProfile, readState, taskField, writeState } from "./state.ts";
import { STAGES, STAGE_NAMES } from "./stages.ts";

/**
 * Подсказка пути к файлу задания. Срабатывает только на то, что уже похоже на путь: подсказывать
 * файлы тому, кто набирает задание словами, значит мешать ему на каждом слове.
 */
function fileCompletions(prefix: string): Array<{ value: string; label: string }> | null {
	const raw = prefix.startsWith("@") ? prefix.slice(1) : prefix;
	const pathLike = !/\s/.test(raw) && /^[.~]|^[\\/]|^[A-Za-z]:[\\/]|[\\/]/.test(raw);
	if (!pathLike) return null;

	const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
	const head = cut < 0 ? "" : raw.slice(0, cut + 1);
	const tail = raw.slice(cut + 1).toLowerCase();
	const base = head.startsWith("~") ? join(homedir(), head.slice(1)) : head || ".";
	let entries: Dirent[];
	try {
		entries = readdirSync(resolve(process.cwd(), base), { withFileTypes: true });
	} catch {
		return null;
	}

	const items = entries
		.filter((entry) => entry.name.toLowerCase().startsWith(tail) && (tail.startsWith(".") || !entry.name.startsWith(".")))
		.slice(0, 30)
		.map((entry) => {
			const value = `${head}${entry.name}${entry.isDirectory() ? "/" : ""}`;
			return { value, label: value };
		});
	return items.length ? items : null;
}

/** Инструкция этапа кладётся в контекст без вывода человеку: ему хватает строки статуса. */
function deliverStage(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string, note: string): void {
	pi.sendMessage({ customType: "volna-stage", content: text, display: false }, { triggerTurn: true });
	ctx.ui.notify(note, "info");
}

/**
 * Команды, которые нужны до развёртывания. `wake` включает остальной пакет сразу после init, а
 * перезагрузка ресурсов нужна ради скиллов и списка команд: их pi собирает не на каждый ввод.
 */
export function registerSetupCommands(pi: ExtensionAPI, wake: (cwd: string) => boolean): void {
	pi.registerCommand("volna:init", {
		description: "Волна: развернуть .volna в этом репозитории (профиль проекта, каталоги журнала, .gitignore)",
		handler: async (_args, ctx) => {
			const result = initVolna(ctx.cwd);
			for (const warning of result.warnings) ctx.ui.notify(`Волна: ${warning}`, "warning");
			pi.sendMessage({ customType: "volna-init", content: result.message, display: true }, { triggerTurn: false });
			wake(ctx.cwd);
			ctx.ui.notify(`Волна развёрнута: ${result.volnaDir}`, "info");
			try {
				await ctx.reload();
			} catch {
				pi.sendMessage(
					{
						customType: "volna-init",
						content: "Скиллы «Волны» подхватятся после /reload или перезапуска pi: инструменты и команды уже доступны.",
						display: true,
					},
					{ triggerTurn: false },
				);
			}
		},
	});

	pi.registerCommand("volna:doctor", {
		description: "Волна: проверить настройку - .volna, профиль, состояние, git, браузер, запуск адвоката",
		handler: async (_args, ctx) => {
			const text = await doctorReport(ctx.cwd, pi.exec);
			pi.sendMessage({ customType: "volna-doctor", content: text, display: true }, { triggerTurn: false });
		},
	});
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("volna:task", {
		description: "Волна: принять задание (текст или ссылка на файл), без аргумента - продолжить задачу со следующей части",
		getArgumentCompletions: (prefix) => fileCompletions(prefix),
		handler: async (args, ctx) => {
			const assignment = args.trim();
			const result = assignment ? intake(ctx.cwd, { assignment }) : await resumeTask(ctx.cwd, pi.exec);
			if (!result.ok) {
				ctx.ui.notify(result.message, "error");
				return;
			}
			deliverStage(
				pi,
				ctx,
				result.message,
				assignment ? `Задача ${result.task} принята, этап intake` : `Задача ${result.task} продолжается, этап ${result.stage}`,
			);
		},
	});

	for (const stage of STAGES) {
		if (stage.name === "intake") continue;
		pi.registerCommand(`volna:${stage.name}`, {
			description: `Волна: этап ${stage.name} (${stage.level}) - ${stage.title}`,
			handler: async (args, ctx) => {
				const result = await enterStage(ctx.cwd, stage.name, { reason: args.trim() || undefined, exec: pi.exec });
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
export async function doctorReport(cwd: string, exec: ExecLike): Promise<string> {
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

	const script = process.argv[1];
	lines.push(
		script && existsSync(script)
			? `- запуск адвоката: подпроцесс пойдёт через ${script}`
			: "- запуск адвоката: подпроцесс пойдёт командой pi из PATH",
	);

	const source = changeSourceLine(volnaDir, active?.task);
	lines.push(`- изменения для адвоката: ${source}`);
	lines.push(`- доставка: ${await deliveryLine(volnaDir, profile, exec)}`);

	const endpointInfo = resolveEndpoint(profileValue(profile, "endpoint браузера") || undefined);
	const browser = await probeEndpoint(endpointInfo.endpoint, 2000);
	lines.push(
		browser
			? `- браузер: ${browser} на ${endpointInfo.endpoint} (адрес из: ${endpointInfo.source}) - визуальная проверка доступна`
			: `- браузер: ${endpointInfo.endpoint} не отвечает (адрес из: ${endpointInfo.source}). Визуальный этап поднимет его вызовом chrome_devtools_navigate${endpointInfo.autoLaunchEnabled ? "" : "; автозапуск выключен в pi-chrome-devtools.json"}`,
	);
	lines.push("", `Проверено ${stamp()}.`);
	return lines.join("\n");
}

/**
 * Что сделает этап доставки. Строка в докторе потому, что доставка - единственное действие флоу,
 * которое видно снаружи: узнать про несуществующий удалённый лучше до push, а не во время.
 */
async function deliveryLine(volnaDir: string, profile: Record<string, string>, exec: ExecLike): Promise<string> {
	const delivery = deliverySettings(profile);
	if (delivery.mode === "нет") return "профиль говорит «нет» - этапа доставки в проекте не существует";
	if (delivery.mode === "") return "! строки «доставка» в профиле нет - этап deliver остановится и спросит";
	const state = await gitState(exec, workspaceRoot(volnaDir), delivery.remote);
	if (!state.repo) return `! профиль просит «${delivery.mode}», но git-репозитория здесь нет`;
	const branch = `ветка ${state.branch}, шаблон «${delivery.branchPattern}»`;
	if (delivery.mode === "commit") return `${delivery.mode}: ${branch}`;
	return `${delivery.mode}: ${branch}, удалённый ${delivery.remote}${state.hasRemote ? "" : " - такого удалённого нет"}`;
}

/**
 * Откуда адвокат возьмёт правки. Строка есть в докторе потому, что это первое, что ломается в
 * проекте без git: адвокат приходит с пустыми руками, и понять причину иначе неоткуда.
 */
function changeSourceLine(volnaDir: string, task?: string): string {
	if (!existsSync(join(workspaceRoot(volnaDir), ".git"))) {
		return `! ${NO_REPO_REASON} Этап advocate откажется работать.`;
	}
	if (!task) return "git diff против точки начала части (активной задачи нет)";
	const base = taskField(loadTask(volnaDir, task)?.fm ?? {}, "part_base");
	return base
		? `git diff против ${base.slice(0, 8)} - коммита, на котором началась текущая часть`
		: "git diff против HEAD: точка начала части ещё не записана, её ставит первая итерация implement";
}
