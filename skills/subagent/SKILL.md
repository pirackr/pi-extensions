---
name: subagent
description: Delegate substantial, independently scoped work to specialized Pi agents. Use when parallelism, isolated context, or independent verification provides clear value.
---

# Subagent Delegation

Delegate substantial, independently scoped work to specialized Pi agents.
Three tools form the entire public API:

- **Agent** — launch one subagent. Background execution defaults to `true`, so
  Agent returns immediately with a durable receipt carrying a four-character
  agent id (for example `a7k2`). Pass `run_in_background: false` only when you
  truly need a foreground agent.
- **get_subagent_result** — inspect live state or retrieve and consume a
  durable terminal result by agent id.
- **stop_subagent** — cancel queued work or request cancellation of a running
  subagent.

## Background by default

`Agent` enqueues and returns a receipt the same turn. Read the outcome later
with `get_subagent_result` (add `wait: true` to block until the agent reaches a
terminal state). Because background runs are asynchronous, never assume output
is ready in the same turn it was launched, and never treat the receipt as the
result.

## Parallelism

Launch multiple `Agent` calls in a single turn for independent, non-overlapping
tasks. Each call receives its own four-character id; retrieve and consume each
one separately with `get_subagent_result`.

## Attach and result retrieval

The receipt reports an attach command (a tmux target) to watch a live run and
the artifact path. Fetch the finished output with
`get_subagent_result` once the agent is terminal; a terminal result is
consumed once, so call it after the agent finishes rather than before.

## Agent ids

Every agent is identified by a four-character lowercase id such as `a7k2`. Use
it verbatim for `get_subagent_result` and `stop_subagent`.

## Configuration

Configuration is layered **packaged < user < trusted project**: the highest
layer that specifies a value wins, except `models` (merged) and `agentDirs`
(concatenated). Profile names, models, tool access, and timeouts are resolved
through this precedence. Run `/reload` after changing configuration or
profiles.

## Trusted project gate

The project layer at `<project>/.pi/subagent/config.json` loads only when the
project is trusted; an untrusted project contributes no layer and its
project-scoped profiles and settings are unavailable until trust is granted.
This is why the trusted-project gate matters before relying on local config.

## Foreground nesting

A subagent invoked inside another subagent must run in the foreground: set
`run_in_background` to `false`. Nested agents never launch their own background
agents.

## Temporary files

Artifacts and transcripts live under `/tmp`, which is shared and, on many
hosts, world-readable. Treat agent output as sensitive: keep secrets out of
prompts and never rely on `/tmp` contents persisting between sessions.

## Delegation Rules

1. Keep integration and final decisions with the parent.
2. Parallel tasks must have independent, non-overlapping scopes.
3. Do not run parallel agents with shell or write access in the same worktree.
4. Do not delegate recursively (the foreground-nesting rule apart).
5. Do not broaden a delegated task without user or parent approval.
6. Stop and report blockers instead of guessing missing requirements.
7. One turn may hold many `Agent` calls for independent work.
8. Keep chained workflows parent-driven: verify one stage before starting the next.

## Handoffs

Every downstream task receives the original contract, relevant primary
artifacts, prior findings marked as unverified, claimed changes and checks, and
unresolved questions. Never hand off only a prose summary.

## Result Requirements

Require status, concise results, files inspected or changed, evidence with file
and line references, checks performed, observed test results, untested areas,
unresolved risks, and a recommended next action.

## Verification

The parent owns final verification. Inspect resulting artifacts or diffs,
validate every acceptance criterion, confirm tests actually ran, reconcile
conflicting findings, and report residual risks. Agent summaries are evidence,
not proof.
