/**
 * Прогон всех тестов: node --experimental-strip-types tests/all.ts (или npm test).
 *
 * Модели тесты не касаются - проверяется то, что должно работать одинаково при любой модели:
 * журнал, переходы этапов, гейты, сбор диффа, поведение без запущенного браузера.
 */
import { results } from "./harness.ts";
import { run as runAdvocate } from "./advocate.test.ts";
import { run as runAssignment } from "./assignment.test.ts";
import { run as runChanges } from "./changes.test.ts";
import { run as runEvents } from "./events.test.ts";
import { run as runFlow } from "./flow.test.ts";
import { run as runParts } from "./parts.test.ts";
import { run as runTools } from "./tools.test.ts";

const suites: Array<[string, () => Promise<void>]> = [
	["флоу и журнал", runFlow],
	["задание ссылкой на файл", runAssignment],
	["задача из нескольких частей", runParts],
	["инструменты", runTools],
	["события расширения", runEvents],
	["источники изменений", runChanges],
	["дифф адвоката и визуальная проверка", runAdvocate],
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
