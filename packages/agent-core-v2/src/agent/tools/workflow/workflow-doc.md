Orchestrate a complex task across multiple subagents by authoring and running a deterministic workflow script. The script is plain JavaScript that runs in a sandbox and fans out real subagents through the DSL. The tool returns immediately with a `task_id` and `run_id`; the workflow runs in the background and its completion arrives automatically in a later turn as a `<task-notification>` carrying the run summary and result.

## Opt-in

The `Workflow` tool is active by default (`[agent] workflow_tool_enabled = true`), so you can author and run workflow scripts without entering ultracode mode. Ultracode mode — the `chesto!` keyword, a manual entry, or `[agent] ultracode = true` — additionally raises thinking effort to xhigh and keeps a maintenance loop running while you work; it is not required to use the `Workflow` tool. Set `workflow_tool_enabled = false` to gate the tool behind ultracode mode; while it is off, keep using `Agent` / `AgentSwarm`.

## How it works

You write a script that starts with a pure-literal `meta` object and exports an async `main()` entry point. Inside `main()` you call the DSL globals:

- `agent(prompt, opts?)` — spawn one subagent and await its result. `opts` may carry `label`, `phase`, `schema` (structured output), `model`, `effort`, `isolation`, `agentType`. The result is `{ ok, agentId, output, durationMs }`; `output` is `null` when the agent was skipped or errored.
- `parallel(items, fn, opts?)` — run `fn` over every item concurrently with a barrier; resolves in input order. A per-item throw yields `null` for that element.
- `pipeline(stages, opts?)` — run a linear chain of stages sequentially, each stage's output feeding the next as `prevResult`. Use `{ input }` to seed the first stage and `{ items }` to run the whole chain once per item. A throwing stage aborts the chain to `null`.
- `phase(title)` — announce a phase (matched against `meta.phases`).
- `log(...parts)` — append a line to the run journal.
- `args` — the structured value you passed as the tool's `args` parameter.
- `budget` — `{ total, spent(), remaining() }`. `total` is the run's token budget and `spent()` reflects real tokens consumed by subagents so far. Use `budget.remaining()` to decide whether to keep fanning out or wrap up.
- `workflow(fn | { fn, budget?, isolation? })` — run a nested workflow body inside the same sandbox (at most one level of nesting).

The runtime enforces hard budgets: a maximum of 1000 agents per run, 4096 items per `parallel()`/`pipeline()` call, no `eval`/`new Function`/WebAssembly inside the sandbox, a 30-second bound on any single `await`-free slice of script execution (so an infinite loop cannot pin the host), and a hard stop on new `agent()` calls once `budget.total` is exhausted (in-flight agents still complete; their results are preserved).

## When to use it

Use a workflow when the task decomposes into multiple distinct workstreams that benefit from real subagents — but only after scouting. A good workflow author first does a small amount of exploration themselves: read the key files, confirm the shape of the inputs, and pin down the concrete prompts each subagent should receive. Hand each subagent a complete brief; subagents start with zero context.

If the exploration shows the task does not need subagents, do it directly and tell the user why. For many similar subtasks that share one template, `AgentSwarm` may be the simpler tool. Reach for a workflow when the stages differ, depend on each other, or need orchestration (review → fix → verify), or when a structured output from each subagent must be collected and compared.

## Canonical pattern

A multi-stage workflow: scout the dimensions yourself, fan out one agent per dimension with a structured schema, then pipe the collected findings into a second fan-out that acts on them.

```js
export const meta = {
  name: 'Multi-stage review',
  description: 'Review each dimension, then act on the findings.',
  phases: [{ title: 'Review' }, { title: 'Action' }],
};

export async function main() {
  // Stage 1: one reviewer per dimension, each returning structured findings.
  const reviews = await parallel(
    DIMENSIONS,                     // e.g. ['architecture', 'security', 'performance']
    (dimension) => agent(dimension.prompt, {
      label: `review:${dimension.name}`,
      phase: 'Review',
      schema: {                       // subagent must produce this shape
        type: 'object',
        required: ['findings'],
        properties: { findings: { type: 'array', items: { type: 'string' } } },
      },
    }),
  );

  // Stage 2: act on every finding collected from the reviews.
  const findings = reviews.flatMap((r) => (r?.ok && r.output?.findings) || []);
  const fixes = await parallel(findings, (finding) =>
    agent(`Apply this fix: ${finding}`, { label: `fix:${finding.slice(0, 40)}`, phase: 'Action' }),
  );

  return { reviews, fixes };
}
```

`pipeline()` is for strictly sequential stages — a stage chain whose output feeds the next stage, no barrier:

```js
export const meta = { name: 'Build chain', description: 'plan -> implement -> verify' };

export async function main() {
  const outcome = await pipeline([
    async (plan) => agent(`Produce an implementation plan.`, { label: 'plan', schema: PLAN_SCHEMA }),
    async (plan, _, i) => agent(`Implement this plan:\n${JSON.stringify(plan)}`, { label: `impl:${i}` }),
    async (code) => agent(`Verify this implementation for correctness:\n${code}`, { label: 'verify' }),
  ]);
  return outcome;
}
```

## Quality patterns

- **Adversarial verify**: after work completes, spawn a critic that tries to break the result and reports defects. `const verdict = await agent('Find flaws in this result:\n' + result, { label: 'adversarial-verify' });`
- **Judge panel**: run a quality pass, then have several subagents independently rate/compare the outputs and reconcile their judgments in a final stage.
- **Loop-until-dry**: keep iterating a fix cycle until a checker reports no remaining issues — `while ((await checker).output?.issues?.length > 0)`, with a hard iteration cap so the loop cannot run away.
- **Completeness critic**: a dedicated subagent enumerates what a complete answer must cover and flags anything the other agents missed.

## Determinism contract

Scripts must be deterministic so a run can be resumed and replayed: plain JavaScript only, no `Date.now()`, `Math.random()`, `new Date()`, no `require`/`import`/`process`/`fs`/`globalThis`. The compiler rejects violations before the run starts, and the sandbox additionally *breaks* those builtins at runtime (so even an obfuscated access fails loudly instead of silently breaking resume caching). When you need bounded randomness (e.g. sampling), derive it deterministically from the input values — for N independent samples, include the index in the agent label or prompt. Pass all data into the script via `args` and return the run's result from `main()`.

## Resume

The tool result includes a `run_id`. To resume after a pause, kill, or script edit, call `Workflow` again with `resumeFromRunId` (and `scriptPath` if you edited the persisted script file) — every `agent()` call is keyed by `(prompt, opts)`, so unchanged calls return their cached results instantly no matter where they sit in the script; the first edited/new call and everything cache-missing after it runs live. Same script + same args → 100% cache hit. The script is allowed to differ from the prior run — replay is keyed per `agent()` call, not per script. Before diagnosing why a completed run returned an empty or unexpected result, read the run journal at `<sessionDir>/workflows/<run_id>/journal.jsonl` — it records each agent's actual return value; do not assume cached results are non-empty.

## Budget usage

`budget.total` is the run's token budget and `budget.spent()` reflects real subagent token consumption. Use it to keep the run in bounds:

- Prefer the cheapest sufficient model (`effort: 'low'`) for bulk, independent fan-out; reserve expensive effort for synthesis and verification stages.
- Guard long loops and large fan-outs with `budget.remaining()` checks; when it is low, reduce scope and consolidate results instead of spawning more.
- When a subagent returns `output === null` (failed or skipped), degrade gracefully — record the gap and continue, then surface it in your summary rather than failing the whole run.

## Background execution

The tool returns `{ task_id, run_id }` immediately. Do NOT wait, poll, or call TaskOutput — the completion arrives automatically as a `<task-notification>`. Continue with other work or hand back to the user. Use `/workflows` to watch live progress.
