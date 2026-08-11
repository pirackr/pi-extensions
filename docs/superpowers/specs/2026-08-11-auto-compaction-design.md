# Model-Aware Auto-Compaction Extension Design

## Status

Design approved in conversation on 2026-08-11. This document is awaiting final user review before implementation planning.

## Goal

Add a Pi extension that automatically compacts a session when context usage reaches a configurable threshold. Thresholds may be expressed as a percentage of the active model's context window or as an absolute token count, and may be customized with ordered `provider/model-id` glob rules.

The extension must enforce thresholds both earlier and later than Pi's built-in `compaction.reserveTokens` threshold while preserving manual `/compact`, Pi's overflow recovery, Pi's normal summary generation, and Pi's existing `keepRecentTokens` behavior.

## Non-Goals

- Replacing Pi's summary prompt or summary model.
- Changing how Pi chooses the compaction cut point.
- Configuring `keepRecentTokens` per model.
- Mutating Pi's global or project `settings.json`.
- Replacing branch summarization.
- Adding automatic retries that could create a compaction loop.

## User Experience

The extension operates without model-context messages or interactive prompts.

It evaluates context usage when a session starts, when the active model changes, and after each completed turn. When the effective threshold is reached, it invokes Pi's existing `ctx.compact()` flow. In UI-capable modes it reports automatic compaction start, completion, and failure through notifications.

The extension registers `/auto-compact`, which reports:

- whether the extension is globally enabled;
- the active `provider/model-id` and context window;
- current token and percentage usage, when known;
- the matched rule, its source layer, and the effective token threshold;
- controller state: armed, in flight, or disabled;
- loaded or ignored configuration paths;
- configuration warnings; and
- the most recent compaction error.

Configuration changes take effect through Pi's normal `/reload` flow.

## Package Layout

The implementation will use focused modules:

```text
config/
└── auto-compact.json
extensions/
└── auto-compact/
    ├── index.ts
    ├── config.ts
    ├── policy.ts
    └── controller.ts
tests/
├── auto-compact-config.test.ts
├── auto-compact-policy.test.ts
└── auto-compact-controller.test.ts
```

Responsibilities:

- `index.ts`: load session configuration, register Pi events, register `/auto-compact`, and translate controller outcomes into UI notifications.
- `config.ts`: discover, parse, strictly validate, and layer packaged, user, and project configuration.
- `policy.ts`: match canonical model keys, resolve the winning rule, convert percentages to token thresholds, and produce runtime warnings.
- `controller.ts`: evaluate usage, coordinate with Pi's compaction events, and maintain loop-prevention state.

The package will declare `minimatch` as a runtime dependency rather than relying on Pi's transitive dependencies or implementing a partial glob engine.

## Configuration Locations and Trust

Configuration is loaded from these layers:

1. Packaged defaults: `config/auto-compact.json`.
2. User configuration: `$PI_AGENT_DIR/auto-compact/config.json`, where Pi's active agent directory is honored.
3. Project configuration: `<cwd>/${CONFIG_DIR_NAME}/auto-compact.json`.

The project layer is read only when `ctx.isProjectTrusted()` is true. The implementation must use Pi's exported `CONFIG_DIR_NAME` rather than hardcoding `.pi`.

An invalid packaged configuration is fatal because it is a package defect. An invalid user or project file causes that entire layer to be ignored while lower valid layers remain active. Warnings identify the file and invalid field but do not echo configuration values.

## Configuration Schema

The packaged default is:

```json
{
  "enabled": true,
  "default": { "percent": 80 },
  "rules": []
}
```

A user or project file may be partial:

```json
{
  "default": { "percent": 80 },
  "rules": [
    {
      "match": "anthropic/claude-*",
      "percent": 75
    },
    {
      "match": "openai/gpt-5.4",
      "tokens": 180000
    },
    {
      "match": "google/gemini-*",
      "enabled": false
    }
  ]
}
```

Top-level fields:

- `enabled`: optional boolean outside the packaged file. The highest-precedence specified value wins.
- `default`: optional threshold object containing exactly one of `percent` or `tokens`. The highest-precedence specified default wins.
- `rules`: optional ordered array of complete model rules.

Rule fields:

- `match`: required non-empty glob matched against the case-sensitive canonical key `provider/model-id`.
- `enabled`: optional boolean, defaulting to `true`.
- `percent`: context-usage percentage greater than `0` and at most `100`.
- `tokens`: positive integer context-usage threshold.

An enabled rule must contain exactly one of `percent` or `tokens`. A disabled rule must contain neither. Unknown fields are rejected.

## Layer and Rule Precedence

Configuration layers are retained rather than deep-merging rule arrays.

Resolution proceeds as follows:

1. Determine global extension enablement from the highest-precedence layer that specifies `enabled`: project, then user, then packaged.
2. If globally disabled, the extension remains inert and does not alter Pi's built-in compaction behavior.
3. Search project rules in file order and take the first match.
4. If none match, search user rules in file order.
5. If none match, search packaged rules in file order.
6. If no rule matches, use the highest-precedence specified `default` threshold.

This allows a project to add a narrow override without copying every user-level rule. A matching rule is atomic and is not field-merged with a lower layer.

Glob matching uses `minimatch` without basename matching and is case-sensitive. Patterns are expected to include the provider/model separator, for example `anthropic/claude-*`.

## Threshold Semantics

Thresholds represent context already used, not context remaining.

For percentage rules:

```text
effectiveThresholdTokens = floor(contextWindow * percent / 100)
```

For absolute rules, the configured token count is used directly. Compaction becomes eligible when:

```text
contextTokens >= effectiveThresholdTokens
```

An absolute threshold larger than the active model's context window is not silently clamped. The policy remains valid, `/auto-compact` reports a warning, and Pi's overflow recovery remains available.

If Pi reports context usage as unknown, including immediately after a compaction and before a new valid assistant usage record exists, automatic evaluation is skipped until reliable usage becomes available.

## Event and Data Flow

### Session start

On `session_start`, the extension:

1. Loads packaged and user configuration.
2. Loads project configuration only when the project is trusted.
3. Resolves the current model policy.
4. Resets session-local controller state.
5. Evaluates current usage if the model and usage are available.

This handles resumed sessions that already exceed their effective threshold.

### Model selection

On `model_select`, the controller resets threshold state for the new canonical model key and evaluates usage immediately. Switching from a large-context model to a smaller one can therefore compact before the user sends another prompt.

### Completed turn

On `turn_end`, the controller resolves current usage and policy. If the threshold is armed, usage is known, and usage is at or above the effective threshold, it marks compaction in flight and calls `ctx.compact()`.

`ctx.compact()` uses Pi's manual compaction path internally. The extension does not provide custom summary content through `session_before_compact`, so Pi continues to own summary generation, cut-point selection, file tracking, and `keepRecentTokens`.

### Pi compaction gate

The extension handles `session_before_compact` to coordinate Pi's built-in checks:

- `reason === "manual"`: always allow, including extension-triggered `ctx.compact()` and user `/compact`.
- `reason === "overflow"`: always allow so Pi can recover from oversized requests.
- `reason === "threshold"` while the extension is globally disabled: allow unchanged Pi behavior.
- `reason === "threshold"` while plugin compaction is already in flight: cancel the duplicate attempt.
- `reason === "threshold"` with a disabled matching model rule: cancel threshold compaction.
- `reason === "threshold"` below the custom threshold: cancel as premature.
- `reason === "threshold"` at or above the custom threshold: allow Pi to compact.

The gate should prefer `event.preparation.tokensBefore` for its threshold comparison because it describes the context Pi is preparing to compact. If a model or context window cannot be resolved, it fails open and allows Pi's behavior.

This dual trigger-and-gate design supports both directions:

- A custom threshold earlier than Pi's built-in threshold is initiated by the extension.
- A custom threshold later than Pi's built-in threshold cancels premature Pi attempts until the custom threshold is reached.

## Controller State and Loop Prevention

Controller state is session-local and contains:

- current canonical model key;
- whether threshold evaluation is armed;
- whether plugin-triggered compaction is in flight;
- the last resolved policy and usage snapshot; and
- the most recent compaction error.

The threshold is edge-triggered:

- It fires once when usage first reaches or exceeds the threshold.
- It remains disarmed while usage remains above the threshold.
- It rearms after usage is observed below the threshold.
- A model change resets and rearms evaluation for the new model.
- A successful compaction leaves it disarmed until reliable post-compaction usage is available and below threshold.

This prevents repeated summaries when one compaction does not reduce usage below the configured threshold.

## Failure Handling

Configuration handling:

- Packaged parse or validation failure stops extension initialization with a clear error.
- User or project read, parse, or validation failure ignores only that layer.
- Untrusted project configuration is not read and is reported as inactive by `/auto-compact`.

Compaction handling:

- `onComplete` clears in-flight state, records completion state, and notifies when UI is available.
- `onError` clears in-flight state, records the error, leaves the threshold disarmed to avoid an immediate retry loop, and notifies when UI is available.
- A later Pi threshold attempt is still allowed once the custom threshold is satisfied.
- Pi overflow recovery and user `/compact` remain available after failure.

Event-handler failures must not inject messages into model context. UI methods are guarded with `ctx.hasUI`, and the extension remains functional in TUI, RPC, JSON, and print modes.

## Status Command

`/auto-compact` takes no arguments in the initial version. It formats a concise status report from the current controller and configuration state.

When UI is available, the report is emitted through Pi's extension UI. It does not use `pi.sendMessage()` and therefore does not consume model context. When no model or usage is available, the report explicitly marks those values as unavailable rather than guessing.

## Testing Strategy

### Configuration tests

- Loads the exact packaged 80% default.
- Applies user and trusted-project scalar precedence.
- Searches project rules before user rules.
- Preserves first-match order within a layer.
- Ignores invalid user or project layers without discarding valid lower layers.
- Treats packaged configuration errors as fatal.
- Rejects unknown fields.
- Enforces exactly one threshold on enabled rules.
- Accepts disabled rules without thresholds.
- Ignores untrusted project configuration.
- Does not expose configuration values in warnings.

### Policy tests

- Matches canonical provider/model globs case-sensitively.
- Does not match model basenames without the provider unless the pattern explicitly permits it.
- Resolves percentage thresholds with floor semantics.
- Resolves absolute token thresholds.
- Uses `>=` at the boundary.
- Reports an oversized absolute threshold without clamping it.
- Resolves disabled rules and fallback defaults correctly.

### Controller and event tests

A fake Pi API and extension context will capture registered handlers, compaction calls, callbacks, and notifications.

Coverage includes:

- compacts once on threshold crossing;
- evaluates resumed sessions and model changes immediately;
- skips unknown context usage;
- prevents duplicate in-flight compactions;
- cancels premature Pi threshold compaction;
- allows Pi threshold compaction at the custom limit;
- always allows manual and overflow compaction;
- suppresses threshold compaction for a disabled model rule;
- leaves all Pi behavior unchanged when globally disabled;
- records failures without immediate retry loops; and
- rearms after usage falls below threshold.

### Verification

Before completion:

1. Run focused auto-compaction Vitest files.
2. Run the complete Vitest suite.
3. Run LSP and session diagnostics on changed TypeScript files.
4. Load the extension through Pi where feasible and verify event and command registration without startup errors.

The repository's local `@earendil-works/pi-coding-agent` type shim will be extended only with the public model, context-usage, compaction, event, and constant types required by this extension.

## Documentation Changes

Update `README.md` with:

- extension purpose;
- configuration locations;
- schema example;
- precedence and first-match behavior;
- `/reload` instructions; and
- `/auto-compact` status command.

## Acceptance Criteria

The implementation is complete when:

1. An unmatched model compacts at 80% context usage by default.
2. Ordered provider/model glob rules can set percentage thresholds, absolute token thresholds, or disable threshold compaction.
3. Trusted project rules override user rules without requiring the user rule list to be copied.
4. Switching models immediately evaluates the new model's context window and rule.
5. Thresholds earlier and later than Pi's built-in reserve threshold are both enforced.
6. Manual `/compact` and Pi overflow recovery are never blocked.
7. Pi remains responsible for summary generation and `keepRecentTokens`.
8. Invalid optional configuration layers degrade safely with visible diagnostics.
9. Duplicate and repeated compaction loops are prevented.
10. `/auto-compact` accurately explains the active policy and controller state without adding model-context messages.
