import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const configPath = process.env.T3_WORKFLOWS_CONFIG ?? path.join(homedir(), ".config", "t3-workflows", "config.json");
export const settings = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) : {};
const defaults = JSON.parse(readFileSync(new URL("../references/accounts.json", import.meta.url), "utf8"));
export const accounts = Object.fromEntries(Object.entries({ ...defaults.accounts, ...settings.accounts }).filter(([key, value]) => value && (!settings.enabledAccounts || settings.enabledAccounts.includes(key))));
export const models = { ...defaults.models, ...settings.models };
export const expandPath = (value) => value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : path.resolve(value);
const canonical = (value) => { const p = expandPath(value); return existsSync(p) ? realpathSync(p) : p; };
export function projectProfile(project) {
  return Object.entries(settings.projects ?? {}).find(([key, p]) => key === project || (p.baseProject && canonical(p.baseProject) === canonical(project)))?.[1];
}
export function resolveProject(explicit, cwd = process.cwd(), config = settings) {
  let selected = explicit ?? process.env.T3_WORKFLOWS_PROJECT;
  if (selected && config.projects?.[selected]) return canonical(config.projects[selected].baseProject);
  if (selected) return canonical(selected);
  let root;
  try { root = path.dirname(execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { root = canonical(cwd); }
  const matches = Object.values(config.projects ?? {}).filter((p) => [p.baseProject, ...(p.repositories ?? [])].some((r) => r && canonical(r) === canonical(root)));
  if (matches.length > 1) throw new Error("Multiple workflow profiles match this checkout; specify --project PROFILE_OR_PATH.");
  if (matches.length === 1) return canonical(matches[0].baseProject);
  if (existsSync(path.join(root, ".git"))) return canonical(root);
  throw new Error("No project resolved from this directory. Use --project PROFILE_OR_PATH; global skill location never selects a project.");
}
export function baseFor(account, project) {
  return projectProfile(project)?.bases?.[account] ?? accounts[account]?.base;
}
