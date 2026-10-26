// Exact client-authored effort decision. Analytical comparison only; no writes
// to profiles or old evidence and no exception in final successor verification.
import { check, digest } from './core.mjs';
export const WINDOWS_PROFILE_POLICY = {
  "kind": "myalien-custom50-client-effort-420410",
  "deploymentId": "base-renewal-window-custom50-myalien-20261025",
  "environmentId": "255c14ea-4fcc-4a51-b8bc-aa0821239b0a",
  "threadId": "961034db-e626-4e77-9070-dcb0dd3ef155",
  "originalReceiptSha256": "d2f1c5ac1411f51a496868646eb83ffb780a55c0df43bec26ec08e7838f910a8",
  "closedSnapshotSha256": "13392aad093f0f1c3759607db60322c0598860b1ce996581a2a931b6696a59a8",
  "provenanceSha256": "6ada3b8cd184da8a608dd24007ba853ae1c0d007f22b26daea0ad2b63a1be749",
  "event": {
    "sequence": 420410,
    "event_id": "7abee827-1a83-4722-a8a9-c2e0e94db85e",
    "event_type": "thread.meta-updated",
    "command_id": "14e10e70-7ec5-45ce-9446-b955575e12b9",
    "actor_kind": "client",
    "metadata_json": "{\"origin\":{\"surface\":\"web\",\"appVersion\":\"0.0.45+custom.48\"}}",
    "occurred_at": "2026-10-25T23:27:19.890Z",
    "payload": {
      "threadId": "961034db-e626-4e77-9070-dcb0dd3ef155",
      "modelSelection": {
        "instanceId": "codex",
        "model": "gpt-6-astra",
        "options": [
          {
            "id": "reasoningEffort",
            "value": "high"
          },
          {
            "id": "serviceTier",
            "value": "default"
          }
        ]
      },
      "updatedAt": "2026-10-25T23:27:19.890Z"
    },
    "receipt": {
      "command_id": "14e10e70-7ec5-45ce-9446-b955575e12b9",
      "aggregate_kind": "thread",
      "aggregate_id": "961034db-e626-4e77-9070-dcb0dd3ef155",
      "accepted_at": "2026-10-25T23:27:19.890Z",
      "result_sequence": 420410,
      "status": "accepted",
      "error": null
    }
  },
  "selection": {
    "instanceId": "codex",
    "model": "gpt-6-astra",
    "options": [
      {
        "id": "reasoningEffort",
        "value": "high"
      },
      {
        "id": "serviceTier",
        "value": "default"
      }
    ]
  },
  "oldSelectionSha256": "d15453aef3890e675c177e1528c9a61b6c3491959f2c13242640bc2ee6fa113f",
  "selectionSha256": "29ba059de97304428421cd930ab068e5911bb56e9f5fe4786f82eff681e7482c",
  "oldProfileHash": "cc2726e6565e681b05e6f646d11537d43cb3229abd6aba44d303f59df451cc7f",
  "oldBindingHash": "569e754a2707deccc01b734aa7a5b9cea76a8b85e7d98f280ffeef16d81f2dc7",
  "currentBindingHash": "9a9e4682e968d9d7cb823faaa9db6331afaa32b5f72458046f2933a7c899038d",
  "nativeIdHash": "43cbf14083bb0ae5683cef37e750ad2272478e34ae54276403265c46ba0a9322",
  "currentProfileHash": "546d8e30a1096a6ec02bd7decd9a915af4d06fe1e8d5b2867962a3f2fddd6f3e"
};
export function reviewedWindowsBoundaries(context, live, proof) {
  const p = WINDOWS_PROFILE_POLICY, d = context.decision, review = d.windowsProfileReview;
  check(d.kind === 'reopened-before-replacement' && d.id === p.deploymentId && live.environmentId === p.environmentId && context.request.target.platform === 'win32-x64', 'recovery', 'Windows effort review scope differs');
  check(review?.policySha256 === digest(JSON.stringify(p)) && d.evidence['receipt.json'] === p.originalReceiptSha256 && d.evidence['closed-snapshot.json'] === p.closedSnapshotSha256, 'recovery', 'Windows effort original evidence differs');
  check(proof?.verified === true && proof.policySha256 === review.policySha256 && proof.originalReceiptSha256 === p.originalReceiptSha256 && proof.closedSnapshotSha256 === p.closedSnapshotSha256 && proof.currentSnapshotSha256 === digest(JSON.stringify(live.snapshot)) && JSON.stringify(proof.event) === JSON.stringify(p.event), 'recovery', 'Missing or stale Windows effort provenance');
  const transform = boundary => {
    const copy = structuredClone(boundary);
    for (const [key, oldHash, newHash] of [['profiles', p.oldProfileHash, p.currentProfileHash], ['bindings', p.oldBindingHash, p.currentBindingHash]]) {
      const rows = copy[key].filter(([id]) => id === p.threadId), current = live.snapshot[key].filter(([id]) => id === p.threadId);
      check(rows.length === 1 && current.length === 1 && rows[0][1] === oldHash && current[0][1] === newHash, 'recovery', 'Windows effort row differs');
      rows[0][1] = newHash;
    }
    const old = copy.sessions.filter(s => s.id === p.threadId), now = live.snapshot.sessions.filter(s => s.id === p.threadId);
    check(old.length === 1 && now.length === 1 && old[0].profile === p.oldSelectionSha256 && now[0].profile === p.selectionSha256 && [old[0],now[0]].every(s => s.nativeId === p.nativeIdHash && s.instance === 'codex' && s.provider === 'codex'), 'recovery', 'Windows effort native identity differs');
    old[0].profile = p.selectionSha256;
    return copy;
  };
  return { before: transform(context.receipt.before), closed: transform(context.closed) };
}
