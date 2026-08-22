/**
 * Доставка в git: ветка задачи, коммит части, push.
 *
 * Здесь только git и ничего кроме: другие системы контроля версий «Волна» умеет читать (см.
 * changes.ts), но писать в них - нет. Доставка меняет то, что видят другие, поэтому её правила
 * задаются профилем проекта, а не догадкой: `доставка: нет` означает, что этапа доставки в проекте
 * не существует.
 *
 * Одна ветка на задачу: части задачи ложатся в неё подряд, коммит на каждую часть (и не один, если
 * часть того требует). Ветка создаётся один раз и закрытием части не трогается.
 */
import type { ExecLike } from "./changes.ts";
import { profileValue } from "./state.ts";

export type DeliveryMode = "" | "нет" | "commit" | "commit+push";

export interface Delivery {
	/** Пусто - в профиле не сказано: этап доставки спросит человека, а не решит сам. */
	mode: DeliveryMode;
	/** Шаблон имени ветки либо «нет»: работаем в текущей. */
	branchPattern: string;
	/** От чего ответвляться. Пусто - от текущей ветки. */
	base: string;
	remote: string;
}

export interface GitState {
	repo: boolean;
	branch: string;
	/** Файлы рабочего дерева с изменениями, как их печатает git status --porcelain. */
	dirty: string[];
	hasRemote: boolean;
	upstream: string | null;
	/** Коммитов впереди upstream. Нет upstream - null: сравнивать не с чем. */
	ahead: number | null;
}

/** Настройки доставки из профиля проекта. Чего в профиле нет, того этап не делает. */
export function deliverySettings(profile: Record<string, string>): Delivery {
	const raw = profileValue(profile, "доставка").trim().toLowerCase();
	const mode: DeliveryMode =
		raw === "" ? "" : ["нет", "no", "none"].includes(raw) ? "нет" : raw.includes("push") ? "commit+push" : "commit";
	return {
		mode,
		branchPattern: profileValue(profile, "ветка") || "<тип>/<задача>",
		base: profileValue(profile, "база"),
		remote: profileValue(profile, "удалённый") || "origin",
	};
}

/** Тип задачи в слово ветки: словарь один на проект, чтобы имена ветвей не расходились. */
const BRANCH_KIND: Record<string, string> = { bug: "bugfix", story: "feature", task: "feature", research: "research" };

/** Имя ветки по шаблону профиля: `<тип>`, `<задача>`, `<слаг>`. */
export function branchFor(pattern: string, task: { id: string; type: string }): string {
	const slug = task.id.replace(/^\d{6}-/, "");
	return pattern
		.replace(/<тип>/gi, BRANCH_KIND[task.type] ?? "feature")
		.replace(/<задача>/gi, task.id)
		.replace(/<слаг>/gi, slug)
		.trim();
}

export async function gitState(exec: ExecLike, root: string, remote: string, signal?: AbortSignal): Promise<GitState> {
	const empty: GitState = { repo: false, branch: "", dirty: [], hasRemote: false, upstream: null, ahead: null };
	const inside = await git(exec, root, ["rev-parse", "--is-inside-work-tree"], signal);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") return empty;

	const branch = (await git(exec, root, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
	const status = await git(exec, root, ["status", "--porcelain"], signal);
	const remotes = await git(exec, root, ["remote"], signal);
	const upstreamCall = await git(exec, root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], signal);
	const upstream = upstreamCall.code === 0 ? upstreamCall.stdout.trim() : null;
	let ahead: number | null = null;
	if (upstream) {
		const count = await git(exec, root, ["rev-list", "--count", "@{u}..HEAD"], signal);
		ahead = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : null;
	}
	return {
		repo: true,
		branch,
		dirty: status.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
		hasRemote: remotes.stdout.split(/\r?\n/).map((line) => line.trim()).includes(remote),
		upstream,
		ahead,
	};
}

export interface BranchResult {
	ok: boolean;
	branch: string;
	created: boolean;
	message: string;
}

/**
 * Ветка задачи. Создаётся один раз: повторный вызов на своей ветке ничего не делает.
 * Переход на уже существующую чужую ветку с грязным деревом не делается - правки уехали бы с ней.
 */
export async function ensureBranch(
	exec: ExecLike,
	root: string,
	options: { branch: string; base?: string; dirty: boolean },
	signal?: AbortSignal,
): Promise<BranchResult> {
	const current = (await git(exec, root, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
	if (current === options.branch) {
		return { ok: true, branch: options.branch, created: false, message: `Уже на ветке ${options.branch}.` };
	}
	const exists = (await git(exec, root, ["rev-parse", "--verify", "--quiet", `refs/heads/${options.branch}`], signal)).code === 0;
	if (exists) {
		if (options.dirty) {
			return {
				ok: false,
				branch: current,
				created: false,
				message: `Ветка ${options.branch} уже есть, но в дереве есть незакоммиченные правки - переход унёс бы их с собой. Разберись с правками и повтори.`,
			};
		}
		const checkout = await git(exec, root, ["checkout", options.branch], signal);
		return checkout.code === 0
			? { ok: true, branch: options.branch, created: false, message: `Перешёл на ветку ${options.branch}.` }
			: { ok: false, branch: current, created: false, message: `git checkout не прошёл: ${errorText(checkout)}` };
	}
	const args = ["checkout", "-b", options.branch, ...(options.base ? [options.base] : [])];
	const created = await git(exec, root, args, signal);
	return created.code === 0
		? {
				ok: true,
				branch: options.branch,
				created: true,
				message: `Создал ветку ${options.branch}${options.base ? ` от ${options.base}` : ` от ${current}`}.`,
			}
		: { ok: false, branch: current, created: false, message: `Ветку создать не удалось: ${errorText(created)}` };
}

export interface CommitResult {
	ok: boolean;
	committed: boolean;
	hash: string;
	files: string[];
	message: string;
}

/** Коммит текущих правок. Пустой коммит не делается: сказать «нечего коммитить» честнее. */
export async function commitChanges(
	exec: ExecLike,
	root: string,
	options: { message: string; files?: string[] },
	signal?: AbortSignal,
): Promise<CommitResult> {
	const add = options.files?.length
		? await git(exec, root, ["add", "--", ...options.files], signal)
		: await git(exec, root, ["add", "-A"], signal);
	if (add.code !== 0) {
		return { ok: false, committed: false, hash: "", files: [], message: `git add не прошёл: ${errorText(add)}` };
	}

	const staged = await git(exec, root, ["diff", "--cached", "--name-only"], signal);
	const files = staged.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (!files.length) {
		return { ok: true, committed: false, hash: "", files: [], message: "Коммитить нечего: в индексе пусто." };
	}

	const commit = await git(exec, root, ["commit", "-m", options.message], signal);
	if (commit.code !== 0) {
		return { ok: false, committed: false, hash: "", files, message: `git commit не прошёл: ${errorText(commit)}` };
	}
	const hash = (await git(exec, root, ["rev-parse", "--short", "HEAD"], signal)).stdout.trim();
	return { ok: true, committed: true, hash, files, message: `Коммит ${hash}, файлов ${files.length}.` };
}

export interface PushResult {
	ok: boolean;
	message: string;
}

/** Отправка ветки. Upstream ставится первым push-ем, дальше обычный push. */
export async function pushBranch(
	exec: ExecLike,
	root: string,
	options: { remote: string; branch: string; upstream: string | null },
	signal?: AbortSignal,
): Promise<PushResult> {
	const args = options.upstream ? ["push"] : ["push", "--set-upstream", options.remote, options.branch];
	const push = await git(exec, root, args, signal);
	if (push.code !== 0) return { ok: false, message: `git push не прошёл: ${errorText(push)}` };
	const tail = `${push.stdout}\n${push.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3);
	return { ok: true, message: [`Ветка ${options.branch} отправлена в ${options.remote}.`, ...tail].join(" ") };
}

function git(exec: ExecLike, root: string, args: string[], signal?: AbortSignal) {
	return exec("git", ["-C", root, ...args], { signal, timeout: 120000 });
}

/** Что сказал git: сначала stderr, потому что там причина отказа. */
function errorText(result: { stdout: string; stderr: string }): string {
	return (result.stderr.trim() || result.stdout.trim() || "без вывода").split(/\r?\n/).slice(0, 3).join(" ");
}
