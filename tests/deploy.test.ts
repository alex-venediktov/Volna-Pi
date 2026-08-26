/** Развёртывание: где «Волна» ищет свой каталог и что она заводит вне git. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initVolna, repoRootFor } from "../extensions/volna/init.ts";
import { findVolnaDir } from "../extensions/volna/paths.ts";
import { check, exec, sandbox } from "./harness.ts";

export async function run(): Promise<void> {
	await withoutGit();
	await searchBoundary();
}

/** Вне git: .volna заводится, .gitignore - нет, и человеку сказано, чего в проекте не будет. */
async function withoutGit(): Promise<void> {
	const dir = sandbox("deploy-nogit", { git: false });
	writeFileSync(join(dir, "app.js"), "let x = 1;\n", "utf8");

	const result = initVolna(dir);
	check("вне git «Волна» всё равно разворачивается", existsSync(join(dir, ".volna", "project.md")));
	check("правила для отсутствующего git не заводятся", !existsSync(join(dir, ".gitignore")));
	check("сказано, что адвоката и доставки не будет", result.warnings.join(" ").includes("advocate"), result.warnings.join(" ").slice(0, 80));
	check("предупреждение видно и в сообщении человеку", result.message.includes("git-репозитория здесь нет"));

	const inGit = sandbox("deploy-git", { git: false });
	await exec("git", ["init", "-q", inGit]);
	const ok = initVolna(inGit);
	check("в git правила .gitignore дописываются", existsSync(join(inGit, ".gitignore")));
	check("в git предупреждать не о чем", ok.warnings.length === 0, ok.warnings.join("; "));
}

/** Поиск .volna вверх: своя настройка находится, чужая - нет. */
async function searchBoundary(): Promise<void> {
	const outer = sandbox("deploy-outer", { git: false });
	const nested = join(outer, "pkg", "src");
	mkdirSync(nested, { recursive: true });
	initVolna(outer);

	check("из подкаталога своего проекта .volna находится", findVolnaDir(nested) === join(outer, ".volna"));

	mkdirSync(join(outer, "pkg", ".git"), { recursive: true });
	check("чужой репозиторий по дороге останавливает поиск", findVolnaDir(nested) === null);

	// граница подъёма (по умолчанию домашний каталог): .volna за ней - настройка не этого проекта
	const open = sandbox("deploy-boundary", { git: false });
	const deep = join(open, "lib", "src");
	mkdirSync(deep, { recursive: true });
	initVolna(open);
	check("за границей чужая .volna не подхватывается", findVolnaDir(deep, join(open, "lib")) === null);
	check("своя .volna внутри границы находится", findVolnaDir(deep, dirname(open)) === join(open, ".volna"));
	check("домашний каталог - граница по умолчанию", findVolnaDir(deep) === join(open, ".volna"));

	const plain = sandbox("deploy-plain", { git: false });
	check("вне проекта и без .volna поиск ничего не выдумывает", findVolnaDir(plain) === null);
	check("корень для развёртывания вне git - сам каталог", repoRootFor(plain).toLowerCase() === plain.toLowerCase());
}
