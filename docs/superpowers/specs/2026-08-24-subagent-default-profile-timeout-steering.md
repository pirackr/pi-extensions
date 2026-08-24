# Subagent: default profile, unlimited timeout, steering, UI refresh

## Status

Draft

## Summary

Four changes to the subagent extension:

1. Built-in `"general-purpose"` default profile — `subagent_type` becomes optional.
2. Unlimited timeout by default (no max validation, only `>= 0`).
3. Steering on timeout/error — spawn a summarizer subagent to produce a concise summary instead of raw logs.
4. Updated widget UI — tree glyphs, token context %, preview line of last activity.

---

## 1. Default profile

### What changes

- `types.ts` `AgentRequest`: `subagent_type` becomes optional (`string | undefined`).
- `manager.ts` `enqueue()`: if `subagent_type` is omitted, default to `"general-purpose"`.
- Create `extensions/subagent/subagents/general-purpose.md`:

```markdown
---
name: general-purpose
description: General-purpose subagent for code exploration, analysis, and independent tasks
tools: read, write, edit, grep, find, ls, web_lookup, fetch_web
---
You are a capable general-purpose coding assistant. Complete the task assigned to you thoroughly and report your findings.
```

- `config/subagent.json`: remove `models` aliases (`strong`, `eval`, `light`). Extensions that spawn subagents must contribute their own profiles via the `subagent:discover-profiles` event. If they don't, the fallback is `"general-purpose"`.

### Model resolution

The `general-purpose` profile uses the `models.strong` alias — but since we're removing aliases, it should resolve to a concrete model. The profile `.md` file does not specify `model:`, so it inherits from the config's `models` map. Since we're removing the map, we need to either:

- **Option A**: Add `model:` to the `.md` frontmatter pointing to a specific model.
- **Option B**: Keep a single `default` key in `models` that resolves the fallback.

**Decision: Option A** — the profile owns its model. No aliases.

Updated `general-purpose.md`:

```markdown
---
name: general-purpose
description: General-purpose subagent for code exploration, analysis, and independent tasks
model: lemonade/Ornith-1.5-35B-A3B-GGUF-Q4_K_M
tools: read, write, edit, grep, find, ls, web_lookup, fetch_web
---
You are a capable general-purpose coding assistant. Complete the task assigned to you thoroughly and report your findings.
```

### Validation

`normalizeAgentRequest` in `types.ts`: skip the `subagent_type` required check. The manager fills in the default before profile lookup.

---

## 2. Unlimited timeout

### What changes

- `config.ts` `DEFAULTS.defaultTimeoutSeconds`: `0` (was `300`). Value of `0` means no timeout.
- `config.ts` validation in `loadSubagentConfiguration` and `discoverProfiles`: change `{ min: 10, max: 1800 }` to `{ min: 0 }` — no upper bound.
- `config/subagent.json`: `"defaultTimeoutSeconds": 0`.
- `runner.mjs`: already checks `request.profile.timeoutSeconds !== null && request.profile.timeoutSeconds > 0` before setting the timer — no change needed. A value of `0` means the timer is never set.

### Backward compatibility

Existing profiles that specify their own `timeoutSeconds` (e.g. research profiles with `600`) continue to work. Only the *default* changes from 300 to 0.

---

## 3. Steering on timeout/error

### Problem

When an agent times out or errors, the runner force-kills the process and reports `"timed out after N seconds"`. The orchestrator (parent agent) must then read raw logs to understand what happened — expensive for a large model.

### Solution

On timeout or error, before terminating:

1. **Save transcript** — already saved to `files.transcript` by the runner.
2. **Spawn a summarizer subagent** — reads the transcript + logs, produces a 2-3 sentence summary of what the agent accomplished, what it was doing when it stopped, and any partial results.
3. **Replace output** — the summary becomes the terminal result's `output` field instead of raw streamed text.
4. **Include raw output** — the full raw output is preserved in the artifact directory as `raw-output.txt` for debugging.

### Implementation

#### runner.mjs changes

In the timeout handler (line ~688), instead of calling `terminate()` directly:

```javascript
// Current:
timeoutTimer = clock.setTimeout(() => {
    terminate("timed_out", `Timed out after ${request.profile.timeoutSeconds} seconds`);
}, request.profile.timeoutSeconds * 1_000);

// New:
timeoutTimer = clock.setTimeout(async () => {
    // 1. Try to get the last assistant text before killing
    beginAuthoritativeRequests({ stopReason: "timeout" });
    // 2. Wait briefly for the RPC round-trip
    await new Promise(resolve => setTimeout(resolve, 5_000));
    // 3. Publish with what we have (authoritativeText may now be populated)
    terminate("timed_out", `Timed out after ${request.profile.timeoutSeconds} seconds`);
}, request.profile.timeoutSeconds * 1_000);
```

Same pattern for error/abort stop reasons in `maybeFinishAfterClose`.

#### Summarizer (new: `extensions/subagent/summarizer.ts`)

A lightweight function that:

1. Reads the transcript file and result from the artifact directory.
2. Spawns a foreground subagent (using `general-purpose` profile) with a system prompt:

```
You are a summarizer. Read the following agent transcript and produce a concise summary:
- What the agent was trying to do
- What it accomplished (if anything)
- Why it stopped (timeout, error, etc.)
- Any partial results or files produced

Keep it to 2-3 sentences. Be specific about file paths and concrete outcomes.
```

1. The transcript is injected as the prompt context.
2. Returns the summary string.

#### Integration point

Called from `manager.ts` after a terminal result is published with state `timed_out` or `failed`. The manager checks if the result's `output` is empty or unhelpful, and if so, calls the summarizer.

```typescript
// In manager.ts, after publishTerminal:
if ((state === "timed_out" || state === "failed") && !terminal.output) {
    const summary = await summarizeAgent(artifactDir, deps);
    if (summary) {
        // Update the result with the summary
        await deps.store.updateResultOutput(agentId, summary);
    }
}
```

#### Cost

One additional small-model call per timeout/error. Acceptable because:

- Timeouts are exceptional, not routine.
- Saves the orchestrator (large model) from reading raw logs.
- The summarizer is fast (~5-10s).

---

## 4. Widget UI refresh

### Current format

```
  · subagent-rdsh planner Explore extension structure 662ms/600s 0 tools 0 tok failed
```

### New format

```
Agents
├─ ⠋ subagent(general-purpose): Explore extension structure · 10s · 3 tools · 1.2k tokens (10%)
│  └─ Exploring the project structure...
├─ ✓ subagent(planner): Research plan · 45s · 0 tools · 800 tokens (5%)
│  └─ Created score.md with 6 sub-questions
└─ ⏰ subagent(scout): Nested task · 5m · 1 tool · 400 tokens (2%)
   └─ Fetching URL: example.com/article...
```

### Format spec

```
{tree_glyph}{state_marker} subagent({profile}): {description} · {elapsed} · {tools} · {tokens} ({context_pct}%)
{indent}  └─ {activity_preview}
```

#### Tree glyphs

- `├─` for non-last siblings
- `└─` for last sibling
- `│` for continuation lines (indented under parent)

#### State markers (existing)

| State | Glyph |
| ------- | ------- |
| queued | ⏳ |
| starting | ⠙ |
| running | ⠋ |
| succeeded | ✓ |
| failed | ✗ |
| timed_out | ⏰ |
| cancelled | − |
| interrupted | ⚠ |

#### Fields

| Field | Source | Format |
| ------- | -------- | -------- |
| `profile` | `manifest.profile.name` | string |
| `description` | `manifest.description` | string |
| `elapsed` | `finishedAt - startedAt` or `now - startedAt` | `formatDurationMs()` |
| `tools` | `manifest.usage.toolUses` | `{n} tool{s}` |
| `tokens` | `manifest.usage.totalTokens` | `compactTokens(n) tokens` |
| `context_pct` | `totalTokens / contextWindow * 100` | `({n}%)` — omitted if contextWindow is 0/null |
| `activity_preview` | `manifest.activity` | truncated to ~60 chars, prefixed with `└─` |

#### Activity preview

The `activity` field in `AgentManifest` is already updated by the runner during execution. Currently it contains strings like `"starting task"`, `"responding"`. We extend it to include:

- Tool call names: `"calling read_symbol"` → rendered as `Reading read_symbol...`
- Truncated last message snippet (first 60 chars of the current assistant message)
- On completion: the first 60 chars of the final output

### Code changes

#### `render.ts`

- `formatWidgetRow()`: rewrite to use tree glyphs, new format, and activity preview line.
- `AgentWidgetRow`: add `contextWindow: number | null` and `activity: string | null` fields.
- `widgetRows()` in `index.ts`: populate `contextWindow` from manifest, pass through `activity`.

#### `index.ts`

- `widgetRows()`: add `contextWindow` from `manifest.profile.contextWindow` or from the status update.

---

## Files to modify

| File | Change |
| ------ | -------- |
| `extensions/subagent/types.ts` | Make `subagent_type` optional in `AgentRequest` |
| `extensions/subagent/manager.ts` | Default `subagent_type` to `"general-purpose"`; add summarizer call on timeout/error |
| `extensions/subagent/config.ts` | Default timeout to 0, remove max cap |
| `extensions/subagent/render.ts` | New widget format with tree glyphs, context %, activity preview |
| `extensions/subagent/index.ts` | Pass `contextWindow` through `widgetRows()` |
| `extensions/subagent/subagents/general-purpose.md` | New file — built-in default profile |
| `config/subagent.json` | Remove `models` aliases, set `defaultTimeoutSeconds: 0` |

## Files to create

| File | Purpose |
|------|---------|
| `extensions/subagent/summarizer.ts` | Summarizer logic for timeout/error steering |

## Testing

- Unit test: `normalizeAgentRequest` accepts no `subagent_type`
- Unit test: `enqueue()` defaults to `"general-purpose"` profile
- Unit test: timeout of 0 means no timer set
- Unit test: summarizer produces summary from transcript
- Unit test: `formatWidgetRow` produces new format with tree glyphs
- Integration test: spawn agent without `subagent_type`, verify it uses `general-purpose`
