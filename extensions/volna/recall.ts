/**
 * Поиск по накопленному: журналы прошлых задач и записи знаний.
 *
 * Возвращаются строки с указанием файла, а не файлы целиком: журнал живой задачи вырастает до
 * десятков килобайт, и чтение его подряд съедает контекст ровно там, где нужна одна строка.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { volnaPaths } from "./paths.ts";
import { displayPath } from "./state.ts";

export type RecallScope = "all" | "journals" | "wiki";

export interface RecallHit {
	file: string;
	line: number;
	text: string;
}

const MAX_HITS = 40;
const MAX_FILE_BYTES = 512 * 1024;

export function recall(volnaDir: string, query: string, scope: RecallScope = "all"): { text: string; hits: RecallHit[] } {
	const words = query
		.toLowerCase()
		.split(/[\s,;]+/)
		.map((word) => word.trim())
		.filter((word) => word.length > 2);
	if (!words.length) {
		return { text: "Слишком короткий запрос: нужны слова длиннее двух символов.", hits: [] };
	}

	const paths = volnaPaths(volnaDir);
	const roots: string[] = [];
	if (scope === "all" || scope === "journals") roots.push(paths.journalDir);
	if (scope === "all" || scope === "wiki") roots.push(paths.wikiDir);

	const hits: RecallHit[] = [];
	for (const root of roots) {
		for (const file of walk(root)) {
			if (hits.length >= MAX_HITS) break;
			let text = "";
			try {
				if (statSync(file).size > MAX_FILE_BYTES) continue;
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
				const lower = lines[i].toLowerCase();
				if (!words.some((word) => lower.includes(word))) continue;
				const clean = lines[i].trim();
				if (clean.length < 3) continue;
				hits.push({ file: displayPath(volnaDir, file), line: i + 1, text: clean.slice(0, 300) });
			}
		}
	}

	if (!hits.length) {
		return { text: `По теме «${query}» в журналах и знаниях ничего нет. Это тоже ответ: тему видим впервые.`, hits };
	}
	const lines = [`Найдено ${hits.length} совпадений по теме «${query}»:`, ""];
	for (const hit of hits) lines.push(`${hit.file}:${hit.line}  ${hit.text}`);
	if (hits.length >= MAX_HITS) lines.push("", "Показаны первые совпадения - уточни запрос, если нужного нет.");
	return { text: lines.join("\n"), hits };
}

/** Обход каталога вглубь. Ошибки чтения молчаливо пропускаются: поиск не должен падать. */
function walk(dir: string): string[] {
	const out: string[] = [];
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let isDir = false;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) out.push(...walk(full));
		else if (/\.(md|txt)$/i.test(entry)) out.push(full);
	}
	return out;
}
