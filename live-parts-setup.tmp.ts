/** Живая постановка TASK-010 в проекте llm-wiki: задача, этапы, части с критериями. Удалить после. */
import { enterStage, intake } from "./extensions/volna/core.ts";
import { appendLogSection, writeStateSection } from "./extensions/volna/journal.ts";
import { partBrief, parsePartBriefs } from "./extensions/volna/parts.ts";
import { volnaPaths } from "./extensions/volna/paths.ts";
import { partsRunReadiness } from "./extensions/volna/runner.ts";
import { loadActive, readState, updateFrontmatter } from "./extensions/volna/state.ts";
import { exec } from "./tests/harness.ts";
import { readFileSync } from "node:fs";

const cwd = "D:/Projects/Pi/Tiel-Coder-35B-A3B/wiki";
const volnaDir = `${cwd}/.volna`;

const taken = intake(cwd, { assignment: "tasks/TASK-010-web-ui.md" });
console.log(taken.ok ? taken.message.split("\n").slice(0, 7).join("\n") : `ОШИБКА: ${taken.message}`);
if (!taken.ok) process.exit(1);
const task = readState(volnaDir).active!;

await enterStage(cwd, "analyze", { exec });
appendLogSection(volnaDir, task, {
	stage: "analyze",
	fields: {
		что: "разобрал, на что опирается веб-UI в этой ветке",
		зачем: "части задачи должны опираться на то, что есть, а не на то, что описано в очереди задач",
		как: [
			"готово и вызывается напрямую: store (ReadPage/WritePage/Backlinks/RebuildIndex/Wikilinks, internal/store),",
			"ingest (SaveFile/SaveURL/SaveNote, internal/ingest), visibility.Check, auth (RequireAuth, роли owner/reader),",
			"маршруты веба: /health, /login вне аутентификации, /lint и /logout под requireAuth (cmd/llmwiki/main.go:43-108)",
			"нет вовсе: каталогов шаблонов и статики (find по *.html/*.css/*.js пуст), значит UI пишется с нуля",
			"нет в этой ветке: internal/search - пакет TASK-006 остался в неслитой ветке task/260913-task-006-poisk-zapros (7b17034)",
			"нет подключения: voice.Transcribe есть, но индикатора транскрипции в вебе нет",
		].join("\n"),
		сделано: "перечень готовых API и дыр",
		осталось: "постановка и деление на части",
	},
});

await enterStage(cwd, "spec", { exec });
appendLogSection(volnaDir, task, {
	stage: "spec",
	fields: {
		что: "постановка TASK-010 и деление на части",
		зачем: "работа не помещается в один заход: четыре независимых результата с разными критериями",
		почему: "части опираются только на готовые пакеты этой ветки - поиск и голос вынесены из сферы, иначе часть встанет на отсутствующей зависимости",
		части: [
			"1. каркас веба и список страниц",
			"   готово, когда: go build ./... и go vet ./... чисты, go test ./cmd/llmwiki/ зелёный; GET / под аутентификацией отдаёт HTML со списком страниц из index.md, частные страницы не показаны читателю (тест на reader и owner)",
			"   трогает: cmd/llmwiki/main.go, cmd/llmwiki/main_test.go, cmd/llmwiki/web/** (шаблоны и статика)",
			"   не трогает: internal/**, поиск, граф, формы наполнения",
			"   зависит от: нет",
			"2. страница вики: wikilinks и бэклинки",
			"   готово, когда: go test ./cmd/llmwiki/ зелёный; GET /page/<slug> рендерит тело страницы, [[slug]] превращены в ссылки, внизу список бэклинков из store.Backlinks; страница вне видимости актора отдаёт 404, а не текст",
			"   трогает: cmd/llmwiki/main.go, cmd/llmwiki/main_test.go, cmd/llmwiki/web/**",
			"   не трогает: internal/**, формы наполнения, граф",
			"   зависит от: часть 1",
			"3. формы наполнения: файл, ссылка, заметка",
			"   готово, когда: go test ./cmd/llmwiki/ зелёный; POST /ingest/file (multipart), /ingest/url, /ingest/note создают источник через internal/ingest с переданным visibility, значение видимости проверяется на бэкенде (неизвестное - 400), после успеха редирект на список",
			"   трогает: cmd/llmwiki/main.go, cmd/llmwiki/main_test.go, cmd/llmwiki/web/**",
			"   не трогает: internal/**, граф, поиск",
			"   зависит от: часть 1",
			"4. граф связей по wikilinks",
			"   готово, когда: go test ./cmd/llmwiki/ зелёный; GET /graph отдаёт узлы и рёбра по [[wikilinks]] (JSON плюс отрисовка SVG на странице), в графе нет страниц вне видимости актора",
			"   трогает: cmd/llmwiki/main.go, cmd/llmwiki/main_test.go, cmd/llmwiki/web/**",
			"   не трогает: internal/**, поиск, голос",
			"   зависит от: часть 1",
		].join("\n"),
		сделано: "постановка, критерии приёмки по частям, границы",
		осталось: "работа по частям",
	},
});

writeStateSection(
	volnaDir && volnaPaths(volnaDir).journal(task),
	{
		goal: "TASK-010 - веб-наполнение и просмотр: страницы вики, бэклинки, формы наполнения, граф связей",
		parts: [
			"1. каркас веба и список страниц - не начата",
			"2. страница вики: wikilinks и бэклинки - не начата",
			"3. формы наполнения: файл, ссылка, заметка - не начата",
			"4. граф связей по wikilinks - не начата",
		].join("\n"),
		established:
			"готовы store, ingest, visibility, auth; шаблонов и статики в проекте нет - UI с нуля; internal/search в этой ветке отсутствует (остался в task/260913-task-006-poisk-zapros)",
		decision:
			"части опираются только на готовые пакеты; поиск по UI и индикатор транскрипции вынесены из сферы этого захода",
		done: "задача принята, разбор сделан, постановка и деление на четыре части записаны",
		next: "часть 1: каркас веба и список страниц",
		careful:
			"ветка задачи не создавалась: в профиле база master, а master стоит на начальном коммите - ветвиться от него значит потерять работу задач 007-009",
	},
	{ logText: readFileSync(volnaPaths(volnaDir).log(task), "utf8") },
);
updateFrontmatter(volnaPaths(volnaDir).journal(task), {
	open: ["поиск по UI и индикатор транскрипции: пакет search в этой ветке отсутствует - отдельной частью после слияния ветки TASK-006"],
});

console.log("=".repeat(80));
const readiness = partsRunReadiness(cwd);
console.log(`прогон готов: ${readiness.ok}${readiness.message ? ` (${readiness.message})` : ""}`);
console.log(`незакрытых частей: ${readiness.left}, следующая: ${readiness.next?.number} ${readiness.next?.title}`);
console.log(`постановок частей прочитано: ${readiness.briefs.length}, без критерия: ${readiness.withoutBrief.join(", ") || "нет"}`);
const first = partBrief(loadActive(cwd)!.logText, 1)!;
console.log(`критерий части 1 из журнала: ${first.criterion}`);
console.log(`границы: трогает ${first.touches} | не трогает ${first.avoids} | зависит от ${first.depends}`);
console.log(`всего постановок: ${parsePartBriefs(loadActive(cwd)!.logText).map((b) => `${b.number}:${b.title}`).join(", ")}`);
