import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

/**
 * Sets every key of the repository's shared settings in one T3 settings file and leaves the
 * rest of that file alone. The server watches the file, so a change applies without a restart.
 * Returns the keys that differed; with `check` nothing is written.
 */
export function applySharedSettings(sharedFile, settingsFile, { check = false } = {}) {
  if (!existsSync(settingsFile)) return [];
  const read = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  const shared = read(sharedFile);
  const text = readFileSync(settingsFile, "utf8");
  const current = read(settingsFile);
  const changed = Object.keys(shared).filter((key) => !isDeepStrictEqual(current[key], shared[key]));
  if (!changed.length || check) return changed;
  const temporary = `${settingsFile}.shared-${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ ...current, ...shared }, null, 2) + (text.endsWith("\n") ? "\n" : ""));
  renameSync(temporary, settingsFile);
  return changed;
}
