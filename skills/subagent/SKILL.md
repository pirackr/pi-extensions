---
name: subagent
description: Delegate substantial, independently scoped work to specialized Pi agents. Use when parallelism, isolated context, or independent verification provides clear value.
---

# Subagent Delegation

Use `run_subagents` to delegate work to Pi processes managed through tmux.

## When to Delegate

Delegate when:

- Tasks are substantial and independently scoped.
- Parallel investigation will reduce latency.
- A specialist benefits from isolated context.
- Implementation needs independent review or testing.
- Exploration would consume significant parent context.

Do not delegate small, tightly coupled, latency-sensitive, or duplicate work. Keep work inline when coordination would cost more than direct execution.

## Task Contract

Every task must define a concrete objective, bounded scope, non-goals, constraints, observable acceptance criteria, relevant inputs, and expected evidence. Mark prior-agent findings as claims to verify rather than authoritative context.

## Agent Selection

Select the configured profile whose description best matches the task. Available profile names and descriptions are included in the `run_subagents` tool schema.

Prefer read-only profiles for exploration. Use shell or write profiles only when the task contract requires those capabilities. Profile configuration controls prompts, model selection, tools, access level, and default timeout.

## Delegation Rules

1. Keep integration and final decisions with the parent.
2. Parallel tasks must have independent, non-overlapping scopes.
3. Do not run parallel agents with shell or write access in the same worktree.
4. Do not delegate recursively.
5. Do not broaden a delegated task without user or parent approval.
6. Stop and report blockers instead of guessing missing requirements.
7. Use one `run_subagents` call for independent parallel tasks.
8. Keep chained workflows parent-driven: verify one stage before starting the next.

## Handoffs

Every downstream task receives the original contract, relevant primary artifacts, prior findings marked as unverified, claimed changes and checks, and unresolved questions. Never hand off only a prose summary.

## Result Requirements

Require status, concise results, files inspected or changed, evidence with file and line references, checks performed, observed test results, untested areas, unresolved risks, and a recommended next action.

## Verification

The parent owns final verification. Inspect resulting artifacts or diffs, validate every acceptance criterion, confirm tests actually ran, reconcile conflicting findings, and report residual risks. Agent summaries are evidence, not proof.

## Runtime Ownership

The `run_subagents` tool owns profile discovery, tmux sessions, Pi invocation, timeouts, cancellation, private artifacts, status capture, result extraction, and cleanup. Do not manually recreate its orchestration with shell commands.
