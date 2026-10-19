#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { T3Client, planFork, PROVIDERS, MODELS } from "./fork-session.mjs";

const { values } = parseArgs({ options: {
  "thread-id": { type: "string" }, provider: { type: "string" }, model: { type: "string" },
  effort: { type: "string" }, server: { type: "string" }, home: { type: "string" }, cli: { type: "string" },
  timeout: { type: "string", default: "30" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("t3w worker-profile --thread-id UUID [--provider ACCOUNT] [--model MODEL] [--effort EFFORT]\nReads current settings and emits validated t3_worker_control input; changes nothing. Omitted account/model stay current. An effort-only edit retains other options; a model/account change uses fixed profile defaults unless --effort is supplied.");
} else {
  const client = new T3Client({ ...values, timeout: Number(values.timeout) });
  try {
    if (!values["thread-id"] || !(values.provider || values.model || values.effort)) throw new Error("Supply --thread-id and at least one profile change.");
    await client.connect();
    const [config, shell] = await Promise.all([client.rpc("server.getConfig", {}).promise, client.http("/api/orchestration/shell")]);
    const thread = shell.threads.find((t) => t.id === values["thread-id"]);
    if (!thread) throw new Error("Worker thread not found in this environment.");
    const project = shell.projects.find((p) => p.id === thread.projectId);
    const provider = values.provider ?? Object.keys(PROVIDERS).find((key) => PROVIDERS[key].instanceId === thread.modelSelection.instanceId);
    const model = values.model ?? Object.keys(MODELS).find((key) => MODELS[key].slug === thread.modelSelection.model);
    const plan = planFork(shell, config, { fresh: true, threadId: randomUUID(), project: project?.workspaceRoot,
      provider, model, effort: values.effort, name: thread.title, task: "Validate worker settings" });
    const descriptor = MODELS[Object.keys(MODELS).find((key) => MODELS[key].slug === plan.modelSelection.model)];
    const options = thread.modelSelection.instanceId === plan.modelSelection.instanceId && thread.modelSelection.model === plan.modelSelection.model
      ? [...(thread.modelSelection.options ?? []).filter((o) => o.id !== descriptor.option), ...plan.modelSelection.options]
      : plan.modelSelection.options;
    console.log(JSON.stringify({ threadId: thread.id, modelSelection: { ...plan.modelSelection, options } }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await client.close(); }
}
