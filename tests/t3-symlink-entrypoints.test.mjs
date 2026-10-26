import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("find-session executes through a symlinked skill directory", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "t3w-symlink-"));
  try {
    const skill = path.join(directory, "t3-fork-session");
    symlinkSync(fileURLToPath(new URL("../skills/t3-fork-session", import.meta.url)), skill,
      process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, [path.join(skill, "scripts", "find-session.mjs"), "--help"], {
      encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: t3w find/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
