import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrepared } from './prepared-review.mjs';

function fixture() {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const session = { id: 'thread', nativeId: 'native', instance: 'account', provider: 'claudeAgent', profile: 'profile' };
  const listener = { backend: { pid: 1, startedAt: '2026-01-01T00:00:00Z' }, parent: { pid: 2, startedAt: '2026-01-01T00:00:00Z' } };
  const before = { sessions: [session], bindings: [['thread', a]] };
  const context = { firstRequestMs: Date.parse('2026-01-02'), receipt: { phase: 'recovery-required', handoff: { uncertain: true }, proof: { ok: false }, before }, decision: { listener, evidence: { 'receipt.json': a }, reviewedCurrentBindings: [{ id: 'thread', fromSha256: a, toSha256: b, reason: 'Reviewed ordinary cursor advancement in the unrestarted original app.' }] }, request: { manifest: { compatibility: { database: { fromMigrations: [], fromSchemaSha256: a } } }, target: { kind: 'desktop-files', platform: 'win32-x64', expectedFiles: { 'server.asar': a }, expectedVersion: 'old', expectedServerSha256: a, expectedClientSha256: a } } };
  const live = { version: 'old', installSha256: a, clientSha256: a, snapshot: { sessions: [structuredClone(session)], bindings: [['thread', b]], database: { migrationIds: [], schemaSha256: a } } };
  return { context, live, installed: { 'server.asar': a }, listener };
}
const run = f => reviewPrepared(f.context, f.live, f.installed, f.listener);
test('explicit current binding review retains original baseline and records non-equality', () => {
  const f = fixture(); const original = structuredClone(f.context.receipt);
  const result = run(f);
  assert.equal(result.reviewedCurrentBindings[0].historicalEquality, 'unproven');
  assert.deepEqual(f.context.receipt, original);
});
for (const [name, mutate] of [
  ['unreviewed cursor', f => { delete f.context.decision.reviewedCurrentBindings; }],
  ['wrong old hash', f => { f.context.decision.reviewedCurrentBindings[0].fromSha256 = 'c'.repeat(64); }],
  ['wrong current hash', f => { f.context.decision.reviewedCurrentBindings[0].toSha256 = 'c'.repeat(64); }],
  ['stale review', f => { f.live.snapshot.bindings[0][1] = 'a'.repeat(64); }],
  ['missing binding', f => { f.live.snapshot.bindings = []; }],
  ['changed native identity', f => { f.live.snapshot.sessions[0].nativeId = 'other'; }],
  ['changed account', f => { f.live.snapshot.sessions[0].instance = 'other'; }],
  ['changed model', f => { f.live.snapshot.sessions[0].profile = 'other'; }],
  ['restarted server', f => { f.listener = structuredClone(f.listener); f.listener.backend.pid = 3; }],
]) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => run(f)); });
