#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { T3Client } from "./fork-session.mjs";
import { peerClient } from "./peers.mjs";
import { findMatches } from "./find-session.mjs";

// Shell/catalog data only. Native transcripts travel server to server and are
// never returned to an agent, included in a prompt, or summarized by this CLI.
export function planMove(source, sourceConfig, destination, destinationConfig, input) {
  if (!sourceConfig.environment.capabilities.nativeSessionMoves || !destinationConfig.environment.capabilities.nativeSessionMoves)
    throw new Error("Both computers need the native session move update.");
  if (sourceConfig.environment.environmentId === destinationConfig.environment.environmentId) throw new Error("Choose a different computer.");
  const matches = findMatches(source, { name: input.name, threadId: input.threadId, project: input.sourceProject }).threads;
  if (matches.length !== 1) throw new Error(matches.length ? "Session name is ambiguous; use --thread-id." : "Session not found.");
  const thread = matches[0];
  const sourceProject = source.projects.find((project) => project.id === thread.projectId);
  const projects = destination.projects.filter((project) => input.project
    ? [project.id, project.title, project.workspaceRoot].some((value) => value?.toLowerCase() === input.project.toLowerCase())
    : project.title === sourceProject?.title);
  if (projects.length !== 1) throw new Error("Choose one destination project using --project NAME_OR_PATH_OR_ID.");
  const current = sourceConfig.providers.find((entry) => entry.instanceId === (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId));
  if (!["codex", "claudeAgent", "deepseekHarness"].includes(current?.driver))
    throw new Error("Choose a session from a provider with native move support.");
  const providerInstanceId = input.providerInstanceId ?? thread.modelSelection.instanceId;
  const account = destinationConfig.providers.find((entry) => entry.instanceId === providerInstanceId);
  if (account?.driver !== current.driver || !account.enabled || account.auth.status !== "authenticated")
    throw new Error("Choose an authenticated destination account of the same provider using --provider-instance-id.");
  const model = account.models.find((entry) => entry.slug === thread.modelSelection.model);
  if (!model) throw new Error("The destination account does not support the saved model.");
  for (const option of thread.modelSelection.options ?? []) {
    const descriptor = model.capabilities?.optionDescriptors?.find((entry) => entry.id === option.id);
    if (!descriptor || descriptor.type === "select" && !descriptor.options.some((entry) => entry.id === option.value))
      throw new Error("The destination account does not support the saved model options.");
  }
  return { requestId: input.requestId ?? randomUUID(), threadId: thread.id,
    environment: destinationConfig.environment.environmentId, projectId: projects[0].id,
    ...(input.providerInstanceId ? { providerInstanceId } : {}) };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "thread-id": { type: "string" }, to: { type: "string" }, from: { type: "string" }, project: { type: "string" },
    "source-project": { type: "string" }, "provider-instance-id": { type: "string" }, "request-id": { type: "string" },
    status: { type: "string" }, cancel: { type: "boolean" }, "mcp-plan": { type: "boolean" },
    home: { type: "string" }, server: { type: "string" }, cli: { type: "string" }, timeout: { type: "string", default: "30" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log("t3w move NAME --to COMPUTER [--project NAME_OR_PATH_OR_ID] [--thread-id UUID] [--provider-instance-id ACCOUNT] [--request-id UUID] [--mcp-plan]\nt3w move --status REQUEST_ID [--cancel] [--from COMPUTER]\nCopies full native context with the same provider; no prompt handoff. Existing processes stay put. A busy session waits for its turn to finish. Agents use --mcp-plan and invoke the returned tool. Reuse request IDs after timeouts."); return; }
  const connection = { home: values.home, timeout: Number(values.timeout), server: values.server, cli: values.cli };
  const sourceClient = values.from ? peerClient(values.from, connection).client : new T3Client(connection);
  let destinationClient;
  try {
    if (values.status) {
      const input = { requestId: values.status, ...(values.cancel ? { cancel: true } : {}) };
      console.log(JSON.stringify(values["mcp-plan"] ? { tool: "t3_session_move_status", input }
        : await sourceClient.http("/api/orchestration/session-moves/status", input), null, 2)); return;
    }
    if (!values.to || !positionals[0] && !values["thread-id"]) throw new Error("Supply a session name or --thread-id, and --to COMPUTER.");
    destinationClient = peerClient(values.to, connection).client;
    await Promise.all([sourceClient.connect(), destinationClient.connect()]);
    const [source, sourceConfig, destination, destinationConfig] = await Promise.all([
      sourceClient.http("/api/orchestration/shell"), sourceClient.rpc("server.getConfig", {}).promise,
      destinationClient.http("/api/orchestration/shell"), destinationClient.rpc("server.getConfig", {}).promise,
    ]);
    const input = planMove(source, sourceConfig, destination, destinationConfig, {
      name: positionals[0], threadId: values["thread-id"], sourceProject: values["source-project"], project: values.project,
      providerInstanceId: values["provider-instance-id"], requestId: values["request-id"],
    });
    console.log(JSON.stringify(values["mcp-plan"] ? { tool: "t3_session_move", input }
      : await sourceClient.http("/api/orchestration/session-moves", input), null, 2));
  } finally { await sourceClient.close(); await destinationClient?.close(); }
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
