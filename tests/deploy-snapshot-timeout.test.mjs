import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSnapshot, run } from '../deploy/native.mjs';

test('snapshot allows the measured 30.90s read and preserves the complete proof', t => {
  const previous = process.env.T3W_RUNNER_DEADLINE_MS;
  t.after(() => previous === undefined ? delete process.env.T3W_RUNNER_DEADLINE_MS : process.env.T3W_RUNNER_DEADLINE_MS = previous);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  process.env.T3W_RUNNER_DEADLINE_MS = '136000';
  const proof = { database: { logicalBytes: 9134354432 }, historyContent: [['thread', 'unchanged']], sessions: [{ nativeId: 'same-session' }] };
  assert.deepEqual(readSnapshot('/usr/bin/python3', '/fixture/state.sqlite', (executable, args, options) => {
    assert.equal(executable, '/usr/bin/python3');
    assert.equal(args[1], 'snapshot');
    assert.equal(args[2], '/fixture/state.sqlite');
    assert.equal(options.timeout, 120000);
    now += 30899;
    return JSON.stringify(proof);
  }), proof);
  assert.throws(() => readSnapshot('/usr/bin/python3', '/fixture/state.sqlite', () => assert.fail('must not start a truncated snapshot')), e => e.code === 'deadline' && /fresh runner/.test(e.message));
});

test('snapshot deadline failure names the fixed helper and bounded allowance', t => {
  // Exercise the real child timeout/error mapping without a long snapshot wait.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const helper = path.join(dir, 'host.py');
  fs.writeFileSync(helper, 'for (;;) {}');
  assert.throws(() => run(process.execPath, [helper, 'snapshot'], { timeout: 20 }), e => e.code === 'command' && /host.py snapshot timed out after 20ms/.test(e.message) && /retained deployment receipt/.test(e.message));
});
