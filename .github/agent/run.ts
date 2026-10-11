// Runs a Cursor agent unattended on the checked-out repository, then holds it to the checks a GitHub runner
// can run, handing failures back until they pass or the attempts run out.
//
// Environment:
//   CURSOR_API_KEY      user or service-account key
//   AGENT_TASK_FILE     the request: issue or pull request text, comments, the /agent instruction
//   AGENT_SUMMARY_FILE  where the agent's final reply (the PR description) is written
//   AGENT_MODEL         model id (default composer-2.5)
//   AGENT_ATTEMPTS      agent turns, including the first (default 3)
//   GITHUB_OUTPUT       receives checks=pass|fail
//
// Exit codes: 0 the agent finished (the checks may still fail, see checks=), 1 the agent could not start,
// 2 the agent run failed.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Agent, CursorAgentError, type Run } from "@cursor/sdk";

const ROOT = process.env.GITHUB_WORKSPACE ?? process.cwd();
const task = readFileSync(need("AGENT_TASK_FILE"), "utf8");
const summaryFile = need("AGENT_SUMMARY_FILE");
const model = process.env.AGENT_MODEL || "composer-2.5";
const attempts = Math.max(1, Number(process.env.AGENT_ATTEMPTS || 3));

const CHECKS: [name: string, command: string][] = [
  ["types (G1)", "npx tsc --noEmit"],
  ["tests", "npx vitest run"],
  ["build (G5)", "npx vite build"],
];

const BRIEF = `You are working unattended on a GitHub Actions Ubuntu VM, on a fresh checkout of this repository.
Nobody will answer questions: make reasonable decisions and state them in your final reply.

The request:

${task}

Environment:
- Node 24 with dependencies installed; the py-aep sample corpus is at $PY_AEP.
- No After Effects, no GPU and no Windows. The gates that need them (aerender, render-refs, pixel-report,
  vat-report, geometry-report, corpus-report, profile-render, check-video-playback) cannot run here; do not
  try. When the change can affect rendering, name in your final reply the suites to re-run locally.
- These must pass: ${CHECKS.map(([, c]) => `\`${c}\``).join(", ")}. Add or update vitest tests for the
  behaviour you change.
- Do not commit, push, switch branches or change git config: the workflow commits your working tree and
  opens or updates the pull request. Leave .github/ alone unless the request is about it.

When you are done, reply with only the pull request description in Markdown: one summary sentence, what
changed and why, how it was verified, and what a reviewer has to check by hand.`;

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function runChecks(): string[] {
  const failures: string[] = [];
  for (const [name, command] of CHECKS) {
    console.log(`::group::check ${name}: ${command}`);
    const r = spawnSync(command, { cwd: ROOT, shell: true, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, CI: "1" } });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    console.log(output);
    console.log("::endgroup::");
    if (r.status !== 0) failures.push(`### ${name}: \`${command}\` exited with ${r.status}\n\n\`\`\`\n${output.split("\n").slice(-150).join("\n")}\n\`\`\``);
  }
  return failures;
}

class RunFailed extends Error {}

async function follow(run: Run): Promise<string> {
  console.log(`agent ${run.agentId}, run ${run.id}`);
  for await (const event of run.stream()) {
    if (event.type === "assistant") {
      for (const block of event.message.content) if (block.type === "text") process.stdout.write(block.text);
    } else if (event.type === "tool_call" && event.status !== "running") {
      console.log(`\n[${event.status}] ${event.name}`);
    }
  }
  const result = await run.wait();
  console.log(`\nrun ${result.id}: ${result.status}${result.durationMs ? ` in ${Math.round(result.durationMs / 1000)} s` : ""}`);
  if (result.status !== "finished") throw new RunFailed(`agent run ${result.status}: ${result.error?.message ?? "no details"}`);
  return result.result ?? "";
}

async function main(agent: Awaited<ReturnType<typeof Agent.create>>): Promise<void> {
  let summary = "";
  let failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`::group::agent attempt ${attempt}/${attempts}`);
    const prompt = attempt === 1
      ? BRIEF
      : `The checks fail after your changes:\n\n${failures.join("\n\n")}\n\nFix the cause; do not skip, weaken or delete tests to get them through. Then reply with the updated pull request description only.`;
    summary = (await follow(await agent.send(prompt))) || summary;
    console.log("::endgroup::");
    failures = runChecks();
    if (failures.length === 0) break;
  }
  const checks = failures.length === 0 ? "pass" : "fail";
  if (checks === "fail") summary += `\n\n## Checks still failing\n\n${failures.join("\n\n")}`;
  writeFileSync(summaryFile, summary.trim() + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `checks=${checks}\n`);
  console.log(`checks: ${checks}`);
}

try {
  const agent = await Agent.create({
    apiKey: need("CURSOR_API_KEY"),
    model: { id: model },
    name: task.split("\n")[0].slice(0, 80),
    local: { cwd: ROOT, settingSources: ["project"] },
  });
  try {
    await main(agent);
  } finally {
    await agent[Symbol.asyncDispose]();
  }
} catch (err) {
  if (err instanceof CursorAgentError) {
    console.error(`the agent could not start: ${err.message} (retryable: ${err.isRetryable})`);
    process.exitCode = 1;
  } else if (err instanceof RunFailed) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
