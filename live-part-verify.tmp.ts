/** Сторона оркестратора после подагента: implement, адвокат порциями, тесты, закрытие части. Удалить после. */
import { enterStage } from "./extensions/volna/core.ts";
import { appendLogSection } from "./extensions/volna/journal.ts";
import { partsFromState } from "./extensions/volna/parts.ts";
import { partsMap } from "./extensions/volna/runner.ts";
import { loadActive } from "./extensions/volna/state.ts";
import { registerTools } from "./extensions/volna/tools.ts";
import { exec } from "./tests/harness.ts";

const cwd = "D:/Projects/Pi/Tiel-Coder-35B-A3B/wiki";
const tools = new Map<string, any>();
const pi: any = { registerTool: (d: any) => tools.set(d.name, d), registerCommand: () => {}, on: () => {}, exec };
registerTools(pi);
const ctx: any = { cwd, hasUI: false, mode: "print" };
const text = (result: any) => (result?.content ?? []).map((c: any) => c.text ?? "").join("\n");

// 1. Работу части сделал подагент, но этап и запись - на оркестраторе: без итерации implement в
// журнале нет ни работы части, ни точки начала, от которой считает адвокат.
const stage = await enterStage(cwd, "implement", { reason: "часть 1 подагентом (volna_part)", exec });
console.log(`implement: ${stage.ok ? `итерация ${stage.iteration}` : stage.message}`);
const active = loadActive(cwd)!;
console.log(`точка начала части: ${String(active.fm.part_base ?? "").slice(0, 12) || "(пусто)"}`);

appendLogSection(active.volnaDir, active.task, {
	stage: "implement",
	iteration: stage.iteration,
	fields: {
		что: "часть 1 сделана подагентом: каркас веба и список страниц",
		зачем: "работа части идёт в отдельном процессе, в журнал её кладёт оркестратор - у подагента журнала нет",
		как: [
			"cmd/llmwiki/web/web.go (новый): embed шаблонов и статики, Engine с NewEngine/RenderIndex,",
			"ListPages(root, actor) читает index.md и фильтрует строки по visibility.Check",
			"cmd/llmwiki/web/templates/index.html, assets/style.css, assets/app.js - фронтенд с нуля",
			"cmd/llmwiki/main.go: GET / под requireAuth рендерит список своим шаблонизатором (у gin.New() нет HTMLRender),",
			"статика GET /assets/*filepath из embed, тоже под аутентификацией",
			"cmd/llmwiki/main_test.go: тесты на видимость в списке, 401 без токена, отдачу HTML",
		].join("\n"),
		сделано: "критерий части выполнен: go build/vet чисты, go test ./cmd/llmwiki/ зелёный, TestListPagesVisibility - читатель не видит private, владелец видит всё",
		осталось: "проверка адвокатом и закрытие части",
		знания: "подагент нашёл и починил свой же дефект: append(out, *cur) копировал строку индекса до чтения visibility, поэтому все строки уходили с пустым уровнем и отфильтровывались",
	},
});

// 2. Адвокат по порциям: вызывать, пока остались непроверенные файлы.
await enterStage(cwd, "advocate", { reason: "проверка части 1", exec });
let pending = true;
let guard = 0;
while (pending && guard < 4) {
	guard++;
	const result = await tools.get("volna_advocate").execute(
		"call-adv",
		{ focus: "часть 1: список страниц, фильтр видимости, границы части (internal/** трогать было нельзя)" },
		undefined,
		undefined,
		ctx,
	);
	const out = text(result);
	console.log("=".repeat(80));
	console.log(out.split("\n").slice(0, 6).join("\n"));
	console.log("...");
	console.log(out.split("\n").slice(-12).join("\n"));
	pending = Boolean(result.details?.pending);
}

console.log("=".repeat(80));
const fresh = loadActive(cwd)!;
console.log(`карта частей:\n${partsMap(partsFromState(fresh.stateSection))}`);
