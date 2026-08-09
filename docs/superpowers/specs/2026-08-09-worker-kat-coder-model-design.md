# Worker KAT Coder Model Design

## Goal

Configure only the `worker` subagent to use the available local KAT Coder model.

## Design

Change the `model` frontmatter field in `subagents/worker.md` from the shared `strong` alias to the exact model identifier `Kwaipilot_KAT-Coder-V2.5-Dev-GGUF-Q8_0`.

No global model aliases, other subagent profiles, prompts, tools, or runtime behavior will change. Verification will confirm the frontmatter parses and the model appears in `pi --list-models`.
