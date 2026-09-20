/**
 * Снимок экрана командой: договор о последней строке, отсев непохожего на картинку, выбор канала
 * по профилю. Живой команды тут нет - проверяется разбор её вывода, а он обязан работать одинаково
 * при любой команде и любом движке.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecLike } from "../extensions/volna/changes.ts";
import { lastLine, looksLikeImage, runShot, shotChannel } from "../extensions/volna/shot.ts";
import { check, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	channels();
	await command();
}

/** Канал берётся из строки профиля: особое слово либо команда. */
function channels(): void {
	check("пустая строка - канала нет", shotChannel("").kind === "нет");
	check("«нет» - канала нет", shotChannel("нет").kind === "нет");
	check("chrome-devtools узнаётся", shotChannel("chrome-devtools").kind === "chrome-devtools");
	const custom = shotChannel("tools/shot.sh --headless");
	check("всё прочее - команда", custom.kind === "команда", custom.kind);
	check(
		"команда сохранена целиком",
		custom.kind === "команда" && custom.command === "tools/shot.sh --headless",
		custom.kind === "команда" ? custom.command : "",
	);
}

/** Разбор вывода команды: договор - последняя непустая строка есть путь к картинке. */
async function command(): Promise<void> {
	check("последняя непустая строка берётся с хвоста", lastLine("шум\nещё шум\n/tmp/a.png\n\n") === "/tmp/a.png");
	check("пустой вывод даёт пустую строку", lastLine("\n\n  \n") === "");
	check("png опознаётся картинкой", looksLikeImage("/tmp/snap.PNG"));
	check("лог картинкой не считается", !looksLikeImage("/tmp/run.log"));

	const dir = sandbox("shot", { git: false });
	const shotPath = join(dir, "snap.png");
	writeFileSync(shotPath, "не-пусто", "utf8");
	const emptyPath = join(dir, "empty.png");
	writeFileSync(emptyPath, "", "utf8");

	// Поддельный exec с контрактом pi.exec: живая команда тут не нужна, проверяется разбор вывода.
	const fake =
		(stdout: string): ExecLike =>
		async () => ({ stdout, stderr: "", code: 0 });

	const good = await runShot(fake(`строим сцену\n${shotPath}`), { cwd: dir, command: "неважно" });
	check("снимок принят, когда файл есть и не пуст", good.ok && good.path === shotPath, good.summary);

	const silent = await runShot(fake(""), { cwd: dir, command: "неважно" });
	check("молчащая команда - не выполнено, а не «нечего проверять»", !silent.ok, silent.summary);
	check("в причине назван договор о последней строке", silent.summary.includes("последняя непустая строка".slice(0, 8)) || silent.summary.includes("Последняя"), silent.summary);

	const noise = await runShot(fake("всё хорошо"), { cwd: dir, command: "неважно" });
	check("строка, не похожая на картинку, за снимок не сходит", !noise.ok, noise.summary);

	const missing = await runShot(fake(join(dir, "нет-такого.png")), { cwd: dir, command: "неважно" });
	check("названный, но несуществующий файл - не выполнено", !missing.ok, missing.summary);

	const empty = await runShot(fake(emptyPath), { cwd: dir, command: "неважно" });
	check("пустой файл снимком не считается", !empty.ok, empty.summary);
	check("в причине названы нулевые байты", empty.summary.includes("0 байт"), empty.summary);

	const relative = await runShot(fake("snap.png"), { cwd: dir, command: "неважно" });
	check("относительный путь считается от каталога проекта", relative.ok && relative.path === shotPath, relative.summary);
}
