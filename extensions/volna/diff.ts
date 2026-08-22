/**
 * Unified diff своими силами: нужен там, где системы контроля версий нет вовсе и сравнение идёт
 * со снимком рабочего дерева, который «Волна» сняла сама.
 *
 * Алгоритм - наибольшая общая подпоследовательность по строкам. Для файлов, где строк слишком
 * много, сравнение вырождается в честное «файл изменён целиком»: адвокату полезнее знать границу
 * своих знаний, чем получить дифф, построенный наугад.
 */

/** Дальше этого числа строк LCS не строим: таблица растёт как произведение длин. */
const MAX_LINES = 4000;

export interface FileDiffInput {
	path: string;
	before: string | null;
	after: string | null;
	/** Почему содержимое недоступно: бинарный файл, слишком большой, копии нет. */
	note?: string;
}

/** Unified diff одного файла. Содержимого нет - в дифф уходит строка с причиной. */
export function fileDiff(input: FileDiffInput): string {
	const header = `--- a/${input.path}\n+++ b/${input.path}`;
	if (input.note) return `${header}\n@@ содержимое не сравнивается @@\n${input.note}`;
	if (input.before === null && input.after === null) return `${header}\n@@ содержимое недоступно @@`;
	if (input.before === null) return `${header}\n@@ новый файл @@\n${prefixAll(input.after ?? "", "+")}`;
	if (input.after === null) return `${header}\n@@ файл удалён @@\n${prefixAll(input.before, "-")}`;

	const before = splitLines(input.before);
	const after = splitLines(input.after);
	if (before.length > MAX_LINES || after.length > MAX_LINES) {
		return `${header}\n@@ файл слишком большой для построчного сравнения (${before.length} → ${after.length} строк) @@`;
	}

	const hunks = buildHunks(before, after);
	if (!hunks.length) return "";
	return `${header}\n${hunks.join("\n")}`;
}

function prefixAll(text: string, sign: "+" | "-"): string {
	return splitLines(text)
		.map((line) => `${sign}${line}`)
		.join("\n");
}

function splitLines(text: string): string[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

type Op = { type: "равно" | "удалено" | "добавлено"; line: string };

/** Куски диффа с тремя строками контекста вокруг изменений - как это делает git. */
function buildHunks(before: string[], after: string[]): string[] {
	const ops = diffOps(before, after);
	const context = 3;
	const hunks: string[] = [];

	let index = 0;
	let beforeLine = 1;
	let afterLine = 1;
	while (index < ops.length) {
		if (ops[index].type === "равно") {
			beforeLine++;
			afterLine++;
			index++;
			continue;
		}

		// начало куска: отступаем назад на контекст
		let start = index;
		let contextBefore = 0;
		while (start > 0 && ops[start - 1].type === "равно" && contextBefore < context) {
			start--;
			contextBefore++;
		}

		let end = index;
		let quiet = 0;
		while (end < ops.length && quiet <= context * 2) {
			if (ops[end].type === "равно") quiet++;
			else quiet = 0;
			end++;
		}
		while (end > index && ops[end - 1].type === "равно" && quiet > context) {
			end--;
			quiet--;
		}

		const body: string[] = [];
		let removed = 0;
		let added = 0;
		for (let i = start; i < end; i++) {
			const op = ops[i];
			if (op.type === "равно") {
				body.push(` ${op.line}`);
				removed++;
				added++;
			} else if (op.type === "удалено") {
				body.push(`-${op.line}`);
				removed++;
			} else {
				body.push(`+${op.line}`);
				added++;
			}
		}
		hunks.push(`@@ -${beforeLine - contextBefore},${removed} +${afterLine - contextBefore},${added} @@`, ...body);

		for (let i = index; i < end; i++) {
			if (ops[i].type !== "добавлено") beforeLine++;
			if (ops[i].type !== "удалено") afterLine++;
		}
		index = end;
	}
	return hunks;
}

/** Операции преобразования одного списка строк в другой. */
function diffOps(before: string[], after: string[]): Op[] {
	// одинаковые начала и концы в таблицу LCS не попадают: это самая частая экономия
	let head = 0;
	while (head < before.length && head < after.length && before[head] === after[head]) head++;
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < after.length - head &&
		before[before.length - 1 - tail] === after[after.length - 1 - tail]
	) {
		tail++;
	}

	const middleBefore = before.slice(head, before.length - tail);
	const middleAfter = after.slice(head, after.length - tail);
	const ops: Op[] = [];
	for (let i = 0; i < head; i++) ops.push({ type: "равно", line: before[i] });
	ops.push(...lcsOps(middleBefore, middleAfter));
	for (let i = before.length - tail; i < before.length; i++) ops.push({ type: "равно", line: before[i] });
	return ops;
}

function lcsOps(before: string[], after: string[]): Op[] {
	if (!before.length) return after.map((line) => ({ type: "добавлено" as const, line }));
	if (!after.length) return before.map((line) => ({ type: "удалено" as const, line }));

	const rows = before.length + 1;
	const cols = after.length + 1;
	const table: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < before.length && j < after.length) {
		if (before[i] === after[j]) {
			ops.push({ type: "равно", line: before[i] });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			ops.push({ type: "удалено", line: before[i] });
			i++;
		} else {
			ops.push({ type: "добавлено", line: after[j] });
			j++;
		}
	}
	while (i < before.length) ops.push({ type: "удалено", line: before[i++] });
	while (j < after.length) ops.push({ type: "добавлено", line: after[j++] });
	return ops;
}
