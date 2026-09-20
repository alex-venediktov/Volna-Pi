/**
 * Подставной собеседник по протоколу rpc для теста драйвера: отвечает на задания и по ключевому
 * слову в задании ведёт себя плохо. Живой pi для этого не годится - он требует модели, а проверяется
 * поведение самого драйвера при любой.
 *
 * Слова в задании: НЕМОЙ - не подать ни одного события, МОЛЧИ - начать ход и замолчать,
 * СПРОСИ - задать вопрос человеку, ЧУЖАЯ - закрыть в журнале не ту часть, над которой работа,
 * ПОКРУГУ - повторять один и тот же вызов, не замолкая и не доходя до потолка вызовов.
 */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const parts = buffer.split("\n");
	buffer = parts.pop();
	for (const line of parts) if (line.trim()) handle(JSON.parse(line));
});

function out(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function reply(text) {
	out({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.5 } },
		},
	});
	out({ type: "agent_settled" });
}

/** Пометить часть сделанной прямо в журнале: так ошибается сессия, закрывая не ту часть. */
function closePartInJournal(number) {
	const dir = join(process.cwd(), ".volna", "journal");
	const file = readdirSync(dir).find((name) => name.startsWith("TASK-") && name.endsWith(".md"));
	const path = join(dir, file);
	const text = readFileSync(path, "utf8");
	writeFileSync(path, text.replace(new RegExp(`^(${number}\\. .*) - не начата$`, "m"), "$1 - сделано (2026-09-19, 1ч)"), "utf8");
}

function handle(command) {
	if (command.type === "abort") return out({ type: "agent_settled" });
	if (command.type === "extension_ui_response") return reply(`вопрос снят: ${JSON.stringify(command)}`);
	if (command.type !== "prompt") return;
	const message = String(command.message);
	// Поданные задания пишутся по порядку: тест проверяет, чем сессия входит в часть
	appendFileSync(join(process.cwd(), "stub-prompts.log"), `${message.split("\n")[0]}\n`, "utf8");
	if (message.includes("НЕМОЙ")) return;
	out({ type: "agent_start" });
	if (message.includes("МОЛЧИ")) return;
	if (message.includes("СПРОСИ")) return out({ type: "extension_ui_request", id: "q1", method: "confirm", title: "отправить ветку?" });
	if (message.includes("ЧУЖАЯ")) closePartInJournal(3);
	// Круг: сессия не молчит и вызовы идут, но работа стоит. Ни сторож простоя, ни потолок вызовов
	// такого не ловят - ловит только счёт повторов одной подписи.
	if (message.includes("ПОКРУГУ")) {
		const tick = () => out({ type: "tool_execution_start", toolName: "bash", args: { command: "grep -n tip SCHEMA.md" } });
		for (let k = 0; k < 12; k++) setTimeout(tick, k * 60);
		return;
	}
	out({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } });
	reply(`готово: ${message.split("\n")[0]}`);
}
