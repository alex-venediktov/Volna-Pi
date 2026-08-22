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
import { enterStage, intake, skipStage, statusReport } from "./core.ts";
import { appendLogSection, journalIssues, stamp, writeStateSection } from "./journal.ts";
import { findVolnaDir, volnaPaths, workspaceRoot } from "./paths.ts";
import { displayPath, loadActive, profileValue, readProfile, taskField, taskList, updateFrontmatter, writeState } from "./state.ts";
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
		name: "volna_task",
		label: "Волна: принять задание",
		description:
			"Принять задание в работу: создать журнал задачи и открыть этап intake. Задание передаётся текстом " +
			"или путём к md-файлу. Возвращает карточку задачи и следующий шаг флоу.",
		promptSnippet: "Принять задание в работу «Волны» (создаёт журнал задачи)",
		promptGuidelines: [
			"Вызывай volna_task, когда человек ставит задачу текстом или файлом и хочет вести её по флоу «Волны».",
		],
		parameters: Type.Object({
			assignment: Type.String({ description: "Текст задания дословно либо путь к md-файлу с постановкой" }),
			title: Type.Optional(Type.String({ description: "Короткое название задачи; по умолчанию первая значимая строка задания" })),
			type: Type.Optional(StringEnum(TASK_TYPES, { description: "Тип задачи, по умолчанию task" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = intake(ctx.cwd, { assignment: params.assignment, title: params.title, type: params.type });
			if (!result.ok) throw new Error(result.message);
			const text = [result.message, ...result.warnings.map((w) => `\nПредупреждение: ${w}`)].join("\n");
			return reply(text, { task: result.task, stage: result.stage });
		},
	});

	pi.registerTool({
		name: "volna_stage",
		label: "Волна: этап",
		description:
			"Перейти на этап флоу или открыть его новую итерацию (action=enter), либо пропустить этап с причиной " +
			"(action=skip). Возвращает инструкцию этапа и контекст задачи. Этап и номер итерации записываются в журнал.",
		promptSnippet: "Перейти на этап флоу «Волны» или пропустить его с причиной",
		promptGuidelines: [
			"Переход между этапами делай вызовом volna_stage, а не текстом «перехожу к этапу»: этап в журнале ставит инструмент.",
			"Повторный вызов volna_stage на пройденный этап открывает новую итерацию - передавай reason с причиной возврата.",
		],
		parameters: Type.Object({
			stage: StringEnum(STAGE_NAMES as unknown as readonly string[], { description: "Имя этапа флоу" }),
			action: Type.Optional(StringEnum(["enter", "skip"] as const, { description: "enter - войти в этап (по умолчанию), skip - пропустить с причиной" })),
			reason: Type.Optional(Type.String({ description: "Причина: возврата на пройденный этап либо пропуска этапа" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result =
				params.action === "skip"
					? skipStage(ctx.cwd, params.stage, params.reason ?? "")
					: enterStage(ctx.cwd, params.stage, { reason: params.reason });
			if (!result.ok) throw new Error(result.message);
			const text = [result.message, ...result.warnings.map((w) => `\nПредупреждение: ${w}`)].join("\n");
			return reply(text, { stage: result.stage, iteration: result.iteration, task: result.task });
		},
	});

	pi.registerTool({
		name: "volna_journal",
		label: "Волна: журнал",
		description:
			"Запись в журнал задачи. action=log дописывает секцию этапа в append-only лог (метку времени и формат " +
			"ставит инструмент). action=state перезаписывает секцию «Состояние», по которой задача восстанавливается " +
			"с нуля. action=open обновляет список открытых вопросов. action=check возвращает, что мешает восстановлению.",
		promptSnippet: "Запись в журнал задачи: секция этапа, «Состояние», открытые вопросы",
		promptGuidelines: [
			"В конце каждого этапа вызывай volna_journal с action=log - без записи этап считается незакрытым.",
			"Перед отдачей хода человеку и перед сжатием контекста вызывай volna_journal с action=state.",
		],
		parameters: Type.Object({
			action: StringEnum(["log", "state", "open", "check"] as const),
			stage: Type.Optional(Type.String({ description: "Этап записи; по умолчанию текущий этап задачи" })),
			what: Type.Optional(Type.String({ description: "log: что делалось и сделано" })),
			why: Type.Optional(Type.String({ description: "log: какую цель закрывает" })),
			why_chosen: Type.Optional(Type.String({ description: "log: почему выбран этот вариант, если был выбор" })),
			how: Type.Optional(Type.String({ description: "log: способ - файлы, строки, команды, ссылки" })),
			done: Type.Optional(Type.String({ description: "log и state: проверяемый результат" })),
			left: Type.Optional(Type.String({ description: "log: что не доделано в этом заходе" })),
			need: Type.Optional(Type.String({ description: "log: что требуется извне" })),
			knowledge: Type.Optional(Type.String({ description: "log: какие записи знаний применены и что из них взято" })),
			cancels: Type.Optional(Type.String({ description: "log: какой прежний вывод перестал быть верным" })),
			goal: Type.Optional(Type.String({ description: "state: цель одной фразой" })),
			established: Type.Optional(Type.String({ description: "state: факты, которые больше не пересматриваются" })),
			decision: Type.Optional(Type.String({ description: "state: выбранный подход и почему именно он" })),
			rejected: Type.Optional(Type.String({ description: "state: отвергнутые варианты с причиной отказа" })),
			next: Type.Optional(Type.String({ description: "state: с чего продолжать" })),
			careful: Type.Optional(Type.String({ description: "state: ограничения и опасности, действующие сейчас" })),
			wiki: Type.Optional(Type.String({ description: "state: кандидаты в накопленные знания" })),
			open: Type.Optional(Type.Array(Type.String(), { description: "open: строки того, что ждёт человека или внешних данных" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const active = loadActive(ctx.cwd);
			if (!active) throw new Error("Активной задачи нет: журнал писать некуда. Прими задание через volna_task.");

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
			"Адвокат дьявола: отдельный процесс pi с чистым контекстом и правами только на чтение проверяет полный " +
			"дифф против базы и пытается опровергнуть решение. Возвращает находки и вердикт: чисто, дефекты или нужен человек.",
		promptSnippet: "Проверить свои изменения адвокатом дьявола в отдельном процессе",
		promptGuidelines: [
			"После каждой итерации implement вызывай volna_advocate: свой код в своём же контексте не проверяется честно.",
			"Вердикт «дефекты» - открой новую итерацию implement через volna_stage с причиной из находок.",
		],
		parameters: Type.Object({
			base: Type.Optional(Type.String({ description: "База сравнения, по умолчанию HEAD" })),
			focus: Type.Optional(Type.String({ description: "На что смотреть в первую очередь: находки прошлой итерации, конкретная ветвь, риск" })),
			model: Type.Optional(Type.String({ description: "Модель адвоката; по умолчанию из профиля проекта, иначе модель по умолчанию pi" })),
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
					base: params.base,
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
				`Адвокат: вердикт «${result.verdict}», файлов в диффе ${result.filesChanged}, вызовов инструментов ${result.toolCalls}.`,
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
			"Опциональная визуальная проверка веб-выхода в браузере, которым управляет расширение " +
			"pi-chrome-devtools: открыть страницу, проделать шаги, собрать ошибки консоли, необработанные " +
			"исключения и ответы 4xx/5xx, снять скриншот. Браузер должен быть запущен - поднимает его " +
			"chrome_devtools_navigate.",
		promptSnippet: "Открыть страницу в браузере и собрать ошибки консоли со скриншотом",
		promptGuidelines: [
			"Вызывай volna_visual на этапе visual, когда изменения видны в браузере; консольного проекта это не касается.",
			"volna_visual сказал, что браузер не отвечает - подними его вызовом chrome_devtools_navigate и повтори volna_visual.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Адрес страницы, например http://localhost:5173/" }),
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
					{ description: "Шаги сценария после загрузки страницы" },
				),
			),
			wait_for: Type.Optional(Type.String({ description: "Селектор, появление которого ждать перед скриншотом" })),
			wait_ms: Type.Optional(Type.Number({ description: "Пауза перед скриншотом, мс" })),
			viewport_width: Type.Optional(Type.Number()),
			viewport_height: Type.Optional(Type.Number()),
			reuse_page: Type.Optional(
				Type.Boolean({ description: "Работать в уже открытой вкладке вместо новой: состояние набрано руками" }),
			),
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
			"Завершить задачу: записать итог и потраченные часы в журнал, переписать «Состояние» и снять задачу с " +
			"активной. Вызывается на этапе close, после решения человека.",
		promptSnippet: "Завершить задачу «Волны»: итог, часы, снятие активной задачи",
		promptGuidelines: ["Вызывай volna_finish только на этапе close и только после явного «да» человека."],
		parameters: Type.Object({
			summary: Type.String({ description: "Итог работы: что изменилось для пользователя, что проверено" }),
			hours: Type.Optional(Type.String({ description: "Потраченные часы по меткам журнала, например «3.5»" })),
			left: Type.Optional(Type.String({ description: "Что осталось за пределами задачи" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const active = loadActive(ctx.cwd);
			if (!active) throw new Error("Активной задачи нет: завершать нечего.");
			const { iteration, stamp: at } = appendLogSection(active.volnaDir, active.task, {
				stage: "close",
				fields: {
					что: "задача закрыта",
					зачем: "зафиксировать итог и часы: после закрытия контекст исчезает",
					как: params.hours ? `часы по меткам журнала: ${params.hours}` : "часы не считались",
					сделано: params.summary,
					осталось: params.left ?? "-",
				},
			});
			writeStateSection(
					active.journalPath,
					{
						goal: taskField(active.fm, "title") || "задача",
						done: params.summary,
						next: "задача закрыта, продолжения нет",
						careful: params.left,
					},
					{ logText: freshLog(active.logPath) },
				);
			updateFrontmatter(active.journalPath, {
				stage: "close",
				stages_done: [...new Set([...taskList(active.fm, "stages_done"), "close"])],
				updated: at,
			});
			writeState(active.volnaDir, { active: null, updated: at });
			return reply(
				[
					`Задача ${active.task} закрыта (${at}), запись close, итерация ${iteration}.`,
					"Активная задача снята: шапка и гейты по ней больше не работают.",
					`Журнал остался: ${displayPath(active.volnaDir, active.journalPath)}.`,
					"Следующую задачу начинай с чистого контекста: /new или /clear, затем /volna:task.",
				].join(" "),
				{ task: active.task, closed: true },
			);
		},
	});

	pi.registerTool({
		name: "volna_recall",
		label: "Волна: вспомнить",
		description:
			"Поиск по накопленному: журналы прошлых задач и записи знаний в .volna. Возвращает совпадения строками " +
			"с указанием файла - читать целиком найденное не нужно.",
		promptSnippet: "Найти в прошлых журналах и знаниях то, что относится к теме",
		promptGuidelines: ["Перед разбором задачи вызывай volna_recall по ключевым словам: часть работы может быть уже сделана."],
		parameters: Type.Object({
			query: Type.String({ description: "Слова для поиска" }),
			scope: Type.Optional(StringEnum(["all", "journals", "wiki"] as const, { description: "Где искать, по умолчанию all" })),
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
