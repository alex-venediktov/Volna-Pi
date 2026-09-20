/**
 * Оркестратор прогона частей: часть подагентом, запись implement, адвокат порциями, тесты проекта,
 * закрытие части. Останавливается на любой развилке. Удалить после.
 */
import { readFileSync } from "node:fs";
import { enterStage } from "./extensions/volna/core.ts";
import { appendLogSection } from "./extensions/volna/journal.ts";
import { partsFromState } from "./extensions/volna/parts.ts";
import { partsMap, partsRunReadiness } from "./extensions/volna/runner.ts";
import { loadActive, updateFrontmatter } from "./extensions/volna/state.ts";
import { registerTools } from "./extensions/volna/tools.ts";
import { exec } from "./tests/harness.ts";

const cwd = "D:/Projects/Pi/Tiel-Coder-35B-A3B/wiki";
const numbers = process.argv.slice(2).map(Number).filter(Boolean);

const tools = new Map<string, any>();
const pi: any = { registerTool: (d: any) => tools.set(d.name, d), registerCommand: () => {}, on: () => {}, exec };
registerTools(pi);
const ctx: any = { cwd, hasUI: false, mode: "print" };
const text = (r: any) => (r?.content ?? []).map((c: any) => c.text ?? "").join("\n");
const call = (name: string, params: any, onUpdate?: any) => tools.get(name).execute(`call-${name}`, params, undefined, onUpdate, ctx);
const map = () => partsMap(partsFromState(loadActive(cwd)!.stateSection));

/** Команды проекта: их вывод и есть свидетельство, а не пересказ подагента. */
async function projectChecks(): Promise<{ ok: boolean; lines: string[] }> {
	const lines: string[] = [];
	let ok = true;
	for (const args of [["build", "./..."], ["vet", "./..."], ["test", "./..."]]) {
		const run = await exec("go", args, { cwd });
		const tail = `${run.stdout}${run.stderr}`.trim().split(/\r?\n/).slice(-6).join("; ") || "(пусто)";
		lines.push(`go ${args.join(" ")} -> код ${run.code}: ${tail}`);
		if (run.code !== 0) ok = false;
	}
	return { ok, lines };
}

for (const number of numbers) {
	const readiness = partsRunReadiness(cwd);
	console.log("=".repeat(80));
	console.log(`часть ${number}: прогон готов ${readiness.ok}${readiness.message ? ` (${readiness.message.split("\n")[0]})` : ""}`);
	if (!readiness.ok) break;

	const started = Date.now();
	let last = 0;
	// Часть, которую подагент уже прогнал в прошлом запуске: её отчёт лежит файлом, гонять заново
	// нечего - проверка и закрытие всё равно на оркестраторе.
	const donePart = Number(process.env.VOLNA_DONE_PART ?? 0);
	const run =
		donePart === number
			? {
					details: { outcome: /ИТОГ:\s*сделано/.test(readFileSync(process.env.VOLNA_DONE_REPORT!, "utf8")) ? "сделано" : "не определён", toolCalls: 0 },
					content: [{ type: "text", text: readFileSync(process.env.VOLNA_DONE_REPORT!, "utf8") }],
				}
			: await call("volna_part", { part: number }, (update: any) => {
		const t = (update.content ?? []).map((c: any) => c.text ?? "").join("");
		const calls = Number(/вызовов инструментов (\d+)/.exec(t)?.[1] ?? 0);
		if (calls !== last) {
			last = calls;
			process.stderr.write(`  часть ${number}: вызовов ${calls} (${Math.round((Date.now() - started) / 1000)} с)\n`);
		}
	});
	const report = text(run);
	console.log(`подагент: итог «${run.details.outcome}», вызовов ${run.details.toolCalls}, ${Math.round((Date.now() - started) / 1000)} с`);
	console.log(report.slice(0, 2500));
	if (run.details.outcome !== "сделано") {
		const active = loadActive(cwd)!;
		updateFrontmatter(active.journalPath, {
			open: [`часть ${number}: подагент вернул «${run.details.outcome}» - развилка требует человека`],
		});
		console.log("ПРОГОН ОСТАНОВЛЕН: не «сделано»");
		break;
	}

	// Работу сделал подагент, запись - на оркестраторе: без итерации implement в журнале нет ни
	// работы части, ни точки начала, от которой считает адвокат.
	const implement = await enterStage(cwd, "implement", { reason: `часть ${number} подагентом (volna_part)`, exec });
	const active = loadActive(cwd)!;
	appendLogSection(active.volnaDir, active.task, {
		stage: "implement",
		iteration: implement.iteration,
		fields: {
			что: `часть ${number} сделана подагентом`,
			зачем: "работа части идёт в отдельном процессе, в журнал её кладёт оркестратор - у подагента журнала нет",
			как: `отчёт подагента:\n${report.split("Карта частей на момент запуска")[0].trim()}`,
			сделано: "работа части закончена, дальше проверка",
			осталось: "адвокат, тесты, закрытие части",
		},
	});

	await enterStage(cwd, "advocate", { reason: `проверка части ${number}`, exec });
	let pending = true;
	let guard = 0;
	const verdicts: string[] = [];
	let reports = "";
	while (pending && guard < 5) {
		guard++;
		const adv = await call("volna_advocate", { focus: `часть ${number}: соблюдены ли её границы и критерий` });
		const out = text(adv);
		verdicts.push(`порция ${adv.details.batch}/${adv.details.batches}: ${adv.details.verdict}`);
		reports += `\n${out.split("\n").slice(-25).join("\n")}`;
		console.log(out.split("\n").slice(0, 4).join("\n"));
		pending = Boolean(adv.details.pending);
		if (adv.details.verdict === "дефекты" || adv.details.verdict === "нужен человек") break;
	}
	appendLogSection(active.volnaDir, active.task, {
		stage: "advocate",
		fields: {
			что: `проверка части ${number} адвокатом: ${verdicts.join(", ")}`,
			зачем: "свой код нельзя судить в своём контексте, а работу подагента - тем более",
			как: `порций ${verdicts.length}; отчёты адвоката:\n${reports.trim().slice(0, 4000)}`,
			сделано: verdicts.join(", "),
			осталось: "тесты проекта",
		},
	});
	if (verdicts.some((v) => v.includes("дефекты") || v.includes("нужен человек"))) {
		console.log("ПРОГОН ОСТАНОВЛЕН: адвокат не чист");
		break;
	}

	const checks = await projectChecks();
	const tests = await enterStage(cwd, "unit-tests", { reason: `проверка части ${number}`, exec });
	appendLogSection(active.volnaDir, active.task, {
		stage: "unit-tests",
		iteration: tests.iteration,
		fields: {
			что: `тесты проекта после части ${number}`,
			зачем: "критерий части назван командами - их код возврата и есть свидетельство",
			как: checks.lines.join("\n"),
			сделано: checks.ok ? "все команды профиля зелёные" : "команды профиля падают",
			осталось: checks.ok ? "закрытие части" : "разбор падения",
		},
	});
	console.log(checks.lines.join("\n"));
	if (!checks.ok) {
		console.log("ПРОГОН ОСТАНОВЛЕН: тесты проекта не зелёные");
		break;
	}

	const closed = await call("volna_finish", {
		summary: `Часть ${number} закрыта. ${(/\*\*что сделано:\*\*([\s\S]*?)\*\*свидетельства/.exec(report)?.[1] ?? "").trim().slice(0, 900)}`,
		hours: "0.3",
		left: "доставка части человеком: ветка задачи не создавалась, коммита нет",
		part: true,
	});
	console.log(text(closed).split("\n")[0]);
	console.log(map());
}

console.log("=".repeat(80));
console.log(`итоговая карта частей:\n${map()}`);
