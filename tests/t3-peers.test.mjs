import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MODELS, PROVIDERS, planFork, workerInput } from "../skills/t3-fork-session/scripts/fork-session.mjs";
import { findPeer, peerFile, readPeers, upsertPeer, writePeers } from "../skills/t3-fork-session/scripts/peers.mjs";

const peer = (label, environmentId = randomUUID()) => ({ environmentId, label, url: `https://${label}.example.ts.net:8443`, token: `token-${label}` });

test("peer links persist privately and replace an environment's earlier link", () => {
  const home = mkdtempSync(path.join(tmpdir(), "t3w-peers-"));
  assert.deepEqual(readPeers(home), []);
  const myalien = peer("myalien");
  writePeers(home, upsertPeer(readPeers(home), myalien));
  writePeers(home, upsertPeer(readPeers(home), { ...myalien, url: "https://new.example.ts.net:8443", token: "rotated" }));
  assert.deepEqual(readPeers(home), [{ ...myalien, url: "https://new.example.ts.net:8443", token: "rotated" }]);
  if (process.platform !== "win32") assert.equal(statSync(peerFile(home)).mode & 0o777, 0o600);
  assert.equal(findPeer(readPeers(home), "MyAlien").environmentId, myalien.environmentId);
  assert.equal(findPeer(readPeers(home), myalien.environmentId).label, "myalien");
  assert.throws(() => findPeer(readPeers(home), "gamma"), /No linked environment named gamma/);
  assert.throws(() => upsertPeer([], { ...myalien, token: " " }), /token is required/);
});

test("remote plans match that machine's project paths and require peer support on both servers", () => {
  const project = { id: "remote-project", title: "SurveyForge", workspaceRoot: "C:\\Users\\simon\\surveyforge" };
  const choice = PROVIDERS.SL;
  const providers = [{ instanceId: choice.instanceId, enabled: true, installed: true,
    models: [{ slug: MODELS.sol.slug, capabilities: { optionDescriptors: [{ id: MODELS.sol.option, type: "select", options: [{ id: MODELS.sol.effort }] }] } }] }];
  const config = { providers, environment: { capabilities: { workerFreshSessions: true, peerEnvironments: true } } };
  const input = { provider: "SL", model: "sol", name: "frame_worker_sol", task: "Profile the frames", threadId: randomUUID(),
    fresh: true, mcpPlan: true, environment: "myalien", localPeerEnvironments: true, project: "c:/users/simon/surveyforge/" };
  const plan = planFork({ projects: [project], threads: [] }, config, input);
  assert.equal(plan.projectId, "remote-project");
  assert.deepEqual(workerInput(plan, input.task), { environment: "myalien", projectId: "remote-project", threadId: input.threadId,
    title: "frame_worker_sol", modelSelection: plan.modelSelection, prompt: "Profile the frames" });
  assert.equal(planFork({ projects: [project], threads: [] }, config, { ...input, project: "SurveyForge" }).projectId, "remote-project");
  assert.throws(() => planFork({ projects: [project], threads: [] }, config, { ...input, localPeerEnvironments: false }), /peerEnvironments/);
  assert.throws(() => planFork({ projects: [project], threads: [] }, { ...config, environment: { capabilities: { workerFreshSessions: true } } }, input), /peerEnvironments/);
});
