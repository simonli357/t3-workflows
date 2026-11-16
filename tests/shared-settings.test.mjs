import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applySharedSettings } from "../bin/shared-settings.mjs";

test("shared settings replace their own keys and keep everything else", () => {
  const dir = mkdtempSync(path.join(process.env.T3W_TEST_TMP ?? tmpdir(), "shared-settings-"));
  const shared = path.join(dir, "shared.json");
  const settings = path.join(dir, "settings.json");
  writeFileSync(shared, JSON.stringify({ sharedInstructions: "Shared rule." }));
  const own = { globalInstructions: { enabled: true, text: "Own rule." }, sharedInstructions: "Old." };
  writeFileSync(settings, JSON.stringify(own, null, 2) + "\n");

  assert.deepEqual(applySharedSettings(shared, settings, { check: true }), ["sharedInstructions"]);
  assert.equal(JSON.parse(readFileSync(settings, "utf8")).sharedInstructions, "Old.");

  assert.deepEqual(applySharedSettings(shared, settings), ["sharedInstructions"]);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { ...own, sharedInstructions: "Shared rule." });
  assert.deepEqual(applySharedSettings(shared, settings), []);
  assert.deepEqual(applySharedSettings(shared, path.join(dir, "absent.json")), []);
});
