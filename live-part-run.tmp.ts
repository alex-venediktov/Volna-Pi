/** Живой прогон одной части подагентом через инструмент volna_part. Удалить после. */
import { registerTools } from "./extensions/volna/tools.ts";
import { exec } from "./tests/harness.ts";

const cwd = "D:/Projects/Pi/Tiel-Coder-35B-A3B/wiki";
const part = Number(process.argv[2] ?? 1);

const tools = new Map<string, any>();
const pi: any = { registerTool: (d: any) => tools.set(d.name, d), registerCommand: () => {}, on: () => {}, exec };
registerTools(pi);

const ctx: any = { cwd, hasUI: false, mode: "print" };
const started = Date.now();
let last = 0;
const result = await tools.get("volna_part").execute(
	"call-live",
	{ part },
	undefined,
	(update: any) => {
		const text = (update.content ?? []).map((c: any) => c.text ?? "").join("");
		const calls = Number(/вызовов инструментов (\d+)/.exec(text)?.[1] ?? 0);
		if (calls !== last) {
			last = calls;
			process.stderr.write(`  ... вызовов инструментов ${calls} (${Math.round((Date.now() - started) / 1000)} с)\n`);
		}
	},
	ctx,
);

console.log("=".repeat(80));
console.log(`время: ${Math.round((Date.now() - started) / 1000)} с`);
console.log(JSON.stringify(result.details, null, 1));
console.log("-".repeat(80));
console.log((result.content ?? []).map((c: any) => c.text ?? "").join("\n"));
