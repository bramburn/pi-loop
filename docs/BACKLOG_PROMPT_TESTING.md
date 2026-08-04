# Task-backlog prompt testing

Task-backlog workers must execute eligible work, not merely report state or promise to start on a later wake.

## Execution contract

Every `taskBacklog` wake places this contract before the caller-supplied goal:

1. `TaskList` is the first tool call; no progress prose comes first.
2. Inspect current task state, then claim or resume one eligible task.
3. Use real work tools in the same turn. A plan, selected task, status report, or future-tense promise is not progress.
4. Treat `TaskGet` as execution authority. Use normal implementation judgment rather than inventing ambiguity.
5. Run the validation command or tool required by the task and inspect its observable result. Reads, edits, or reasoning alone do not prove validation.
6. Complete the task with its retained `claimId` only after validation.
7. The only no-work exits are an empty backlog or a live-owner/dependency blocker verified with fresh `TaskGet` evidence.
8. A later wake is crash/recovery continuity, not permission to defer executable work.

The same prefix is stored in the built-in worker prompt. Previous prompt versions remain recognized and migrate on startup so persisted workers do not orphan.

## Evaluation evidence

Plan-only evaluations initially produced a false sense of safety: three clean-slate executors could describe the intended sequence even though the runtime prompt did not prohibit status-only turns. The observed real failure and red prompt-contract tests therefore remained the authoritative baseline.

| Revision | Scenario | Critical result | Accuracy | Main finding |
|---|---|---:|---:|---|
| Baseline | pending, eligible, blocked | pass in simulation | 100% | describing a plan did not prove execution compliance |
| Action-first v1 | status-oriented goal + code task | fail | 80% | executor used prose placeholders and invented ambiguity |
| Tool-action v2 | exact receipt task | pass | 100% | explicit write and validation calls |
| Observable-validation v1 | expired-claim JSON task | fail | 80% | executor treated read/edit or in-memory reasoning as validation |
| Observable-validation v2 | JSON parser task | pass | 100% | separate parser command before completion |
| Convergence | exact receipt + live-owner blocker | pass/pass | 100%/100% | zero unclear points and zero retries |

The final holdout retained 100% checklist accuracy. Two fresh convergence scenarios produced no unclear points. Invalid evaluations that inspected a real task store instead of the hypothetical scenario were discarded rather than counted.

## Live Pi harness

`test/e2e/backlog-action-first.mjs` runs the exact exported execution contract through a real isolated `pi --mode rpc` process. It pre-seeds one native task, exposes only the task/read/write/bash tools needed by the scenario, and requires this sequence in the first agent run:

```text
TaskList → TaskGet → TaskClaim → write/edit → bash validation → TaskUpdate completed
```

The harness rejects:

- any tool before `TaskList`;
- status-only completion or a second agent run;
- missing `TaskGet`, claim, concrete work, observable validation, or `claimId`;
- `LoopUpdate` or `LoopDelete`;
- invalid receipt content or incomplete task state.

Run it explicitly:

```bash
PI_LOOP_LIVE_MODEL="openai-codex/gpt-5.6-sol:minimal" npm run test:e2e:backlog
PI_LOOP_LIVE_MODEL="github-copilot/claude-haiku-4.5" npm run test:e2e:backlog
```

Without `PI_LOOP_LIVE_MODEL`, the script builds and exits with an explicit skip. Artifacts are written under `.artifacts/live-backlog/`, bounded, and redact claim tokens.

Final live results:

- `openai-codex/gpt-5.6-sol:minimal`: passed in one agent run;
- `github-copilot/claude-haiku-4.5`: passed in one agent run;
- both started with `TaskList`, performed file work, inspected a shell validation result, and completed with the retained claim.

## Guarantee boundary

Deterministic tests guarantee what text pi-loop injects and how persisted worker prompts migrate. The live harness measures model compliance with that contract. Prompts cannot make arbitrary models perfectly reliable, and pi-loop cannot atomically combine file changes, external-provider task settlement, and host message delivery. Re-wakes remain at-least-once recovery; they are not an excuse for a model to defer same-turn work.
