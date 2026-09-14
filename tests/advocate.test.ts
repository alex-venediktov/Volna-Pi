/** Дифф для адвоката, порции проверки и разбор вердикта. Настоящий git, без обращений к модели. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectDiff, dropDiffs, parseVerdict } from "../extensions/volna/advocate.ts";
import {
	ledgerSummary,
	planBatch,
	readLedger,
	recordRun,
	splitDiff,
	worstVerdict,
} from "../extensions/volna/advocate-batches.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { advocateDiffDir } from "../extensions/volna/paths.ts";
import { runVisualCheck } from "../extensions/volna/visual.ts";
import { check, exec, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	const dir = sandbox("advocate", { git: false });
	await exec("git", ["init", "-q", dir]);
	await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
	await exec("git", ["-C", dir, "config", "user.name", "test"]);
	writeFileSync(join(dir, "list.js"), "export function render(items) {\n  return items.map(String);\n}\n", "utf8");
	await exec("git", ["-C", dir, "add", "."]);
	await exec("git", ["-C", dir, "commit", "-q", "-m", "base"]);
	writeFileSync(join(dir, "list.js"), "export function render(items) {\n  if (!items.length) return ['пусто'];\n  return items.map(String);\n}\n", "utf8");
	writeFileSync(join(dir, "empty-state.js"), "export const EMPTY = 'пусто';\n", "utf8");
	writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));

	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	// Диффы и журнал проверок лежат в системном temp и песочницу переживают: прошлый прогон теста
	// оставил бы «всё уже проверено», и порции нечего было бы брать.
	dropDiffs(volnaDir, "test-task");

	const diff = await collectDiff(exec, volnaDir, "test-task", "HEAD");
	const body = readFileSync(diff.path, "utf8");
	check("дифф собран", !diff.empty);
	check("изменённая строка в диффе", body.includes("if (!items.length)"));
	check("новый файл в диффе", body.includes("empty-state.js") && body.includes("EMPTY"));
	check("бинарный файл не вставлен", body.includes("бинарный файл"), "blob.bin");
	check("git найден", diff.repo);
	check("сводка изменений есть", diff.stat.includes("list.js"));
	check("дифф лежит вне проекта, в системном temp", !diff.path.includes(".volna") && diff.path.includes("volna-advocate"), diff.path);
	check("дифф возвращается и текстом, не только файлом", diff.text.includes("if (!items.length)"));
	batchesKeepWhatWasChecked(volnaDir, diff.text, diff.base);

	check("диффы задачи убираются", dropDiffs(volnaDir, "test-task") && !existsSync(diff.path));
	check("служебное «Волны» в дифф не попало", !body.includes("новый файл, ещё не в индексе: .volna"));

	check("вердикт разбирается", parseVerdict("...текст...\nВЕРДИКТ: дефекты") === "дефекты");
	check("вердикт не выдумывается", parseVerdict("всё хорошо") === "не определён");
	check("вердикт всей проверки - худший из порций", worstVerdict({
		base: "HEAD",
		runs: [
			{ run: 1, at: "2026-09-14 10:00", verdict: "чисто", files: ["a"], report: "report-1.md" },
			{ run: 2, at: "2026-09-14 10:10", verdict: "дефекты", files: ["b"], report: "report-2.md" },
		],
		reviewed: [],
	}) === "дефекты");
	check("снятый прогон вердикт проверки не портит", worstVerdict({
		base: "HEAD",
		runs: [
			{ run: 1, at: "2026-09-14 10:00", verdict: "чисто", files: ["a"], report: "report-1.md" },
			{ run: 2, at: "2026-09-14 10:10", verdict: "не определён", files: ["b"], report: "report-2.md", aborted: true },
		],
		reviewed: [],
	}) === "чисто");

	// заведомо закрытый порт: проверка обязана честно сказать, что браузера нет, а не упасть
	const visual = await runVisualCheck({ volnaDir, task: "test-task", url: "http://127.0.0.1:9/", endpoint: "http://127.0.0.1:9" });
	check("без браузера проверка не падает", visual.verdict === "не выполнено", visual.verdict);
	check("сказано, что браузер не отвечает", visual.summary.includes("не отвечает"), visual.summary.slice(0, 90));
	check("подсказан способ поднять браузер", visual.summary.includes("chrome_devtools_navigate") || visual.summary.includes("remote-debugging-port"));
}

/**
 * Порции проверки: дифф режется по файлам, итог прогона остаётся на диске, и следующая порция
 * берёт то, чего никто не разбирал. Правка возвращает файл в очередь сама.
 */
function batchesKeepWhatWasChecked(volnaDir: string, diff: string, base: string): void {
	const dir = advocateDiffDir(volnaDir, "test-task");
	const sections = splitDiff(diff);
	check("дифф разрезан по файлам", sections.length >= 2, `${sections.length}: ${sections.map((s) => s.path).join(", ")}`);
	check("файл вне индекса тоже стал куском", sections.some((s) => s.path === "empty-state.js"), sections.map((s) => s.path).join(", "));
	check("куски диффа не потеряли содержимое", sections.map((s) => s.text).join("\n").includes("if (!items.length)"));

	// бюджет меньше одного файла: файл всё равно уходит целиком - половина диффа файла ничего не значит
	const ledger = readLedger(dir, base);
	const first = planBatch(sections, ledger, 1);
	check("в порцию попадает хотя бы один файл", first.sections.length === 1, String(first.sections.length));
	check("остаток посчитан", first.filesLeft === sections.length - 1, String(first.filesLeft));
	check("порций насчитано по числу файлов", first.total === sections.length, String(first.total));

	recordRun({ dir, ledger, batch: first, verdict: "чисто", report: "проверено, замечаний нет", at: "2026-09-14 10:00", base });
	check("отчёт порции лёг на диск", existsSync(join(dir, "report-1.md")));
	check("итог порции записан в журнал проверок", readLedger(dir, base).runs.length === 1);
	check("итоги порций видны строкой", ledgerSummary(readLedger(dir, base)).includes("порция 1: чисто"), ledgerSummary(readLedger(dir, base)));

	const second = planBatch(sections, readLedger(dir, base), 1);
	check("вторая порция берёт другой файл", second.sections[0].path !== first.sections[0].path, second.sections[0].path);
	check("проверенное посчитано", second.filesDone === 1, String(second.filesDone));
	check("номер порции продолжает счёт", second.number === 2, String(second.number));

	// снятый прогон порцию не зачитывает: её файлы обязаны прийти в следующий
	const aborted = readLedger(dir, base);
	recordRun({ dir, ledger: aborted, batch: second, verdict: "не определён", report: "прервано", at: "2026-09-14 10:05", base, aborted: true });
	const afterAbort = planBatch(sections, readLedger(dir, base), 1);
	check("снятая порция возвращается в очередь", afterAbort.sections[0].path === second.sections[0].path, afterAbort.sections[0].path);

	// правка меняет хэш куска: проверенный файл возвращается на проверку сам
	const edited = sections.map((item, index) =>
		index === 0 ? { ...item, text: `${item.text}\n+// правка после находок`, hash: `${item.hash}-new` } : item,
	);
	const afterEdit = planBatch(edited, readLedger(dir, base), 64 * 1024);
	check(
		"переделанный файл проверяется заново",
		afterEdit.sections.some((item) => item.path === sections[0].path),
		afterEdit.sections.map((item) => item.path).join(", "),
	);
	check("журнал проверок другой базы не годится", readLedger(dir, "иная-база").runs.length === 0);
}
