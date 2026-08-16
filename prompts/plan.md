---
description: Write a concise implementation plan (writing-plans style, no code)
argument-hint: "<feature-or-spec>"
---
Write a concise implementation plan for: ${@:-the current task}

Follow the superpowers writing-plans skill conventions, but keep it **less
verbose — no code blocks**.

**Output:** save to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.

**Plan header:** Goal (one sentence), Architecture (2-3 sentences), Files
(created/modified, one line each), Global Constraints (verbatim from the
spec, one line each).

**Tasks:** small, ordered, independently testable. Each task lists its files
and interfaces (consumes / produces), then steps at 2-5-minute granularity
(write failing test -> verify fails -> implement -> verify passes -> commit)
— all as **prose**, never code fences.

**Rules:**

- No code blocks anywhere — describe code and commands in words.
- No placeholders ("TBD", "implement later", "add error handling") — every
  step concrete and actionable.
- Self-review before finishing: spec coverage, placeholder scan,
  interface/type consistency across tasks.

Skip the execution-handoff offer unless asked.
