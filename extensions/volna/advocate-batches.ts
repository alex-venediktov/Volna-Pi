/**
 * Порции проверки: дифф режется по файлам, и один прогон адвоката берёт одну порцию.
 *
 * Причина не в контексте, а в том, что длинный прогон не доживает до вердикта. Подпроцесс снимают
 * по таймауту, и вместе с ним теряется вся работа проверки - даже те файлы, по которым вывод уже
 * был сделан. Порция маленькая, её вердикт и отчёт ложатся в журнал проверок рядом с диффом, и
 * следующий прогон продолжает с того места, где встал прошлый.
 *
 * Проверенное помечается хэшем своего куска диффа: правка после находок меняет хэш, и файл
 * возвращается в очередь сам. Смена базы сравнения (новая часть задачи) сбрасывает журнал целиком -
 * по прежней базе проверяли другие изменения.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./advocate.ts";

/** Столько байт диффа уходит в один прогон. Дальше - следующая порция. */
export const DEFAULT_BATCH_BYTES = 48 * 1024;

/** Файлов в порции не больше этого: десяток файлов - уже другая работа, чем разбор одного. */
export const MAX_BATCH_FILES = 10;

/** Имя файла журнала проверок внутри каталога диффов задачи. */
const LEDGER_NAME = "reviewed.json";

export interface DiffSection {
	path: string;
	/** Кусок диффа по этому файлу, от заголовка `diff --git` до следующего. */
	text: string;
	bytes: number;
	/** Хэш куска: меняется вместе с правкой, и по нему проверенное отличается от переделанного. */
	hash: string;
}

export interface ReviewedFile {
	file: string;
	hash: string;
	run: number;
	verdict: Verdict;
}

export interface ReviewRun {
	run: number;
	at: string;
	verdict: Verdict;
	files: string[];
	/** Имя файла с отчётом этого прогона рядом с диффом. */
	report: string;
	/** Прогон сняли по таймауту: файлы порции остались непроверенными. */
	aborted?: boolean;
}

export interface Ledger {
	/** База сравнения, по которой считались проверенные куски. Сменилась - журнал не годится. */
	base: string;
	runs: ReviewRun[];
	reviewed: ReviewedFile[];
}

export interface Batch {
	/** Номер этого прогона: прошлых прогонов плюс один. */
	number: number;
	/** Сколько прогонов выходит всего, если порции пойдут тем же размером. */
	total: number;
	sections: DiffSection[];
	/** Файлов осталось после этой порции. */
	filesLeft: number;
	/** Файлов проверено прошлыми прогонами. */
	filesDone: number;
	/** Файлов в диффе всего. */
	filesTotal: number;
}

/**
 * Разрезать дифф по файлам. Опора - заголовок `diff --git`: его ставит и git, и «Волна» для
 * файлов вне индекса. Заголовков нет вовсе (чужой формат, пустой дифф) - дифф идёт одним куском:
 * резать наугад хуже, чем честно отдать всё сразу.
 */
export function splitDiff(diff: string): DiffSection[] {
	const text = diff.trim();
	if (!text) return [];
	const lines = text.split(/\r?\n/);
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("diff --git ")) starts.push(i);
	}
	if (!starts.length) return [section("(дифф целиком)", text)];

	const out: DiffSection[] = [];
	// Всё до первого заголовка - не файл, а хвост чужого вывода: он идёт вместе с первым куском.
	const preamble = starts[0] > 0 ? `${lines.slice(0, starts[0]).join("\n")}\n` : "";
	for (let i = 0; i < starts.length; i++) {
		const from = starts[i];
		const to = i + 1 < starts.length ? starts[i + 1] : lines.length;
		const body = lines.slice(from, to).join("\n");
		out.push(section(pathOf(lines[from]), i === 0 ? `${preamble}${body}` : body));
	}
	return out;
}

function section(path: string, text: string): DiffSection {
	return {
		path,
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		hash: createHash("sha1").update(text).digest("hex").slice(0, 16),
	};
}

/** Путь из заголовка `diff --git a/x b/x`: берётся сторона b - у переименования она новая. */
function pathOf(header: string): string {
	const match = /^diff --git\s+(?:"?a\/(.+?)"?)\s+(?:"?b\/(.+?)"?)\s*$/.exec(header);
	if (match) return match[2] || match[1];
	return header.replace(/^diff --git\s+/, "").trim() || "(файл не разобран)";
}

/** Журнал проверок задачи. Другая база или битый файл - журнал считается пустым. */
export function readLedger(dir: string, base: string): Ledger {
	const path = join(dir, LEDGER_NAME);
	if (!existsSync(path)) return { base, runs: [], reviewed: [] };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Ledger;
		if (!parsed || parsed.base !== base || !Array.isArray(parsed.runs) || !Array.isArray(parsed.reviewed)) {
			return { base, runs: [], reviewed: [] };
		}
		return parsed;
	} catch {
		return { base, runs: [], reviewed: [] };
	}
}

export function writeLedger(dir: string, ledger: Ledger): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, LEDGER_NAME), `${JSON.stringify(ledger, null, "\t")}\n`, "utf8");
}

/** Проверен ли именно этот кусок: тот же файл и тот же хэш. */
export function isReviewed(ledger: Ledger, item: DiffSection): boolean {
	return ledger.reviewed.some((entry) => entry.file === item.path && entry.hash === item.hash);
}

/**
 * Что взять в этот прогон. Порция набирается по порядку файлов и обрывается на бюджете байт, но
 * один файл уходит в порцию целиком даже когда он один больше бюджета: половина диффа файла - это
 * проверка по половине кода, а её вердикт ничего не значит.
 */
export function planBatch(sections: DiffSection[], ledger: Ledger, budgetBytes = DEFAULT_BATCH_BYTES): Batch {
	const budget = budgetBytes > 0 ? budgetBytes : DEFAULT_BATCH_BYTES;
	const pending = sections.filter((item) => !isReviewed(ledger, item));
	const take = pack(pending, budget);
	return {
		number: ledger.runs.length + 1,
		total: ledger.runs.length + batchCount(pending, budget),
		sections: take,
		filesLeft: pending.length - take.length,
		filesDone: sections.length - pending.length,
		filesTotal: sections.length,
	};
}

/** Первая порция из очереди: по бюджету байт и по числу файлов. */
function pack(pending: DiffSection[], budget: number): DiffSection[] {
	const out: DiffSection[] = [];
	let bytes = 0;
	for (const item of pending) {
		if (out.length && (bytes + item.bytes > budget || out.length >= MAX_BATCH_FILES)) break;
		out.push(item);
		bytes += item.bytes;
	}
	return out;
}

/** Сколько прогонов выйдет на очередь при том же размере порции. */
function batchCount(pending: DiffSection[], budget: number): number {
	let left = pending;
	let count = 0;
	while (left.length) {
		const take = pack(left, budget);
		left = left.slice(take.length);
		count++;
	}
	return count;
}

export interface RecordRunOptions {
	dir: string;
	ledger: Ledger;
	batch: Batch;
	verdict: Verdict;
	report: string;
	at: string;
	base: string;
	/** Прогон сняли: файлы порции в проверенные не пишутся, отчёт сохраняется как есть. */
	aborted?: boolean;
}

/**
 * Записать итог прогона. Отчёт ложится файлом рядом с диффом - это и есть то, что не теряется при
 * следующем таймауте. В проверенные файлы порция уходит только с разобранным вердиктом: «не
 * определён» и снятый прогон значат, что проверять этот кусок придётся заново.
 */
export function recordRun(options: RecordRunOptions): ReviewRun {
	const { dir, ledger, batch, verdict, report } = options;
	const name = `report-${batch.number}.md`;
	mkdirSync(dir, { recursive: true });
	const head = [
		`# Порция ${batch.number} · ${options.at}`,
		"",
		`- база сравнения: ${options.base}`,
		`- вердикт: ${verdict}${options.aborted ? " (прогон снят, вывод частичный)" : ""}`,
		`- файлы порции: ${batch.sections.map((item) => item.path).join(", ") || "(пусто)"}`,
		"",
	].join("\n");
	writeFileSync(join(dir, name), `${head}\n${report.trim() || "(отчёт пуст)"}\n`, "utf8");

	const run: ReviewRun = {
		run: batch.number,
		at: options.at,
		verdict,
		files: batch.sections.map((item) => item.path),
		report: name,
	};
	if (options.aborted) run.aborted = true;
	ledger.runs.push(run);

	const countable = !options.aborted && verdict !== "не определён";
	if (countable) {
		for (const item of batch.sections) {
			ledger.reviewed = ledger.reviewed.filter((entry) => entry.file !== item.path);
			ledger.reviewed.push({ file: item.path, hash: item.hash, run: batch.number, verdict });
		}
	}
	writeLedger(dir, ledger);
	return run;
}

/** Итоги прошлых прогонов строкой: что уже проверено и с каким вердиктом. */
export function ledgerSummary(ledger: Ledger): string {
	if (!ledger.runs.length) return "";
	return ledger.runs
		.map(
			(run) =>
				`порция ${run.run}: ${run.verdict}${run.aborted ? " (снят)" : ""}, файлов ${run.files.length} (${run.files.join(", ")})`,
		)
		.join("\n");
}

/**
 * Вердикт всей проверки по журналу: худшее из того, что нашли порции. Одна порция с дефектами
 * делает проверку не чистой, сколько бы чистых порций ни было рядом. Снятые прогоны не считаются:
 * их файлы остались непроверенными и придут в следующую порцию.
 */
export function worstVerdict(ledger: Ledger): Verdict {
	const order: Verdict[] = ["дефекты", "нужен человек", "чисто"];
	const counted = ledger.runs.filter((run) => !run.aborted && run.verdict !== "не определён");
	if (!counted.length) return "не определён";
	let worst: Verdict = "чисто";
	for (const run of counted) {
		if (order.indexOf(run.verdict) < order.indexOf(worst)) worst = run.verdict;
	}
	return worst;
}
