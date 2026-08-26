/**
 * Инструменты «Волны»: приём задания, переход по этапам, запись в журнал, адвокат, визуальная
 * проверка, поиск по накопленному.
 *
 * Флоу держится на инструментах, а не на просьбах в промпте: этап, номер итерации, метку времени
 * и формат секции ставит код. Модель решает, что написать, а не как это оформить и когда пометить
 * этап пройденным - иначе журнал расходится с реальностью именно там, где на него положились.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runAdvocate } from "./advocate.ts";
import type { ExecLike } from "./changes.ts";
import { branchFor, commitChanges, deliverySettings, ensureBranch, gitState, pushBranch } from "./git.ts";
import { enterStage, finishTask, intake, resumeTask, skipStage, statusReport } from "./core.ts";
import { initVolna } from "./init.ts";
import { appendLogSection, journalIssues, stamp, writeStateSection } from "./journal.ts";
import { currentPart, partsFromState } from "./parts.ts";
import { findVolnaDir, volnaPaths, workspaceRoot } from "./paths.ts";
import { displayPath, loadActive, profileValue, readProfile, taskField, updateFrontmatter } from "./state.ts";
import { STAGE_NAMES } from "./stages.ts";
import { runVisualCheck, screenshotContent } from "./visual.ts";
import { recall } from "./recall.ts";

const TASK_TYPES = ["bug", "story", "task", "research"] as const;

/**
 * Лог с диска, а не из загруженной задачи: между чтением задачи и перезаписью «Состояния» в этом
 * же ходе успевает появиться новая секция, и отметка синхронизации должна знать про неё.
 */
function freshLog(logPath: string): string {
	try {
		return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
	} catch {
		return "";
	}
}

/** Ответ инструмента: текст модели плюс детали для рендера и восстановления состояния. */
function reply(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

export function registerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "volna_init",
		label: "Волна: развернуть",
		description:
			"Deploy Volna in this repository: create .volna with the project profile and journal directories, " +
			"add ignore rules. Call it when a Volna tool says Volna is not deployed here.",
		promptSnippet: "Deploy Volna in this repository (.volna, profile, journal)",
		promptGuidelines: ["If a Volna tool reports that Volna is not deployed, call volna_init instead of asking the user to run a command."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const existing = findVolnaDir(ctx.cwd);
			if (existing) return reply(`«Волна» уже развёрнута: ${existing}`, { volnaDir: existing });
			const result = initVolna(ctx.cwd);
			return reply(result.message, { volnaDir: result.volnaDir, created: result.created, warnings: result.warnings });
		},
	});

	pi.registerTool({
		name: "volna_task",
		label: "Волна: принять задание",
		description:
			"Start a task: create its journal, open stage intake. Input is the assignment text verbatim, " +
			"or a link to the file holding it - path, @mention or file:// URL. A link that does not open is an error, not a task. " +
			"No assignment: resume the active task and enter spec of its next part.",
		promptSnippet: "Start a Volna task (creates the task journal)",
		promptGuidelines: [
			"Call volna_task when the user states a task to be tracked by Volna.",
			"After /clear on a task split into parts, call it with no assignment: it picks up the next part.",
		],
		parameters: Type.Object({
			assignment: Type.Optional(
				Type.String({
					description:
						"Assignment text verbatim, or a link to the file holding it: path from the project root, absolute path, @mention or file:// URL. Omit to resume the active task",
				}),
			),
			title: Type.Optional(Type.String({ description: "Short task name; defaults to first meaningful line" })),
			type: Type.Optional(StringEnum(TASK_TYPES, { description: "Default: task" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = params.assignment?.trim()
				? intake(ctx.cwd, { assignment: params.assignment, title: params.title, type: params.type })
				: await resumeTask(ctx.cwd, pi.exec);
			if (!result.ok) throw new Error(result.message);
			const text = [result.message, ...result.warnings.map((w) => `\nПредупреждение: ${w}`)].join("\n");
			return reply(text, { task: result.task, stage: result.stage });
		},
	});

	pi.registerTool({
		name: "volna_stage",
		label: "Волна: этап",
		description: "Enter a flow stage (or reopen it as a new iteration), or skip it with a reason. Returns the stage instructions and task context.",
		promptSnippet: "Enter or skip a Volna flow stage",
		promptGuidelines: [
			"Always change stage by calling volna_stage, never by just saying so: the tool is what records it.",
			"Calling it for an already passed stage opens iteration N+1 - pass reason.",
		],
		parameters: Type.Object({
			stage: StringEnum(STAGE_NAMES as unknown as readonly string[]),
			action: Type.Optional(StringEnum(["enter", "skip"] as const, { description: "Default: enter" })),
			reason: Type.Optional(Type.String({ description: "Why returning to the stage, or why skipping it" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result =
				params.action === "skip"
					? skipStage(ctx.cwd, params.stage, params.reason ?? "")
					: await enterStage(ctx.cwd, params.stage, { reason: params.reason, exec: pi.exec });
			if (!result.ok) throw new Error(result.message);
			const text = [result.message, ...result.warnings.map((w) => `\nПредупреждение: ${w}`)].join("\n");
			return reply(text, { stage: result.stage, iteration: result.iteration, task: result.task });
		},
	});

	pi.registerTool({
		name: "volna_journal",
		label: "Волна: журнал",
		description:
			"Write the task journal, content in Russian. log: append a stage section (what/why/how/done/left...). " +
			"state: rewrite the Status the task is restored from (goal, done, next required). open: set open questions. " +
			"check: report what breaks restoration.",
		promptSnippet: "Write the task journal (log section, Status, open questions)",
		promptGuidelines: [
			"End every stage with volna_journal action=log; without it the stage counts as unfinished.",
			"Before handing the turn back to the user and before compaction, call action=state.",
			"Anything that waits for the user or external data also goes to action=open.",
		],
		parameters: Type.Object({
			action: StringEnum(["log", "state", "open", "check"] as const),
			stage: Type.Optional(Type.String()),
			what: Type.Optional(Type.String()),
			why: Type.Optional(Type.String()),
			why_chosen: Type.Optional(Type.String()),
			how: Type.Optional(Type.String({ description: "files, lines, commands, links" })),
			done: Type.Optional(Type.String()),
			left: Type.Optional(Type.String()),
			need: Type.Optional(Type.String({ description: "what is needed from outside" })),
			knowledge: Type.Optional(Type.String({ description: "knowledge entries applied" })),
			cancels: Type.Optional(Type.String({ description: "which earlier conclusion no longer holds" })),
			goal: Type.Optional(Type.String()),
			established: Type.Optional(Type.String({ description: "settled facts" })),
			decision: Type.Optional(Type.String()),
			rejected: Type.Optional(Type.String({ description: "rejected options with reasons" })),
			next: Type.Optional(Type.String({ description: "where to continue" })),
			careful: Type.Optional(Type.String({ description: "current limits and dangers" })),
			wiki: Type.Optional(Type.String({ description: "knowledge candidates" })),
			parts: Type.Optional(
				Type.String({
					description:
						"Task split into parts, one line per part: «1. название - не начата|в работе|сделано (дата, часы)|снята (причина)». Carried over untouched when omitted",
				}),
			),
			open: Type.Optional(Type.Array(Type.String())),
			branch: Type.Optional(Type.String({ description: "Task branch, recorded once when it is created: one branch per task, parts land in it one after another" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const active = loadActive(ctx.cwd);
			if (!active) throw new Error("Активной задачи нет: журнал писать некуда. Прими задание через volna_task.");
			if (params.branch?.trim()) updateFrontmatter(active.journalPath, { branch: params.branch.trim() });

			if (params.action === "check") {
				const issues = journalIssues(active);
				return reply(
					issues.length ? `Журнал не восстановим как есть:\n- ${issues.join("\n- ")}` : "Журнал в порядке: задача восстановима по «Состоянию».",
					{ issues },
				);
			}

			if (params.action === "open") {
				const open = (params.open ?? []).map((item) => item.trim()).filter(Boolean);
				updateFrontmatter(active.journalPath, { open, updated: stamp() });
				return reply(open.length ? `Открытые вопросы обновлены (${open.length}).` : "Открытых вопросов не осталось.", { open });
			}

			if (params.action === "state") {
				if (!params.goal || !params.done || !params.next) {
					throw new Error("Для «Состояния» обязательны goal, done и next: без них секция не выполняет свою работу.");
				}
				writeStateSection(
					active.journalPath,
					{
						goal: params.goal,
						parts: params.parts,
						established: params.established,
						decision: params.decision,
						rejected: params.rejected,
						done: params.done,
						next: params.next,
						careful: params.careful,
						wiki: params.wiki,
					},
					{ logText: freshLog(active.logPath) },
				);
				return reply(`«Состояние» перезаписано (${stamp()}). Контекст задачи восстановим по ${displayPath(active.volnaDir, active.journalPath)}.`, {
					journal: active.journalPath,
				});
			}

			const stage = (params.stage || taskField(active.fm, "stage") || "implement").trim();
			if (!params.what || !params.done) {
				throw new Error("Для записи в лог обязательны what и done: секция без результата не перепроверяема.");
			}
			const { iteration, stamp: at } = appendLogSection(active.volnaDir, active.task, {
				stage,
				fields: {
					что: params.what,
					зачем: params.why,
					почему: params.why_chosen,
					как: params.how,
					сделано: params.done,
					осталось: params.left ?? "-",
					нужно: params.need,
					знания: params.knowledge,
					отменяет: params.cancels,
				},
			});
			updateFrontmatter(active.journalPath, { updated: at });
			return reply(`Секция записана: ${stage}, итерация ${iteration}, ${at}.`, { stage, iteration, at });
		},
	});

	pi.registerTool({
		name: "volna_advocate",
		label: "Волна: адвокат",
		description:
			"Adversarial review: a separate read-only pi process checks the current changes against the acceptance " +
			"criteria in the journal and tries to refute them. Returns findings and a verdict.",
		promptSnippet: "Review your own changes in a separate adversarial process",
		promptGuidelines: [
			"Call volna_advocate after every implement iteration: your own code cannot be judged honestly in your own context.",
			"Verdict «дефекты» means open a new implement iteration via volna_stage with the findings as reason.",
		],
		parameters: Type.Object({
			base: Type.Optional(Type.String({ description: "Comparison base; default: the commit this part started on, from the journal" })),
			focus: Type.Optional(Type.String({ description: "What to look at first: last findings, a branch, a risk" })),
			model: Type.Optional(Type.String({ description: "Reviewer model; default from project profile" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const active = loadActive(ctx.cwd);
			if (!active) throw new Error("Активной задачи нет: адвокату нечего проверять. Прими задание через volna_task.");
			const profile = readProfile(active.volnaDir);
			const model = params.model || profileValue(profile, "модель адвоката") || undefined;

			const journalContext = [
				active.stateSection ? `«Состояние» задачи:\n${active.stateSection}` : "",
				lastSectionOf(active.logText, "spec"),
				lastSectionOf(active.logText, "plan"),
			]
				.filter(Boolean)
				.join("\n\n");

			onUpdate?.({ content: [{ type: "text", text: "Адвокат запущен: собираю дифф..." }], details: {} });
			const result = await runAdvocate(
				pi.exec,
				{
					volnaDir: active.volnaDir,
					task: active.task,
					base: params.base || taskField(active.fm, "part_base") || undefined,
					focus: params.focus,
					journalContext,
					model: model === "наследовать" ? undefined : model,
					keepExtensions: ["да", "yes"].includes(profileValue(profile, "расширения адвоката").toLowerCase()),
					timeoutMs: 15 * 60 * 1000,
				},
				signal,
				(update) => {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Адвокат работает: вызовов инструментов ${update.toolCalls}\n${update.lastText.slice(-500)}`,
							},
						],
						details: {},
					});
				},
			);

			const tail =
				result.verdict === "дефекты"
					? "\n\nДальше: открой новую итерацию implement (volna_stage, stage=implement, reason - находки адвоката) и запиши находки в журнал."
					: result.verdict === "чисто"
						? "\n\nДальше: unit-tests (volna_stage, stage=unit-tests). Находки и «расхождений не найдено» всё равно идут в журнал."
						: "\n\nВердикт не однозначен: разберись с отчётом, при необходимости спроси человека.";

			const text = [
				`Адвокат: вердикт «${result.verdict}», изменённых файлов ${result.filesChanged}, вызовов инструментов ${result.toolCalls}.`,
				result.repo ? `База сравнения: ${result.changeBase}.` : "",
				result.changeNotes.length ? `Про полноту данных: ${result.changeNotes.join("; ")}` : "",
				result.model ? `Модель адвоката: ${result.model}` : "",
				`Дифф: ${result.diffPath}`,
				"",
				result.report || "(отчёт пуст)",
				tail,
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text" as const, text }],
				details: {
					verdict: result.verdict,
					diffPath: result.diffPath,
					repo: result.repo,
					changeBase: result.changeBase,
					filesChanged: result.filesChanged,
					exitCode: result.exitCode,
					toolCalls: result.toolCalls,
				},
				usage: result.usage,
			};
		},
	});

	pi.registerTool({
		name: "volna_visual",
		label: "Волна: визуальная проверка",
		description:
			"Optional browser check in the pi-chrome-devtools browser: open a page, run steps, collect console " +
			"errors, page exceptions and 4xx/5xx responses, take a screenshot.",
		promptSnippet: "Open a page in the browser and collect console errors plus a screenshot",
		promptGuidelines: [
			"Call volna_visual on stage visual when the change is visible in a browser.",
			"If it reports the browser is down, start it with chrome_devtools_navigate and call volna_visual again.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "e.g. http://localhost:5173/" }),
			steps: Type.Optional(
				Type.Array(
					Type.Object({
						type: StringEnum(["goto", "click", "fill", "press", "waitfor", "wait", "scroll"] as const),
						selector: Type.Optional(Type.String()),
						value: Type.Optional(Type.String()),
						key: Type.Optional(Type.String()),
						url: Type.Optional(Type.String()),
						ms: Type.Optional(Type.Number()),
						y: Type.Optional(Type.Number()),
					}),
				),
			),
			wait_for: Type.Optional(Type.String({ description: "selector to await before the screenshot" })),
			wait_ms: Type.Optional(Type.Number()),
			viewport_width: Type.Optional(Type.Number()),
			viewport_height: Type.Optional(Type.Number()),
			reuse_page: Type.Optional(Type.Boolean({ description: "Use the already open tab instead of a new one" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const volnaDir = findVolnaDir(ctx.cwd);
			if (!volnaDir) throw new Error("«Волна» здесь не развёрнута: нет каталога .volna. Разверни её командой /volna:init.");
			const active = loadActive(ctx.cwd);
			const task = active?.task ?? "no-task";
			const profile = readProfile(volnaDir);

			onUpdate?.({ content: [{ type: "text", text: `Открываю ${params.url}...` }], details: {} });
			const report = await runVisualCheck(
				{
					volnaDir,
					task,
					url: params.url,
					steps: params.steps,
					waitFor: params.wait_for,
					waitMs: params.wait_ms,
					viewport:
						params.viewport_width && params.viewport_height
							? { width: params.viewport_width, height: params.viewport_height }
							: undefined,
					reusePage: params.reuse_page === true,
					endpoint: profileValue(profile, "endpoint браузера") || undefined,
				},
				signal,
			);

			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
				{ type: "text", text: `Визуальная проверка: ${report.verdict}

${report.summary}` },
			];
			const attach = profileValue(profile, "скриншот модели").toLowerCase();
			if (report.screenshotPath && (attach === "да" || attach === "yes")) {
				const image = screenshotContent(report.screenshotPath);
				if (image) content.push(image);
			}
			return { content, details: { verdict: report.verdict, screenshotPath: report.screenshotPath, ...report.details } };
		},
	});

	pi.registerTool({
		name: "volna_finish",
		label: "Волна: завершить задачу",
		description:
			"Close the task: write outcome and hours to the journal, rewrite Status, clear the active task. " +
			"part=true closes the current part instead: the task, the branch and the hours stay, the next part starts from spec. Content in Russian.",
		promptSnippet: "Close the Volna task or its current part",
		promptGuidelines: [
			"Call volna_finish only on stage close and only after an explicit yes from the user.",
			"On a task split into parts pass part=true until the last one; closing the task itself needs the remainder named in left.",
		],
		parameters: Type.Object({
			summary: Type.String({ description: "Outcome: what changed for the user, what was verified" }),
			hours: Type.Optional(Type.String({ description: "Hours from journal timestamps, e.g. 3.5" })),
			left: Type.Optional(Type.String({ description: "What is left out of scope" })),
			part: Type.Optional(Type.Boolean({ description: "Close the current part only, the task stays active" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const active = loadActive(ctx.cwd);
			const undelivered = active ? await undeliveredWork(pi.exec, active.volnaDir, signal) : "";
			const result = finishTask(ctx.cwd, {
				summary: params.summary,
				hours: params.hours,
				left: params.left,
				part: params.part === true,
			});
			if (!result.ok) throw new Error(result.message);
			const warnings = [...result.warnings, ...(undelivered ? [undelivered] : [])];
			const text = [result.message, ...warnings.map((warning) => `\nПредупреждение: ${warning}`)].join("\n");
			return reply(text, { task: result.task, closed: result.closed });
		},
	});

	pi.registerTool({
		name: "volna_deliver",
		label: "Волна: доставка",
		description:
			"Deliver the work to git: create the task branch, commit this part, push. Driven by the project profile " +
			"(доставка, ветка, база, удалённый); nothing outward happens without the user's yes. status reports branch, " +
			"changed files and what is not pushed.",
		promptSnippet: "Create the task branch, commit the part, push",
		promptGuidelines: [
			"Call volna_deliver on stage deliver; profile «доставка: нет» means the stage does not exist.",
			"Commit only after the advocate passed, and push only after the user said yes.",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "branch", "commit", "push"] as const),
			message: Type.Optional(Type.String({ description: "Commit message, one line, by project convention" })),
			files: Type.Optional(Type.Array(Type.String({ description: "Paths to stage; default all changes" }))),
			base: Type.Optional(Type.String({ description: "Branch to fork from; default from the profile" })),
			confirmed: Type.Optional(Type.Boolean({ description: "The user said yes to the push in the conversation" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const active = loadActive(ctx.cwd);
			if (!active) throw new Error("Активной задачи нет: доставлять нечего. Прими задание через volna_task.");
			const root = workspaceRoot(active.volnaDir);
			const profile = readProfile(active.volnaDir);
			const delivery = deliverySettings(profile);
			if (delivery.mode === "нет") {
				throw new Error("Профиль проекта говорит «доставка: нет»: этапа доставки в этом проекте не существует. Иди к close.");
			}
			if (delivery.mode === "" && params.action !== "status") {
				throw new Error(
					"Строка «доставка» в профиле проекта не заполнена: коммитить и ветвиться по догадке нельзя. Спроси человека (нет | commit | commit+push) и запиши ответ в .volna/project.md.",
				);
			}

			const state = await gitState(pi.exec, root, delivery.remote, signal);
			if (!state.repo) {
				throw new Error(`В ${root} нет git-репозитория: доставлять некуда. Если система контроля версий другая, доставку делает человек, а профиль пусть скажет «доставка: нет».`);
			}

			const part = currentPart(partsFromState(active.stateSection));
			const partNote = part ? ` (часть ${part.number}: ${part.title})` : "";

			if (params.action === "status") {
				return reply(
					[
						`Ветка: ${state.branch}${taskField(active.fm, "branch") && taskField(active.fm, "branch") !== state.branch ? ` (в журнале записана ${taskField(active.fm, "branch")})` : ""}.`,
						`Доставка по профилю: ${delivery.mode || "не задана - спроси человека"}, удалённый ${delivery.remote}${state.hasRemote ? "" : " (такого удалённого нет)"}.`,
						state.dirty.length ? `Незакоммиченного: ${state.dirty.length} файлов\n${state.dirty.slice(0, 40).join("\n")}` : "Рабочее дерево чистое.",
						state.upstream ? `Upstream ${state.upstream}, не отправлено коммитов: ${state.ahead ?? "?"}.` : "Upstream не настроен: первый push поставит его.",
						partNote ? `Текущая часть${partNote}: коммит идёт на неё.` : "",
					]
						.filter(Boolean)
						.join("\n"),
					{ branch: state.branch, dirty: state.dirty.length, ahead: state.ahead, upstream: state.upstream },
				);
			}

			if (params.action === "branch") {
				if (delivery.branchPattern.toLowerCase() === "нет") {
					return reply(`Профиль не заводит ветку под задачу: работаем в текущей (${state.branch}).`, { branch: state.branch });
				}
				const name = branchFor(delivery.branchPattern, { id: active.task, type: taskField(active.fm, "type") || "task" });
				const result = await ensureBranch(
					pi.exec,
					root,
					{ branch: name, base: params.base || delivery.base || undefined, dirty: state.dirty.length > 0 },
					signal,
				);
				if (!result.ok) throw new Error(result.message);
				updateFrontmatter(active.journalPath, { branch: result.branch, updated: stamp() });
				return reply(`${result.message} Ветка одна на задачу: части лягут в неё подряд.`, { branch: result.branch, created: result.created });
			}

			if (params.action === "commit") {
				const message = (params.message ?? "").trim();
				if (!message) throw new Error("Нужно сообщение коммита: одна строка по конвенции проекта (секция «Конвенции» в .volna/project.md).");
				const result = await commitChanges(pi.exec, root, { message, files: params.files }, signal);
				if (!result.ok) throw new Error(result.message);
				if (!result.committed) return reply("Коммитить нечего: правок в дереве нет.", { committed: false });
				appendLogSection(active.volnaDir, active.task, {
					stage: "deliver",
					fields: {
						что: `коммит ${result.hash}${partNote}`,
						зачем: "работа передана дальше: коммит закрывает часть, а не всю задачу",
						как: `${message} · файлов ${result.files.length}: ${result.files.slice(0, 20).join(", ")}`,
						сделано: `коммит ${result.hash} в ветке ${state.branch}`,
						осталось: delivery.mode === "commit+push" ? "push" : "-",
					},
				});
				return reply(
					[
						`${result.message} Ветка ${state.branch}.`,
						delivery.mode === "commit+push" ? "Дальше push: volna_deliver action=push, только с согласия человека." : "Профиль просит только коммит: push не делаем.",
					].join(" "),
					{ committed: true, hash: result.hash, files: result.files },
				);
			}

			if (delivery.mode !== "commit+push") {
				throw new Error(`Профиль просит доставку «${delivery.mode || "не задана"}»: push не входит в неё. Спроси человека, если это изменилось.`);
			}
			if (!state.hasRemote) {
				throw new Error(`Удалённого «${delivery.remote}» в репозитории нет: push некуда. Проверь строку профиля «удалённый».`);
			}
			const allowed = ctx.hasUI
				? await ctx.ui.confirm("Волна: отправить ветку?", `git push ${delivery.remote} ${state.branch} - это увидят другие.`)
				: params.confirmed === true;
			if (!allowed) {
				throw new Error("Push не сделан: согласия человека нет. Это единственное действие флоу, которое видно снаружи.");
			}
			const pushed = await pushBranch(pi.exec, root, { remote: delivery.remote, branch: state.branch, upstream: state.upstream }, signal);
			if (!pushed.ok) throw new Error(pushed.message);
			appendLogSection(active.volnaDir, active.task, {
				stage: "deliver",
				fields: {
					что: `ветка ${state.branch} отправлена${partNote}`,
					зачем: "работа доступна остальным",
					как: `git push ${delivery.remote} ${state.branch}`,
					сделано: pushed.message,
					осталось: "-",
				},
			});
			return reply(pushed.message, { pushed: true, branch: state.branch });
		},
	});

	pi.registerTool({
		name: "volna_recall",
		label: "Волна: вспомнить",
		description: "Search past task journals and knowledge notes in .volna. Returns matching lines with file paths.",
		promptSnippet: "Search past journals and knowledge notes",
		promptGuidelines: ["Call volna_recall with keywords before analysing a task: part of the work may already be done."],
		parameters: Type.Object({
			query: Type.String({ description: "Search words" }),
			scope: Type.Optional(StringEnum(["all", "journals", "wiki"] as const, { description: "Default: all" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const volnaDir = findVolnaDir(ctx.cwd);
			if (!volnaDir) throw new Error("«Волна» здесь не развёрнута: искать нечего.");
			const found = recall(volnaDir, params.query, params.scope ?? "all");
			return reply(found.text, { hits: found.hits });
		},
	});
}

/** Статус «Волны» для человека: используется командой и подсказками. */
export function statusText(ctx: ExtensionContext): string {
	return statusReport(ctx.cwd);
}

/**
 * Работа, которая не доехала: незакоммиченные правки и неотправленные коммиты. Проверяется на
 * закрытии - после него активной задачи не станет, и о забытом коммите напомнить будет некому.
 * Доставки в профиле нет - вопроса тоже нет.
 */
async function undeliveredWork(exec: ExecLike, volnaDir: string, signal?: AbortSignal): Promise<string> {
	const delivery = deliverySettings(readProfile(volnaDir));
	if (delivery.mode === "" || delivery.mode === "нет") return "";
	const state = await gitState(exec, workspaceRoot(volnaDir), delivery.remote, signal);
	if (!state.repo) return "";
	const parts: string[] = [];
	if (state.dirty.length) parts.push(`незакоммиченных файлов ${state.dirty.length}`);
	if (delivery.mode === "commit+push" && state.ahead) parts.push(`не отправлено коммитов ${state.ahead}`);
	return parts.length ? `работа не доставлена: ${parts.join(", ")} - доставку делает этап deliver` : "";
}

/** Последняя секция этапа из лога: адвокату нужны критерии, а не весь лог. */
function lastSectionOf(logText: string, stage: string): string {
	const re = new RegExp(`^##\\s+${stage}\\s+·\\s+итерация[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\s*$)`, "gmi");
	let last = "";
	for (const match of logText.matchAll(re)) last = match[0].trim();
	return last;
}

/** Пути «Волны» строкой: используется в сообщениях команд. */
export function volnaPathsText(cwd: string): string {
	const volnaDir = findVolnaDir(cwd);
	if (!volnaDir) return "«Волна» не развёрнута";
	const paths = volnaPaths(volnaDir);
	return `${displayPath(volnaDir, paths.root)} в ${workspaceRoot(volnaDir)}`;
}
