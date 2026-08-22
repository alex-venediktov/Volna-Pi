/** Задание ссылкой на файл: как разбирается ссылка и что говорится, когда файл не открылся. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAssignment } from "../extensions/volna/assignment.ts";
import { intake } from "../extensions/volna/core.ts";
import { initVolna } from "../extensions/volna/init.ts";
import { loadActive } from "../extensions/volna/state.ts";
import { check, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	const dir = sandbox("assignment");
	initVolna(dir);
	const volnaDir = join(dir, ".volna");
	mkdirSync(join(dir, "docs"), { recursive: true });
	const file = join(dir, "docs", "order-empty.md");
	writeFileSync(file, "# Пустой список заказов\n\nВместо заглушки белый экран.\n", "utf8");

	const byPath = resolveAssignment(dir, volnaDir, "docs/order-empty.md");
	check("путь от корня проекта прочитан", !("error" in byPath) && byPath.text.includes("белый экран"));
	check("источником стал файл", !("error" in byPath) && byPath.source === "docs/order-empty.md", JSON.stringify(byPath));

	const quoted = resolveAssignment(dir, volnaDir, `"${file}"`);
	check("абсолютный путь в кавычках прочитан", !("error" in quoted) && quoted.text.includes("белый экран"));

	const mention = resolveAssignment(dir, volnaDir, "@docs/order-empty.md");
	check("@-упоминание прочитано", !("error" in mention) && mention.text.includes("белый экран"));

	const url = resolveAssignment(dir, volnaDir, pathToFileURL(file).href);
	check("адрес file:// прочитан", !("error" in url) && url.text.includes("белый экран"));

	const backslash = resolveAssignment(dir, volnaDir, "docs\\order-empty.md");
	check("путь с обратными слэшами прочитан", !("error" in backslash) && backslash.text.includes("белый экран"));

	const fromDocs = resolveAssignment(join(dir, "docs"), volnaDir, "order-empty.md");
	check("путь от текущего каталога прочитан", !("error" in fromDocs) && fromDocs.text.includes("белый экран"));

	const plain = resolveAssignment(dir, volnaDir, "Починить показ пустого списка заказов");
	check("текст задания остался текстом", !("error" in plain) && plain.source === "текст в разговоре");

	const mentionsFile = resolveAssignment(dir, volnaDir, "Обновить README.md: он врёт про установку");
	check("упоминание файла в тексте не ссылка", !("error" in mentionsFile) && mentionsFile.source === "текст в разговоре");

	const missing = resolveAssignment(dir, volnaDir, "docs/no-such.md");
	check("несуществующий файл - ошибка, а не текст", "error" in missing);
	check(
		"в ошибке видно, где искали",
		"error" in missing && missing.error.includes("docs/no-such.md"),
		"error" in missing ? missing.error : "",
	);

	const asDir = resolveAssignment(dir, volnaDir, "docs/");
	check("каталог вместо файла - ошибка", "error" in asDir, JSON.stringify(asDir).slice(0, 80));

	writeFileSync(join(dir, "docs", "empty.md"), "   \n", "utf8");
	check("пустой файл - ошибка", "error" in resolveAssignment(dir, volnaDir, "docs/empty.md"));

	writeFileSync(join(dir, "docs", "spec.pdf"), "не важно", "utf8");
	check("не текстовый формат назван вслух", "error" in resolveAssignment(dir, volnaDir, "docs/spec.pdf"));

	writeFileSync(join(dir, "docs", "dump.md"), Buffer.from([0x41, 0x00, 0x42]));
	check("двоичное содержимое не принимается", "error" in resolveAssignment(dir, volnaDir, "docs/dump.md"));

	writeFileSync(join(dir, "docs", "huge.md"), "x".repeat(200 * 1024), "utf8");
	check("слишком большой файл не принимается", "error" in resolveAssignment(dir, volnaDir, "docs/huge.md"));

	writeFileSync(join(dir, "docs", "big.md"), `Крупная постановка\n${"строка постановки\n".repeat(1200)}`, "utf8");
	const big = resolveAssignment(dir, volnaDir, "docs/big.md");
	check("про крупное задание сказано", !("error" in big) && big.warnings.length === 1, JSON.stringify(big));

	writeFileSync(join(dir, "docs", "no-title.md"), "\n\n", "utf8");
	const taken = intake(dir, { assignment: "docs/order-empty.md" });
	check("задание принято по ссылке", taken.ok, taken.message.slice(0, 80));
	check("название взято из файла", taken.message.includes("Пустой список заказов"), taken.message.slice(0, 120));
	const active = loadActive(dir)!;
	check("источник задания записан в журнал", String(active.fm.source) === "docs/order-empty.md", String(active.fm.source));
	check("текст файла ушёл в лог дословно", active.logText.includes("Вместо заглушки белый экран"));

	const broken = intake(dir, { assignment: "docs/no-such.md" });
	check("приём по битой ссылке не создаёт задачу", !broken.ok && loadActive(dir)!.task === active.task);
}
