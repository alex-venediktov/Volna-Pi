#!/usr/bin/env node
/**
 * Визуальная проверка веб-страницы: открыть, проделать шаги, собрать ошибки консоли и сети,
 * снять скриншот. Отчёт печатается в stdout одной строкой JSON.
 *
 * Скрипт не зависит от pi: его запускает расширение, но так же его можно позвать руками -
 * `node scripts/visual-check.mjs config.json`. Playwright ищется в проверяемом проекте, а не
 * рядом со скриптом: браузеры ставит тот, кто их использует.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const configPath = process.argv[2];
if (!configPath) {
	out({ ok: false, reason: "no-config", message: "Ожидался путь к JSON-конфигу первым аргументом." });
	process.exit(2);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const projectDir = resolve(config.projectDir || process.cwd());
const timeoutMs = Number(config.timeoutMs) || 30000;

const playwright = await loadPlaywright(projectDir);
if (!playwright) {
	out({
		ok: false,
		reason: "playwright-missing",
		message:
			"Playwright не найден. Установи в проекте: npm i -D playwright && npx playwright install chromium. " +
			"Либо поставь глобально и запусти снова.",
	});
	process.exit(3);
}

const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];
const badResponses = [];

let browser;
let exitCode = 0;
try {
	browser = await playwright.chromium.launch({ headless: config.headless !== false });
	const context = await browser.newContext({
		viewport: config.viewport || { width: 1440, height: 900 },
		ignoreHTTPSErrors: true,
	});
	const page = await context.newPage();
	page.setDefaultTimeout(timeoutMs);

	page.on("console", (message) => {
		const type = message.type();
		if (type !== "error" && type !== "warning") return;
		consoleMessages.push({ type, text: message.text(), location: message.location() });
	});
	page.on("pageerror", (error) => {
		pageErrors.push({ message: String(error?.message || error), stack: String(error?.stack || "").slice(0, 2000) });
	});
	page.on("requestfailed", (request) => {
		failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText || "" });
	});
	page.on("response", (response) => {
		const status = response.status();
		if (status >= 400) badResponses.push({ url: response.url(), status });
	});

	await page.goto(config.url, { waitUntil: config.waitUntil || "networkidle" });
	for (const step of config.steps || []) {
		await runStep(page, step);
	}
	if (config.waitFor) await page.waitForSelector(config.waitFor, { state: "visible" });
	if (config.waitMs) await page.waitForTimeout(Number(config.waitMs));

	const screenshotPath = config.screenshotPath;
	if (screenshotPath) {
		await page.screenshot({ path: screenshotPath, fullPage: config.fullPage !== false });
	}

	const title = await page.title();
	const url = page.url();
	out({
		ok: true,
		url,
		title,
		screenshotPath: screenshotPath || null,
		consoleErrors: consoleMessages.filter((m) => m.type === "error"),
		consoleWarnings: consoleMessages.filter((m) => m.type === "warning"),
		pageErrors,
		failedRequests,
		badResponses,
	});
} catch (error) {
	exitCode = 1;
	out({
		ok: false,
		reason: "run-failed",
		message: String(error?.message || error),
		consoleErrors: consoleMessages.filter((m) => m.type === "error"),
		pageErrors,
		failedRequests,
		badResponses,
	});
} finally {
	try {
		await browser?.close();
	} catch {}
}
process.exit(exitCode);

/** Шаг сценария. Набор намеренно узкий: страница проверяется, а не автоматизируется целиком. */
async function runStep(page, step) {
	const type = String(step.type || "").toLowerCase();
	if (type === "goto") return page.goto(step.url, { waitUntil: step.waitUntil || "networkidle" });
	if (type === "click") return page.click(step.selector);
	if (type === "fill") return page.fill(step.selector, String(step.value ?? ""));
	if (type === "press") return page.press(step.selector || "body", step.key);
	if (type === "waitfor") return page.waitForSelector(step.selector, { state: step.state || "visible" });
	if (type === "wait") return page.waitForTimeout(Number(step.ms) || 500);
	if (type === "scroll") return page.evaluate((y) => window.scrollBy(0, y), Number(step.y) || 600);
	throw new Error(`Неизвестный шаг: ${step.type}`);
}

/**
 * Playwright из проверяемого проекта, иначе из глобальной установки. Резолв идёт от package.json
 * проекта: скрипт лежит в пакете «Волны», и относительный import нашёл бы не то.
 */
async function loadPlaywright(projectDir) {
	const candidates = ["playwright", "playwright-core"];
	const requireFromProject = createRequire(join(projectDir, "package.json"));
	for (const name of candidates) {
		try {
			return await import(pathToFileURL(requireFromProject.resolve(name)).href);
		} catch {}
	}
	for (const name of candidates) {
		try {
			return await import(name);
		} catch {}
	}
	return null;
}

function out(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}
