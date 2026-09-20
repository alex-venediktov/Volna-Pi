/** Закрытие части 1 и прогон части 2 подагентом: продолжение прогона. Удалить после. */
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
const text = (r: any) => (r?.content ?? []).map((c: any) => c.text ?? "").join("\n");
const map = () => partsMap(partsFromState(loadActive(cwd)!.stateSection));

const stage = await enterStage(cwd, "unit-tests", { reason: "проверка части 1", exec });
const active = loadActive(cwd)!;
appendLogSection(active.volnaDir, active.task, {
	stage: "unit-tests",
	iteration: stage.iteration,
	fields: {
		что: "тесты части 1 прогнаны в проекте",
		зачем: "критерий части назван командами - их результат и есть свидетельство",
		как: "go build ./... и go vet ./... чисты; go test ./... зелёный по всем пакетам; gofmt -l cmd/llmwiki/ пусто",
		сделано: "TestListPagesVisibility (читатель не видит private, владелец видит всё), TestRequiresAuth (401 без токена), TestReturnsHTML",
		осталось: "закрытие части",
	},
});

const closed = await tools.get("volna_finish").execute(
	"call-close",
	{
		summary:
			"Часть 1 закрыта: каркас веба (cmd/llmwiki/web с embed шаблонов и статики), GET / под аутентификацией отдаёт список страниц из index.md с фильтром по visibility, статика из embed. Работу сделал подагент (volna_part), адвокат - «чисто», тесты проекта зелёные.",
		hours: "0.4",
		left: "доставка части человеком: ветка задачи не создавалась, коммита нет",
		part: true,
	},
	undefined,
	undefined,
	ctx,
);
console.log(text(closed).split("\n").slice(0, 3).join("\n"));
console.log("карта частей после закрытия:");
console.log(map());

console.log("=".repeat(80));
console.log("часть 2 уходит подагенту");
const started = Date.now();
let last = 0;
const result = await tools.get("volna_part").execute(
	"call-part2",
	{},
	undefined,
	(update: any) => {
		const t = (update.content ?? []).map((c: any) => c.text ?? "").join("");
		const calls = Number(/вызовов инструментов (\d+)/.exec(t)?.[1] ?? 0);
		if (calls !== last) {
			last = calls;
			process.stderr.write(`  ... вызовов ${calls} (${Math.round((Date.now() - started) / 1000)} с)\n`);
		}
	},
	ctx,
);
console.log("=".repeat(80));
console.log(`время: ${Math.round((Date.now() - started) / 1000)} с`);
console.log(JSON.stringify(result.details, null, 1));
console.log(text(result));
console.log("карта частей после прогона части 2:");
console.log(map());
