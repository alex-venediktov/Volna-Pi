/**
 * Прогон всех тестов: node --experimental-strip-types tests/all.ts (или npm test).
 *
 * Модели тесты не касаются - проверяется то, что должно работать одинаково при любой модели:
 * журнал, переходы этапов, гейты, сбор диффа, поведение без запущенного браузера.
 */
import { results } from "./harness.ts";
import { run as runAdvocate } from "./advocate.test.ts";
import { run as runAssignment } from "./assignment.test.ts";
import { run as runAutopilot } from "./autopilot.test.ts";
import { run as runChanges } from "./changes.test.ts";
import { run as runDeliver } from "./deliver.test.ts";
import { run as runDeploy } from "./deploy.test.ts";
import { run as runDormant } from "./dormant.test.ts";
import { run as runEvents } from "./events.test.ts";
import { run as runFlow } from "./flow.test.ts";
import { run as runParts } from "./parts.test.ts";
import { run as runRunner } from "./runner.test.ts";
import { run as runShot } from "./shot.test.ts";
import { run as runTools } from "./tools.test.ts";
import { run as runWiki } from "./wiki.test.ts";

const suites: Array<[string, () => Promise<void>]> = [
	["флоу и журнал", runFlow],
	["задание ссылкой на файл", runAssignment],
	["задача из нескольких частей", runParts],
	["инструменты", runTools],
	["события расширения", runEvents],
	["развёртывание и поиск .volna", runDeploy],
	["спящий пакет без .volna", runDormant],
	["источники изменений", runChanges],
	["доставка в git", runDeliver],
	["дифф адвоката и визуальная проверка", runAdvocate],
	["снимок экрана командой", runShot],
	["вика выводов", runWiki],
	["прогон частей подагентом", runRunner],
	["внешний прогон частей сессиями pi", runAutopilot],
];

for (const [name, run] of suites) {
	console.log(`\n=== ${name} ===`);
	await run();
}

const { passed, failures } = results();
console.log(`\nпроверок пройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
	for (const failure of failures) console.log(`  FAIL ${failure}`);
	process.exitCode = 1;
}
