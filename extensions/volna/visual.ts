/**
 * Визуальная проверка веб-выхода: браузер, ошибки консоли и сети, скриншот.
 *
 * Этап опциональный, и включается он профилем проекта, а не догадкой: у консольного проекта
 * проверять нечего. Автоматический критерий здесь настоящий - ошибка в консоли или ответ 4xx/5xx
 * это красный результат, а скриншот остаётся человеку и, если модель видит картинки, модели.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stamp } from "./journal.ts";
import { packageRoot, volnaPaths, workspaceRoot } from "./paths.ts";

export interface VisualStep {
	type: string;
	selector?: string;
	value?: string;
	key?: string;
	url?: string;
	ms?: number;
	y?: number;
	state?: string;
}

export interface VisualInput {
	volnaDir: string;
	task: string;
	url: string;
	steps?: VisualStep[];
	waitFor?: string;
	waitMs?: number;
	viewport?: { width: number; height: number };
	headless?: boolean;
	timeoutMs?: number;
}

export interface VisualReport {
	ok: boolean;
	verdict: "чисто" | "ошибки" | "не выполнено";
	summary: string;
	screenshotPath: string | null;
	raw: any;
}

export interface ExecLike {
	(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<{
		stdout: string;
		stderr: string;
		code: number;
	}>;
}

/** Прогнать проверку. Всё, что скрипту нужно, уходит в JSON-конфиг: аргументы командной строки не масштабируются. */
export async function runVisualCheck(exec: ExecLike, input: VisualInput, signal?: AbortSignal): Promise<VisualReport> {
	const paths = volnaPaths(input.volnaDir);
	mkdirSync(paths.visualDir, { recursive: true });
	const marker = stamp().replace(/[^\d]/g, "");
	const screenshotPath = join(paths.visualDir, `${input.task}-${marker}.png`);
	const configPath = join(paths.visualDir, `${input.task}-${marker}.json`);

	const config = {
		projectDir: workspaceRoot(input.volnaDir),
		url: input.url,
		steps: input.steps ?? [],
		waitFor: input.waitFor,
		waitMs: input.waitMs,
		viewport: input.viewport,
		headless: input.headless !== false,
		timeoutMs: input.timeoutMs ?? 30000,
		screenshotPath,
	};
	const { writeFileSync } = await import("node:fs");
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

	const script = join(packageRoot(), "scripts", "visual-check.mjs");
	const result = await exec(process.execPath, [script, configPath], {
		cwd: workspaceRoot(input.volnaDir),
		signal,
		timeout: (input.timeoutMs ?? 30000) + 30000,
	});

	const payload = parseLastJsonLine(result.stdout);
	if (!payload) {
		return {
			ok: false,
			verdict: "не выполнено",
			summary: [
				"Проверка не запустилась.",
				result.stderr.trim().slice(-1500) || `код выхода ${result.code}`,
			].join(" "),
			screenshotPath: null,
			raw: { stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000), code: result.code },
		};
	}

	if (payload.ok !== true) {
		return {
			ok: false,
			verdict: "не выполнено",
			summary: `${payload.message || "проверка не выполнена"}${payload.reason ? ` (${payload.reason})` : ""}`,
			screenshotPath: null,
			raw: payload,
		};
	}

	const consoleErrors: any[] = payload.consoleErrors ?? [];
	const pageErrors: any[] = payload.pageErrors ?? [];
	const badResponses: any[] = payload.badResponses ?? [];
	const failedRequests: any[] = payload.failedRequests ?? [];
	const warnings: any[] = payload.consoleWarnings ?? [];

	const problems = consoleErrors.length + pageErrors.length + badResponses.length + failedRequests.length;
	const lines: string[] = [];
	lines.push(`Страница: ${payload.url} — «${payload.title || ""}»`);
	if (consoleErrors.length) {
		lines.push(`Ошибки консоли (${consoleErrors.length}):`);
		for (const item of consoleErrors.slice(0, 15)) lines.push(`  - ${item.text}`);
	}
	if (pageErrors.length) {
		lines.push(`Необработанные исключения страницы (${pageErrors.length}):`);
		for (const item of pageErrors.slice(0, 10)) lines.push(`  - ${item.message}`);
	}
	if (badResponses.length) {
		lines.push(`Ответы 4xx/5xx (${badResponses.length}):`);
		for (const item of badResponses.slice(0, 15)) lines.push(`  - ${item.status} ${item.url}`);
	}
	if (failedRequests.length) {
		lines.push(`Неудавшиеся запросы (${failedRequests.length}):`);
		for (const item of failedRequests.slice(0, 10)) lines.push(`  - ${item.method} ${item.url}: ${item.failure}`);
	}
	if (warnings.length) {
		lines.push(`Предупреждения консоли: ${warnings.length} (на вердикт не влияют)`);
	}
	if (!problems) lines.push("Ошибок консоли и сети нет.");
	if (payload.screenshotPath) lines.push(`Скриншот: ${payload.screenshotPath}`);
	lines.push(
		problems
			? "Вердикт автоматики: ошибки. Это не заменяет взгляда человека на скриншот."
			: "Вердикт автоматики: чисто. Соответствие макету и смысл картинки автоматика не проверяет - смотрит человек.",
	);

	return {
		ok: true,
		verdict: problems ? "ошибки" : "чисто",
		summary: lines.join("\n"),
		screenshotPath: payload.screenshotPath ?? null,
		raw: payload,
	};
}

/** Скриншот как содержимое для модели. Возвращается только когда профиль это разрешил. */
export function screenshotContent(path: string): { type: "image"; data: string; mimeType: string } | null {
	try {
		return { type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/png" };
	} catch {
		return null;
	}
}

function parseLastJsonLine(stdout: string): any | null {
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i]);
		} catch {}
	}
	return null;
}
