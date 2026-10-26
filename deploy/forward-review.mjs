// Primary-reviewed, one-installation reconciliation. This changes neither the
// original evidence nor the verifier used against the successor's fresh baseline.
import { check, digest, preservation, eligible } from './core.mjs';

export const FORWARD_POLICY = {
  kind: 'sliara-custom50-client-lifecycle-20261026',
  deploymentId: 'base-renewal-window-custom50-sliara-20261025',
  environmentId: 'b263cba7-18b9-49fe-9650-cf7b073d2c95',
  settingsBefore: 'eeff56b5de2c84295c6f738a78cad7d22fef5adf910d43afc81d76d61b1ed2c3',
  settingsCurrent: '0e7cfcd4f3bb1b140ea12efe29d9451d847ec8d81721f388288fc58a495b49a3',
  events: [
    [1702614, 'ed6c3c51-5b86-42a7-aafd-ab27b7069053', '3d43066c-d61f-4b76-a274-075ce999b174', 'thread.deleted', 'deletedAt', '2026-10-25T22:47:22.599Z', '40b67653-da73-4224-a5d1-721a77756784'],
    [1702615, 'b3add1d7-730d-48fb-be97-5913eea9a46b', '260dd7ae-1385-481b-8d68-108fa569e20b', 'thread.deleted', 'deletedAt', '2026-10-25T22:47:26.864Z', 'ca380928-cc39-4cd0-a173-156b982e56b9'],
    [1702616, '9195811e-f923-47ad-9216-8d03eb862df5', '096452d2-4d91-40fd-ac5a-3481195aed8d', 'thread.settled', 'settledAt', '2026-10-25T22:47:30.070Z', '3b248708-4cdf-4571-8b88-8060478673f3'],
    [1702619, 'c98c2681-673d-4ea2-b3eb-9d0b12d49ef3', '9302feec-037a-4cd2-a908-b3ee1aa82945', 'thread.settled', 'settledAt', '2026-10-25T22:47:34.977Z', 'cca884c1-93bd-4404-b96f-bba79cdd696c'],
  ],
  deletedTargetError: 'Thread 3d43066c-d61f-4b76-a274-075ce999b174 no longer exists or is archived.',
  cancelledNoticeError: null,
  jobs: [
    ['report:9789bee1-2557-490d-8f9e-1bdaed4c5a48:679-final-acceptance-20261015-0241', 'done', 'error'],
    ['notice:9789bee1-2557-490d-8f9e-1bdaed4c5a48:679-reservation-dependency-correction-20261010-v1:terminal', 'notice', 'cancelled'],
  ],
  coalescedStartup: [{"sequence": 1725211, "event_id": "d53343af-5e39-43d1-b828-aae12daf0c5d", "event_type": "thread.message-sent", "command_id": "worker-report-visible:message:6038c74e-c426-4eb7-b078-351c42147094:storage4-field-eleven-nativeD-positive-0018", "actor_kind": "client", "occurred_at": "2026-10-26T00:17:52.135Z", "payload": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "messageId": "worker-job:message:6038c74e-c426-4eb7-b078-351c42147094:storage4-field-eleven-nativeD-positive-0018", "role": "user", "attachments": [], "turnId": null, "streaming": false, "createdAt": "2026-10-26T00:17:52.135Z", "updatedAt": "2026-10-26T00:17:52.135Z"}}, {"sequence": 1725212, "event_id": "096a666c-dad9-47de-9121-3bf2e75069d7", "event_type": "thread.turn-start-requested", "command_id": "worker-job:message:6038c74e-c426-4eb7-b078-351c42147094:storage4-field-eleven-nativeD-positive-0018:0", "actor_kind": "client", "occurred_at": "2026-10-26T00:17:52.151Z", "payload": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "messageId": "worker-job:message:6038c74e-c426-4eb7-b078-351c42147094:storage4-field-eleven-nativeD-positive-0018", "modelSelection": {"instanceId": "codex_antoine", "model": "gpt-6-astra", "options": [{"id": "reasoningEffort", "value": "high"}, {"id": "serviceTier", "value": "default"}]}, "runtimeMode": "full-access", "interactionMode": "default", "createdAt": "2026-10-26T00:17:52.151Z"}}, {"sequence": 1725213, "event_id": "23b1a767-d5db-4561-b256-8042a830f304", "event_type": "thread.session-set", "command_id": "server:provider-session-set:bef010f4-6f05-4479-8943-611fdf52c8ec", "actor_kind": "server", "occurred_at": "2026-10-26T00:17:52.151Z", "payload": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "session": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "status": "starting", "providerName": "codex", "providerInstanceId": "codex_antoine", "runtimeMode": "full-access", "activeTurnId": null, "lastError": null, "updatedAt": "2026-10-26T00:17:52.151Z"}}}, {"sequence": 1725216, "event_id": "b2694eec-c503-465d-9a55-2d2a2bfd4baa", "event_type": "thread.message-sent", "command_id": "72c154bf-d20f-4a1c-808d-baca439e7af6", "actor_kind": "client", "occurred_at": "2026-10-26T00:17:52.807Z", "payload": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "messageId": "19c6b6c5-a0b3-47b7-8fea-71538deaa1f0", "role": "user", "attachments": [], "turnId": null, "streaming": false, "createdAt": "2026-10-26T00:17:52.807Z", "updatedAt": "2026-10-26T00:17:52.807Z"}}, {"sequence": 1725217, "event_id": "580b4cf5-f610-47ee-b801-81dde768fc92", "event_type": "thread.turn-start-requested", "command_id": "72c154bf-d20f-4a1c-808d-baca439e7af6", "actor_kind": "client", "occurred_at": "2026-10-26T00:17:52.807Z", "payload": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "messageId": "19c6b6c5-a0b3-47b7-8fea-71538deaa1f0", "modelSelection": {"instanceId": "codex_antoine", "model": "gpt-6-astra", "options": [{"id": "reasoningEffort", "value": "high"}, {"id": "serviceTier", "value": "default"}]}, "titleSeed": "CAN WE CHANGE THEM TO SONNET", "runtimeMode": "full-access", "interactionMode": "default", "createdAt": "2026-10-26T00:17:52.807Z"}}, {"sequence": 1725218, "event_id": "03321312-9c9f-49ae-b5d0-336e8f789d18", "event_type": "thread.session-set", "command_id": "server:provider-session-set:abc76e84-d1e2-4665-9775-d36ad2c9389b", "actor_kind": "server", "occurred_at": "2026-10-26T00:17:52.807Z", "payload": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "session": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "status": "starting", "providerName": "codex", "providerInstanceId": "codex_antoine", "runtimeMode": "full-access", "activeTurnId": null, "lastError": null, "updatedAt": "2026-10-26T00:17:52.807Z"}}}, {"sequence": 1725221, "event_id": "b4b17bd9-209c-4b5a-9629-3c1320d81325", "event_type": "thread.session-set", "command_id": "provider:e2b3d65a-053e-4bc1-b527-3210ab99cdbf:thread-session-set:e9a97819-bb8a-4bae-b34a-4162b49ed8a8", "actor_kind": "provider", "occurred_at": "2026-10-26T00:17:53.614Z", "payload": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "session": {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "status": "running", "providerName": "codex", "providerInstanceId": "codex_antoine", "runtimeMode": "full-access", "activeTurnId": "01a17592-1e8f-70b1-bd50-7c9805e2cc6f", "lastError": null, "updatedAt": "2026-10-26T00:17:53.614Z"}}}],
  nativeGoal: {"threadId": "05646984-c1a6-4058-85ee-a5f71573f233", "nativeThreadId": "01a174db-241b-7591-a3b2-0ad8ea2bcac0", "instance": "codex_antoine", "rollout": "/home/simonli/.codex-antoine/sessions/2026/10/25/rollout-2026-10-25T16-58-01-01a174db-241b-7591-a3b2-0ad8ea2bcac0.jsonl", "rootTurnId": "01a1759b-9616-7ef0-a67f-2530f3a3cae8", "anchors": [[1167, "a643d37969f9ee3af516b03a9dee2fd10a3b76d815bcd8ff1652df3573492939"], [1173, "57acf4f75ed499092f3ac9f4da990f092153b043f749fde1bb90539138d8b1eb"], [1176, "6d72285cb7eca6a842135fca7a96da9bc8ca00c2dfa3fcff81d9d93a1229ee39"]]},
  activitySessionIds: ['271a6493-b22d-4e8f-9ce6-1b0ed124b32d', '05646984-c1a6-4058-85ee-a5f71573f233', '0fa055f1-e513-423e-b56a-dec0e866b3e0', '18ba4398-48e6-4b1a-a4ac-c694418194d1', '4d7a55b2-7716-4ed6-9056-61a01ee2c052', 'c07a7ddd-3d3a-4e2d-8132-8823dce21c65', '6038c74e-c426-4eb7-b078-351c42147094', 'e35fc456-1b40-4d3f-a18c-7e4647b24938'],
  identityTransitions: [{
    kind: 'stale-instance-provider-start-rebind',
    id: 'e35fc456-1b40-4d3f-a18c-7e4647b24938',
    boundaries: { before: { schema: 1, eventSequence: 1700876, eventSha256: 'f6d217863023a5fb5642222617cfc1c1d62ad8745458b27f0fd963b478d71e83' }, closed: { schema: 1, eventSequence: 1700893, eventSha256: '943b65f62862c14968f3a1579eb14c3e231840726168a72c32013757b85be452' } },
    from: { provider: 'codex', instance: 'codex', nativeId: '86fa49804dafd3a1e32b31cba882ccade44e220ab5c22735dc00d15fc894b388', profile: 'faaee802b39ed7ae6a92827b760b9a6d66774004b4bac8585ea15568a1282ef8', binding: 'f95862b677664737b15caeab12f994054d9652a7b7fe5b8796cf938debae3af0' },
    to: { provider: 'codex', instance: 'codex_antoine', nativeId: '024d3b49129da64d0db312350cc602dfb1272e88fa26d4cbddd34382e309dc0d', profile: '911deaa3452b4115f1f4c1e81e47a3d0b293dc1cffe134d4586ec33916451d09', binding: '36403cd74422403ddfef4bafe0e1a2799ee598a80a176a96dcc7b6a11067260b' },
    selection: { modelSelection: { instanceId: 'codex_antoine', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] }, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: '/data/jobs/e35fc456-1b40-4d3f-a18c-7e4647b24938/repo' },
    command: { id: 'worker-job:e35fc456-1b40-4d3f-a18c-7e4647b24938:704-large-scan-panorama-515-complete-delivery-20261026-0945:0', resultSequence: 1792030, jobId: 'e35fc456-1b40-4d3f-a18c-7e4647b24938:704-large-scan-panorama-515-complete-delivery-20261026-0945', jobKind: 'work', attempt: 0, messageId: 'worker-job:e35fc456-1b40-4d3f-a18c-7e4647b24938:704-large-scan-panorama-515-complete-delivery-20261026-0945', promptSha256: 'c802303d202a28560206a9918433b55e1f2eee9bc38dc3bed7027ff4809ff627', firstTurnId: '01a17799-5d3f-74b0-b21a-503d705fb01c' },
    chain: [
      [1700997, '3a895e3b-8ed9-46a5-aa8c-075ec549a524', 'thread.meta-updated', 'worker-organization:7411abd5-7cee-4cb8-aaad-9b8cebf7e4ac', 'client', '2026-10-25T21:35:52.435Z', ['threadId', 'updatedAt']],
      [1702112, '9a56bce1-08d9-4fc9-8170-628099c0f39e', 'thread.meta-updated', 'worker-organization:278c6538-b076-42f4-af55-bd74a03cf437', 'client', '2026-10-25T22:31:03.552Z', ['threadId', 'updatedAt']],
      [1702298, '595c7a53-a9c9-4477-ab12-493b76698780', 'thread.meta-updated', 'worker-organization:5be473f8-0006-4092-ac8c-c82aaf880e1c', 'client', '2026-10-25T22:40:56.580Z', ['threadId', 'updatedAt']],
      [1792028, '7c028354-c951-4a58-8619-8f7bd4367bfa', 'thread.unsettled', 'worker-job:e35fc456-1b40-4d3f-a18c-7e4647b24938:704-large-scan-panorama-515-complete-delivery-20261026-0945:0', 'client', '2026-10-26T09:44:59.643Z', ['reason', 'threadId', 'updatedAt']],
      [1792029, '08cd2308-968a-4e73-b4e9-6062bc002558', 'thread.message-sent', 'worker-job:e35fc456-1b40-4d3f-a18c-7e4647b24938:704-large-scan-panorama-515-complete-delivery-20261026-0945:0', 'client', '2026-10-26T09:44:59.643Z', ['worker-job:e35fc456-1b40-4d3f-a18c-7e4647b24938:704-large-scan-panorama-515-complete-delivery-20261026-0945', 'user', null, false, ['attachments', 'createdAt', 'messageId', 'role', 'streaming', 'text', 'threadId', 'turnId', 'updatedAt']]],
      [1792030, '18d8c8ba-62e8-4ef2-9ccf-27c285bbe2d9', 'thread.turn-start-requested', 'worker-job:e35fc456-1b40-4d3f-a18c-7e4647b24938:704-large-scan-panorama-515-complete-delivery-20261026-0945:0', 'client', '2026-10-26T09:44:59.643Z', ['worker-job:e35fc456-1b40-4d3f-a18c-7e4647b24938:704-large-scan-panorama-515-complete-delivery-20261026-0945', { instanceId: 'codex_antoine', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'high' }] }, 'full-access', 'default', ['createdAt', 'interactionMode', 'messageId', 'modelSelection', 'runtimeMode', 'threadId']]],
      [1792031, '29156080-6e81-4386-aa0a-678554b5a813', 'thread.meta-updated', 'worker-organization:f0e3ee0f-3efb-48ae-b2a2-a813abe38752', 'client', '2026-10-26T09:44:59.764Z', ['threadId', 'updatedAt']],
      [1792032, '203f3bac-64dd-427d-bd8b-bcf7e2e3bc9d', 'thread.session-set', 'server:provider-session-set:f2e3b25c-104b-4cad-a086-3afa175fbbe1', 'server', '2026-10-26T09:44:59.643Z', ['starting', 'codex', 'codex_antoine', null, 'full-access']],
      [1792034, '14155a11-3cb3-4f88-bcc5-3f3c58a7110f', 'thread.session-set', 'provider:33e44346-ba68-44f8-aebc-30f1da64c8f5:thread-session-set:5451523c-3fac-4af1-a26a-5b6433a98345', 'provider', '2026-10-26T09:45:00.629Z', ['starting', 'codex', 'codex_antoine', null, 'full-access']],
      [1792037, 'f1517340-0f6e-4d89-8cd1-c0ff55b7544b', 'thread.session-set', 'server:provider-session-set:0c7bb549-8b9e-43e8-aec8-9c5761e9c125', 'server', '2026-10-26T09:44:59.643Z', ['starting', 'codex', 'codex_antoine', null, 'full-access']],
      [1792038, '522ae560-e70d-47fb-8e47-184230356d23', 'thread.session-set', 'provider:07243c39-9d55-400f-bc9d-fa740c6670d8:thread-session-set:2132ba33-5534-4115-9986-9c4ef4c178af', 'provider', '2026-10-26T09:45:01.840Z', ['starting', 'codex', 'codex_antoine', null, 'full-access']],
      [1792039, 'feb79350-09be-4441-9e42-9f87b26fa4d5', 'thread.session-set', 'provider:388d5ede-4e2e-46b6-bab8-15c81850f624:thread-session-set:08c9d895-9030-445a-9c7e-ca9989ee45c5', 'provider', '2026-10-26T09:45:01.857Z', ['starting', 'codex', 'codex_antoine', null, 'full-access']],
      [1792040, 'e1077455-53ea-42db-9078-ffb3b82a2722', 'thread.session-set', 'provider:d5380908-4d5a-4b25-baaa-96c07a93ae72:thread-session-set:6d0c93bb-66b5-477c-a49a-894466151347', 'provider', '2026-10-26T09:45:02.641Z', ['running', 'codex', 'codex_antoine', '01a17799-5d3f-74b0-b21a-503d705fb01c', 'full-access']],
    ],
    transcripts: {
      old: { instance: 'codex', nativeThreadId: '01a17185-094a-73f2-9e1d-739fddf225a6', path: '/home/simonli/.codex/sessions/2026/10/25/rollout-2026-10-25T01-25-06-01a17185-094a-73f2-9e1d-739fddf225a6.jsonl', bytes: 53064847, sha256: '9ac317cf610b225928280c87a8b86cc06e9d5a169ef6108612356c9f885836ba', cwd: '/data/jobs/e35fc456-1b40-4d3f-a18c-7e4647b24938/repo' },
      new: { instance: 'codex_antoine', nativeThreadId: '01a17799-5b5a-7941-abaf-c1eacdf4f5b4', path: '/home/simonli/.codex-antoine/sessions/2026/10/26/rollout-2026-10-26T05-45-01-01a17799-5b5a-7941-abaf-c1eacdf4f5b4.jsonl', cwd: '/data/jobs/e35fc456-1b40-4d3f-a18c-7e4647b24938/repo' },
    },
  }],
};

// One exactly proven transition between two native identities of the SAME thread. It is neither native identity equality nor evidence that the
// old conversation context reached the new native thread: both are recorded as unproven. Everything else about the thread stays strict.
const IDENTITY = ['provider', 'instance', 'nativeId', 'profile'];
const sameIdentity = (session, side) => IDENTITY.every(key => session?.[key] === side[key]);
// What the read-only proof must attest for one policy transition (static values only; the current transcript keeps growing).
export const identityTransitionProof = transition => ({ id: transition.id, kind: transition.kind, transitionSha256: digest(JSON.stringify(transition)), boundaries: structuredClone(transition.boundaries), from: structuredClone(transition.from), to: structuredClone(transition.to), commandResultSequence: transition.command.resultSequence, originalTranscriptRetained: true, newTranscriptMatchesSelection: true, nativeIdentityEquality: false, continuity: 'unproven' });
function reviewedIdentityTransitions(before, closed, current, proof) {
  const reviewed = [];
  for (const transition of FORWARD_POLICY.identityTransitions) {
    const { id, from, to } = transition, binding = state => new Map(state.bindings).get(id);
    const [old, sealed, now] = [before, closed, current].map(state => state.sessions.find(s => s.id === id));
    if (!old && !sealed && !now) continue;
    check(old && sealed && JSON.stringify(old) === JSON.stringify(sealed) && sameIdentity(old, from) && binding(before) === from.binding && binding(closed) === from.binding, 'recovery', 'Reviewed identity transition does not start at its original closed boundary');
    if (!now || (sameIdentity(now, from) && binding(current) === from.binding)) continue;
    check(sameIdentity(now, to) && binding(current) === to.binding, 'recovery', 'Reviewed identity transition does not end at its exact current identity');
    check(proof.activity?.some(entry => entry.id === id), 'recovery', 'Identity transition requires its reviewed activity proof');
    reviewed.push(transition);
  }
  check(JSON.stringify(proof.identityTransitions ?? []) === JSON.stringify(reviewed.map(identityTransitionProof)), 'recovery', 'Missing, altered or unreviewed identity transition proof');
  // Only the cloned baselines move to the proven identity; the retained original receipt and closed snapshot are never rewritten.
  for (const { id, to } of reviewed) for (const state of [before, closed]) {
    Object.assign(state.sessions.find(s => s.id === id), { provider: to.provider, instance: to.instance, nativeId: to.nativeId, profile: to.profile });
    state.bindings = state.bindings.map(([key, value]) => [key, key === id ? to.binding : value]);
  }
  return reviewed.map(identityTransitionProof);
}

export function reviewedForwardBoundaries(context, live, proof) {
  const { decision, receipt, closed } = context, review = decision.forwardReview;
  check(decision.kind === 'installed-forward-repair' && decision.id === FORWARD_POLICY.deploymentId && live.environmentId === FORWARD_POLICY.environmentId && review?.policySha256 === digest(JSON.stringify(FORWARD_POLICY)), 'recovery', 'Unreviewed installed-forward policy');
  check(review.originalReceiptSha256 === decision.evidence['receipt.json'] && review.closedSnapshotSha256 === decision.evidence['closed-snapshot.json'], 'recovery', 'Forward review original boundary differs');
  check(proof && proof.policySha256 === review.policySha256 && proof.originalReceiptSha256 === review.originalReceiptSha256 && proof.closedSnapshotSha256 === review.closedSnapshotSha256 && proof.beforeSnapshotSha256 === digest(JSON.stringify(receipt.before)) && proof.currentSnapshotSha256 === digest(JSON.stringify(live.snapshot)), 'recovery', 'Missing, altered or stale forward proof');
  check(JSON.stringify(proof.events) === JSON.stringify(FORWARD_POLICY.events) && JSON.stringify(proof.jobs) === JSON.stringify(FORWARD_POLICY.jobs), 'recovery', 'Forward event/job proof differs');
  const settings = s => new Map(s.routes).get('file:settings.json');
  check(settings(receipt.before) === FORWARD_POLICY.settingsBefore && settings(closed) === FORWARD_POLICY.settingsCurrent && settings(live.snapshot) === FORWARD_POLICY.settingsCurrent && proof.settingsSha256 === FORWARD_POLICY.settingsCurrent, 'recovery', 'Reviewed current/closed settings differ');
  const before = structuredClone(receipt.before), boundary = structuredClone(closed);
  before.routes = before.routes.map(([id, value]) => [id, id === 'file:settings.json' ? FORWARD_POLICY.settingsCurrent : value]);
  const next = new Map(live.snapshot.sessions.map(s => [s.id, s]));
  for (const [, , id, , field, time] of FORWARD_POLICY.events) {
    const current = next.get(id);
    check(current && current[field] === time && !current.activeTurnId && !current.marker, 'recovery', 'Reviewed client lifecycle no longer matches');
    for (const state of [before, boundary]) {
      const old = state.sessions.find(s => s.id === id);
      check(old && old[field] === null && ['nativeId', 'instance', 'provider', 'profile', 'lastTurnId', 'lastTurnState', 'lastTurnCompletedAt', 'lastError', 'bindingStatus', 'archivedAt', 'snoozedUntil', field === 'deletedAt' ? 'settledAt' : 'deletedAt'].every(k => old[k] === current[k]), 'recovery', 'Lifecycle evidence cannot conceal other session changes');
      check(field !== 'deletedAt' || old.status === current.status, 'recovery', 'Deletion cannot conceal a session status change');
      old[field] = time;
      if (field === 'settledAt') {
        check(['ready', 'stopped'].includes(old.status) && current.status === 'stopped', 'recovery', 'Reviewed settlement has unexpected status');
        old.status = current.status;
      }
    }
  }
  for (const [id, , state] of FORWARD_POLICY.jobs) {
    check(new Map(live.snapshot.jobStates).get(id) === state, 'recovery', 'Reviewed terminal job differs');
    for (const baseline of [before, boundary]) {
      check(new Map(baseline.jobStates).get(id) === 'queued', 'recovery', 'Reviewed job original state differs');
      baseline.jobStates = baseline.jobStates.map(([key, value]) => [key, key === id ? state : value]);
    }
  }
  const transitions = reviewedIdentityTransitions(before, boundary, live.snapshot, proof);
  check(Array.isArray(proof.preClosedActivity), 'recovery', 'Missing before-close activity proof');
  for (const entry of proof.preClosedActivity) {
    check(FORWARD_POLICY.activitySessionIds.includes(entry.id), 'recovery', 'Unreviewed before-close session');
    const old = before.sessions.find(s => s.id === entry.id), sealed = closed.sessions.find(s => s.id === entry.id);
    check(old && sealed && !eligible(old) && eligible(sealed), 'recovery', 'Before-close native eligibility differs');
    const checked = preservation({sessions:[old]}, {sessions:[sealed]}, [], [entry]);
    // The byte-pinned CLOSED snapshot intentionally retains the supported
    // continuation marker. It is pending at this historical boundary only;
    // the unchanged current/final verifier must observe its real consumption.
    const closedContinuation = sealed.marker === true && sealed.bindingStatus === 'stopped' && sealed.continueOnShutdown === true && checked.failures.length === 0 && checked.failed.length === 0 && JSON.stringify(checked.pending) === JSON.stringify([entry.id]);
    check(checked.ok || closedContinuation, 'recovery', 'Before-close request does not prove sealed active native session');
    before.sessions = before.sessions.map(s => s.id === entry.id ? structuredClone(sealed) : s);
  }
  check(Array.isArray(proof.activity) && proof.activity.every(e => FORWARD_POLICY.activitySessionIds.includes(e.id)), 'recovery', 'Unreviewed activity session');
  return { before, closed: boundary, activity: proof.activity, transitions };
}
