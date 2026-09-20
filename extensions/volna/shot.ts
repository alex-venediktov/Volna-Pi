/**
 * Снимок экрана командой проекта: второй канал зрения флоу, рядом с браузерным.
 *
 * Браузерная проверка (`visual.ts`) умеет только веб: она ходит в Chrome по CDP. Там, где выход
 * не веб - игровой движок, десктопное окно, генератор картинок, - канала зрения не было вовсе, и
 * этап `visual` молча не делал ничего. Сессия в таком проекте может утверждать лишь «запустилось
 * без ошибок», а это не визуальная проверка: сцена, в которой ничего не построилось, грузится
 * ровно так же чисто, как рабочая.
 *
 * Договор с командой один и проверяемый: **последняя непустая строка stdout - путь к картинке**.
 * Не файл, пустой файл, нет строки - результат «не выполнено», а не «нечего проверять». Молчаливый
 * пропуск здесь недопустим: он и был причиной того, что неработающие сцены уезжали закрытыми.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExecLike } from "./changes.ts";
import { isPlaceholder } from "./state.ts";

/** Расширения, которые «Волна» считает картинкой. Список закрытый: иначе путь к логу сойдёт за снимок. */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

/** Канал зрения, настроенный профилем. */
export type ShotChannel =
  | { kind: "нет" }
  | { kind: "не спрошено" }
  | { kind: "chrome-devtools" }
  | { kind: "команда"; command: string };

/**
 * Как проект показывает картинку. Значение `визуальная проверка` профиля: особое слово либо
 * команда. Команда узнаётся по тому, что она не особое слово - как у строк `тесты` и `запуск`.
 */
export function shotChannel(value: string | undefined): ShotChannel {
  const text = (value ?? "").trim();
  if (!text || text.toLowerCase() === "нет") return { kind: "нет" };
  // Значение в угловых скобках значит «человека не спросили»: за команду его принять нельзя -
  // этап обязан остановиться и спросить, а не запускать угловые скобки в оболочке.
  if (isPlaceholder(text)) return { kind: "не спрошено" };
  if (text.toLowerCase() === "chrome-devtools") return { kind: "chrome-devtools" };
  return { kind: "команда", command: text };
}

export interface ShotInput {
  cwd: string;
  command: string;
  /** Чем дополнить команду: сцена, адрес, состояние. Уходит в конец строки как есть. */
  argument?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ShotReport {
  ok: boolean;
  /** Путь к картинке, абсолютный. `null`, когда команда его не дала. */
  path: string | null;
  summary: string;
  stdout: string;
  stderr: string;
}

/** Последняя непустая строка вывода - тот самый договор. */
export function lastLine(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.length ? lines[lines.length - 1] : "";
}

/** Похоже ли на путь к картинке: расширение из закрытого списка. */
export function looksLikeImage(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function runShot(exec: ExecLike, input: ShotInput): Promise<ShotReport> {
  const command = input.argument ? `${input.command} ${input.argument}` : input.command;
  let stdout = "";
  let stderr = "";
  try {
    const result = await exec("bash", ["-lc", command], { cwd: input.cwd, signal: input.signal, timeout: input.timeoutMs });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (error) {
    return {
      ok: false,
      path: null,
      summary: `Команда снимка не запустилась: ${error instanceof Error ? error.message : String(error)}`,
      stdout,
      stderr,
    };
  }

  const line = lastLine(stdout);
  if (!line) {
    return {
      ok: false,
      path: null,
      summary:
        "Команда снимка ничего не напечатала. Последняя непустая строка её вывода должна быть путём к картинке - " +
        "по ней этап и находит, на что смотреть.",
      stdout,
      stderr,
    };
  }
  if (!looksLikeImage(line)) {
    return {
      ok: false,
      path: null,
      summary: `Последняя строка вывода не похожа на путь к картинке: ${JSON.stringify(line.slice(0, 120))}. Ожидается файл ${IMAGE_EXTENSIONS.join(", ")}.`,
      stdout,
      stderr,
    };
  }

  const path = isAbsolute(line) ? line : resolve(input.cwd, line);
  if (!existsSync(path)) {
    return { ok: false, path: null, summary: `Команда назвала снимок ${path}, но файла там нет.`, stdout, stderr };
  }
  const size = statSync(path).size;
  // Пустой файл - обычный исход снимка, снятого до того, как окно успело нарисоваться.
  if (size === 0) {
    return { ok: false, path, summary: `Снимок ${path} пустой: 0 байт. Картинки нет, смотреть не на что.`, stdout, stderr };
  }

  return { ok: true, path, summary: `Снимок снят: ${path} (${Math.round(size / 1024)} КБ).`, stdout, stderr };
}
