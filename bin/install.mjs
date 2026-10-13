#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settings, expandPath } from "../skills/t3-fork-session/scripts/config.mjs";
const check = process.argv.includes("--check");
const root = fileURLToPath(new URL("..", import.meta.url));
const home = homedir();
const homes = settings.skillHomes ?? readdirSync(home).filter((n) => /^\.(codex|claude)(-.+)?$/.test(n) && lstatSync(path.join(home,n)).isDirectory()).map((n) => path.join(home,n));
const targets = [...new Set([path.join(home,".agents","skills"), ...homes.map((h) => path.join(expandPath(h), "skills"))])];
function link(target, source, directory = true) {
  let info;
  try { info = lstatSync(target); } catch (error) { if(error.code!=="ENOENT") throw error; }
  if (info) {
    if (!info.isSymbolicLink()) throw new Error(`Refusing to overwrite unmanaged installation ${target}. Migrate it explicitly.`);
    if (existsSync(target) && realpathSync(target) === realpathSync(source)) return;
    if (check) throw new Error(`Incorrect installation: ${target}`);
    throw new Error(`Existing link points elsewhere: ${target}; inspect before replacing it.`);
  }
  if (check) throw new Error(`Missing installation: ${target}`);
  mkdirSync(path.dirname(target), {recursive:true});
  symlinkSync(source,target,directory && process.platform === "win32" ? "junction" : directory ? "dir" : "file");
}
for (const target of targets) {
  const dest = path.join(target,"t3-fork-session");
  link(dest,path.join(root,"skills","t3-fork-session"));
  for(const name of ["SKILL.md","scripts/config.mjs","scripts/fork-session.mjs","scripts/refresh-bases.mjs"])
    if(!readFileSync(path.join(dest,name),"utf8").trim()) throw new Error(`Empty installed file: ${dest}/${name}`);
  console.log(`${check ? "Verified" : "Installed"} ${dest}`);
}
const bin = path.join(home,".local","bin");
if (process.platform === "win32") {
  const target = path.join(bin,"t3w.cmd");
  const content = `@echo off\r\n"${process.execPath}" "${path.join(root,"bin","t3w.mjs")}" %*\r\n`;
  if(check) {if(!existsSync(target)||readFileSync(target,"utf8")!==content)throw new Error(`Missing or stale ${target}`);}
  else {mkdirSync(bin,{recursive:true});writeFileSync(target,content);}
} else {
  if(!check) chmodSync(path.join(root,"bin","t3w.mjs"),0o755);
  link(path.join(bin,"t3w"),path.join(root,"bin","t3w.mjs"),false);
}
console.log("Global skill and command verified. New sessions discover the installation.");
