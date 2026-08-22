/**
 * Откуда берётся текст постановки: строка задания или ссылка на файл.
 *
 * Ссылку дают по-разному - путь от корня проекта, абсолютный путь, путь в кавычках, @-упоминание
 * файла, адрес file://, тильда от домашнего каталога. Разбор здесь один на команду и на инструмент:
 * иначе «то же самое» из чата и от модели ведёт себя по-разному.
 *
 * Ссылка, которая не открылась, - это ошибка, а не текст задания. Записать в журнал имя
 * несуществующего файла вместо постановки значит потерять задание там, где его уже не восстановить.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceRoot } from "./paths.ts";
import { displayPath } from "./state.ts";

/** Больше этого постановкой не бывает: пришёл материал, а он уходит в лог целиком. */
const MAX_BYTES = 128 * 1024;

/** С этого размера про объём говорим вслух: лог задачи растёт на столько же. */
const WARN_BYTES = 16 * 1024;

/** Форматы, в которых текста нет: их надо экспортировать, а не гадать по байтам. */
const NOT_TEXT = /\.(docx?|xlsx?|pptx?|pdf|rtf|odt|ods|odp|zip|rar|7z|gz|png|jpe?g|gif|bmp|webp|ico|exe|dll|bin)$/i;

export interface Assignment {
	/** Текст постановки: содержимое файла либо переданная строка как есть. */
	text: string;
	/** Источник для журнала: путь файла либо «текст в разговоре». */
	source: string;
	/** Название, когда в тексте не за что зацепиться: имя файла без расширения. */
	fallbackTitle?: string;
	warnings: string[];
}

/**
 * Разобрать переданное задание: файл прочитать, текст вернуть как есть.
 *
 * Пути ищутся сначала от текущего каталога, потом от корня рабочего дерева: человек набирает путь
 * относительно того места, где стоит, а модель - относительно проекта.
 */
export function resolveAssignment(cwd: string, volnaDir: string, raw: string): Assignment | { error: string } {
	const text = raw.trim();
	const link = parseReference(text);
	if (!link) return { text, source: "текст в разговоре", warnings: [] };

	const candidates = pathCandidates(cwd, volnaDir, link.value);
	const found = candidates.find(exists);
	if (found) return readAssignmentFile(found, volnaDir);
	if (!link.marked && !looksLikePath(link.value)) return { text, source: "текст в разговоре", warnings: [] };

	return {
		error: [
			`Задание задано ссылкой на файл «${link.value}», но файла там нет.`,
			`Искал: ${candidates.map((path) => displayPath(volnaDir, path)).join(", ")}.`,
			"Дай путь от корня проекта или абсолютный - либо передай текст задания строкой.",
		].join(" "),
	};
}

/** Ссылка на файл в том виде, в каком её набрали, либо null - тогда это текст задания. */
function parseReference(raw: string): { value: string; marked: boolean } | null {
	if (!raw || /\r?\n/.test(raw) || raw.length > 400) return null;
	let value = raw.replace(/^[«"'`<(]+/, "").replace(/[»"'`>)]+$/, "").trim();
	let marked = false;
	if (value.startsWith("@")) {
		value = value.slice(1).trim();
		marked = true;
	}
	if (/^file:\/\//i.test(value)) {
		try {
			value = fileURLToPath(value);
		} catch {
			return null;
		}
		marked = true;
	}
	if (/^~[\\/]/.test(value)) {
		value = join(homedir(), value.slice(2));
		marked = true;
	}
	return value ? { value, marked } : null;
}

/**
 * Строка выглядит путём: разделитель каталогов или расширение на конце и ни одного пробела.
 * Пробел разводит «README.md переехал в docs» и «docs/readme.md»: первое - задание, второе - ссылка.
 */
function looksLikePath(value: string): boolean {
	if (/\s/.test(value)) return false;
	return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

/** Куда смотреть за файлом: абсолютный путь как есть, относительный - от cwd и от корня дерева. */
function pathCandidates(cwd: string, volnaDir: string, value: string): string[] {
	if (isAbsolute(value)) return [resolve(value)];
	const out = [resolve(cwd, value), resolve(workspaceRoot(volnaDir), value)];
	return out.filter((path, index) => out.indexOf(path) === index);
}

function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Прочитать файл постановки. Что прочитать нельзя, называется вслух, а не подменяется пустотой. */
function readAssignmentFile(path: string, volnaDir: string): Assignment | { error: string } {
	const rel = displayPath(volnaDir, path);
	let size = 0;
	try {
		const stats = statSync(path);
		if (stats.isDirectory()) {
			return { error: `Ссылка ведёт на каталог ${rel}, а нужен файл с постановкой.` };
		}
		size = stats.size;
	} catch (error) {
		return { error: `Файл задания ${rel} не читается: ${(error as Error).message}` };
	}
	if (size > MAX_BYTES) {
		return {
			error: [
				`Файл задания ${rel} слишком большой (${Math.round(size / 1024)} КБ): постановка уходит в лог дословно.`,
				"Передай постановку, а материалы оставь ссылкой в тексте задания.",
			].join(" "),
		};
	}
	if (NOT_TEXT.test(path)) {
		return { error: `Файл ${rel} не текстовый - «Волна» его не разберёт. Сохрани постановку в md или txt.` };
	}

	let buffer: Buffer;
	try {
		buffer = readFileSync(path);
	} catch (error) {
		return { error: `Файл задания ${rel} не читается: ${(error as Error).message}` };
	}
	if (buffer.includes(0)) {
		return { error: `В файле ${rel} двоичные данные, текста постановки в нём нет.` };
	}
	const text = buffer.toString("utf8").replace(/^﻿/, "").trim();
	if (!text) return { error: `Файл задания ${rel} пуст - принимать нечего.` };

	const warnings: string[] = [];
	if (size > WARN_BYTES) {
		warnings.push(`задание из файла крупное (${Math.round(size / 1024)} КБ) - в лог оно уходит целиком`);
	}
	return { text, source: rel, fallbackTitle: basename(path).replace(/\.[^.]+$/, ""), warnings };
}
