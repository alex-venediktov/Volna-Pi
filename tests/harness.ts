/**
 * Опора для тестов: счёт проверок, песочница, запуск команд.
 *
 * Тесты идут обычным node с раздеванием типов (`node --experimental-strip-types`), без vitest:
 * ядро «Волны» не зависит от API pi, и заводить сборочную обвязку ради этого нечем оправдать.
 */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

let passed = 0;
const failures: string[] = [];

export function check(label: string, condition: boolean, extra = ""): void {
	const line = `${label}${extra ? ` — ${extra}` : ""}`;
	if (condition) {
		passed++;
		console.log(`ok   ${line}`);
		return;
	}
	failures.push(line);
	console.log(`FAIL ${line}`);
}

export function results(): { passed: number; failures: string[] } {
	return { passed, failures };
}

/** Пустой каталог под тест. Каталог с тем же именем удаляется - тест начинается с нуля. */
export function sandbox(name: string, options: { git?: boolean } = {}): string {
	const dir = join(process.env.TEMP ?? process.env.TMPDIR ?? ".", `volna-test-${name}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	if (options.git !== false) mkdirSync(join(dir, ".git"), { recursive: true });
	return dir;
}

/** Тот же контракт, что у pi.exec: тесты гоняют настоящий git, а не его подделку. */
export async function exec(
	command: string,
	args: string[],
	options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
	try {
		const { stdout, stderr } = await runFile(command, args, {
			cwd: options?.cwd,
			timeout: options?.timeout,
			maxBuffer: 64 * 1024 * 1024,
		});
		return { stdout, stderr, code: 0, killed: false };
	} catch (error: any) {
		return { stdout: error?.stdout ?? "", stderr: error?.stderr ?? String(error), code: error?.code ?? 1, killed: false };
	}
}

/** Текст ответа инструмента: содержимое, которое увидит модель. */
export function toolText(result: any): string {
	return (result?.content ?? [])
		.filter((part: any) => part?.type === "text")
		.map((part: any) => part.text)
		.join("\n");
}
