# Subagent: default profile, unlimited timeout, steering, UI refresh

**Goal:** Add a built-in general-purpose fallback profile, unlimited default timeout, summarizer steering on failure, and a refreshed widget UI with tree glyphs and activity previews.

**Architecture:** A new bundled `.md` profile provides the default when `subagent_type` is omitted. The runner gains a graceful-shutdown path on timeout/error that fetches the last assistant text before terminating. A summarizer module spawns a lightweight foreground subagent to distill transcript logs into a concise summary. The widget renderer switches to tree-drawing glyphs with context-percentage and a subtitle preview line.

**Tech Stack:** TypeScript ESM, Pi Extension API, Pi JSONL RPC, Node.js child process, Vitest.

## Global Constraints

- `subagent_type` is optional; omitting it must behave identically to passing `"general-purpose"`.
- Default timeout is unlimited (0); profiles may still set their own positive timeout.
- Validation allows any non-negative integer for timeout; no upper bound.
- The summarizer uses the `general-purpose` profile in foreground mode; it must not spawn its own subagents.
- Tree glyphs are `├─`, `└─`, and `│` (Unicode box-drawing); no ASCII substitutes.
- Token context percentage is omitted when `contextWindow` is 0 or null.
- Activity preview is truncated to 60 characters; empty activity shows no preview line.
- Preserve all existing test suites; new tests are additive.

---

## File Structure

**Create**

- `extensions/subagent/subagents/general-purpose.md` — bundled fallback profile.
- `extensions/subagent/summarizer.ts` — transcript summarizer for timeout/error steering.
- `extensions/subagent/__tests__/summarizer.test.ts` — summarizer unit tests.
- `extensions/subagent/__tests__/default-profile.test.ts` — default profile and optional type tests.

**Modify**

- `extensions/subagent/types.ts` — make `subagent_type` optional in `AgentRequest`.
- `extensions/subagent/manager.ts` — default `subagent_type` to `"general-purpose"`; invoke summarizer on terminal failure.
- `extensions/subagent/config.ts` — default timeout to 0; remove max cap on timeout validation.
- `extensions/subagent/render.ts` — new widget format with tree glyphs, context %, activity preview.
- `extensions/subagent/index.ts` — pass `contextWindow` through `widgetRows()`.
- `extensions/subagent/runner.mjs` — graceful shutdown: fetch last text before terminate on timeout/error.
- `config/subagent.json` — remove model aliases; set `defaultTimeoutSeconds: 0`.

---

### Task 1: Unlimited timeout default

**Files:** Modify `config.ts`, `config/subagent.json`.

**Interfaces:** `DEFAULTS.defaultTimeoutSeconds` produces `0`; `loadSubagentConfiguration` and `discoverProfiles` accept any `>= 0` timeout.

- [ ] Write failing tests: config loaded with no timeout produces 0; a profile with `timeoutSeconds: 99999` passes validation; a profile with `timeoutSeconds: -1` fails validation.
- [ ] Run config tests and confirm the new timeout assertions fail.
- [ ] Change `DEFAULTS.defaultTimeoutSeconds` from 300 to 0.
- [ ] In `loadSubagentConfiguration` and `discoverProfiles`, replace `{ min: 10, max: 1800 }` with `{ min: 0 }` for timeout validation.
- [ ] Update `config/subagent.json`: remove the `models` key entirely; set `defaultTimeoutSeconds` to 0.
- [ ] Run config tests and confirm all pass.
- [ ] Commit as `feat(subagent): unlimited default timeout, remove model aliases`.

### Task 2: Built-in general-purpose profile

**Files:** Create `extensions/subagent/subagents/general-purpose.md`; create `extensions/subagent/__tests__/default-profile.test.ts`.

**Interfaces:** `discoverProfiles` returns a profile named `"general-purpose"` with model `lemonade/Ornith-1.5-35B-A3B-GGUF-Q4_K_M`; `normalizeAgentRequest` accepts input without `subagent_type`.

- [ ] Create `extensions/subagent/subagents/general-purpose.md` with frontmatter name `general-purpose`, description, model `lemonade/Ornith-1.5-35B-A3B-GGUF-Q4_K_M`, and tools list.
- [ ] Write failing test: `discoverProfiles` includes a profile named `"general-purpose"` with the correct model and tools.
- [ ] Write failing test: `normalizeAgentRequest` with no `subagent_type` field returns an object with `subagent_type: undefined`.
- [ ] Write failing test: `normalizeAgentRequest` with `subagent_type: "general-purpose"` returns it as-is.
- [ ] Run the new tests and confirm they fail.
- [ ] In `types.ts`, remove the `subagent_type` required-string check from `normalizeAgentRequest`; allow `undefined`.
- [ ] Update the `AgentRequest` interface: `subagent_type` becomes `string | undefined`.
- [ ] Run the new tests and confirm they pass.
- [ ] Commit as `feat(subagent): add built-in general-purpose profile`.

### Task 3: Default profile fallback in manager

**Files:** Modify `manager.ts`; extend `default-profile.test.ts`.

**Interfaces:** `enqueue()` accepts a request with no `subagent_type` and resolves to the `"general-purpose"` profile.

- [ ] Write failing test: `enqueue()` with `subagent_type: undefined` creates a manifest with `profile.name === "general-purpose"`.
- [ ] Write failing test: `enqueue()` with `subagent_type: "planner"` still resolves to the planner profile.
- [ ] Run manager tests and confirm the new assertions fail.
- [ ] In `enqueue()`, after `normalizeAgentRequest`, if `request.subagent_type` is undefined, set it to `"general-purpose"`.
- [ ] Run manager tests and confirm all pass.
- [ ] Commit as `feat(subagent): default to general-purpose profile when type omitted`.

### Task 4: Runner graceful shutdown on timeout

**Files:** Modify `runner.mjs`; test via runner integration tests.

**Interfaces:** On timeout, runner calls `beginAuthoritativeRequests` and waits up to 5 seconds before `terminate`.

- [ ] Write failing test: when `timeoutSeconds` fires, `authoritativeText` is fetched before publish (mock RPC to return text on `get_last_assistant_text`).
- [ ] Write failing test: when timeout fires and RPC does not respond within 5 seconds, the agent still terminates with `timed_out` state.
- [ ] Run runner tests and confirm the new assertions fail.
- [ ] In the timeout handler, replace the direct `terminate()` call with: call `beginAuthoritativeRequests({ stopReason: "timeout" })`, wait 5 seconds via `clock.setTimeout`, then call `terminate`.
- [ ] Apply the same pattern to the error/abort path in `maybeFinishAfterClose` when `stopReason` is `"error"` or `"aborted"`.
- [ ] Run runner tests and confirm all pass.
- [ ] Commit as `feat(subagent): graceful shutdown on timeout and error`.

### Task 5: Summarizer module

**Files:** Create `extensions/subagent/summarizer.ts`; create `extensions/subagent/__tests__/summarizer.test.ts`.

**Interfaces:** `summarizeAgent(artifactDir, profile): Promise<string | null>` reads transcript and result, spawns foreground subagent, returns summary text.

- [ ] Write failing test: given a transcript file with tool calls and assistant text, `summarizeAgent` returns a non-empty string.
- [ ] Write failing test: given an empty transcript, `summarizeAgent` returns null.
- [ ] Write failing test: given a missing artifact directory, `summarizeAgent` returns null.
- [ ] Run summarizer tests and confirm they fail.
- [ ] Implement `summarizeAgent`: read `transcript.log` and `result.json` from the artifact dir; build a prompt with the summarizer system instructions and the transcript as context; spawn a foreground `Agent` call using the `general-purpose` profile; return the output text.
- [ ] Handle errors gracefully: if the subagent fails or times out, return null.
- [ ] Run summarizer tests and confirm they pass.
- [ ] Commit as `feat(subagent): add transcript summarizer`.

### Task 6: Manager summarizer integration

**Files:** Modify `manager.ts`; extend summarizer tests.

**Interfaces:** After publishing a `timed_out` or `failed` result with empty output, the manager calls `summarizeAgent` and updates the result.

- [ ] Write failing test: after `publishTerminal` with state `timed_out` and empty output, `summarizeAgent` is called and the result output is updated with the summary.
- [ ] Write failing test: after `publishTerminal` with state `succeeded`, `summarizeAgent` is not called.
- [ ] Write failing test: when `summarizeAgent` returns null, the result output remains unchanged.
- [ ] Run manager tests and confirm the new assertions fail.
- [ ] In `enqueue()`, after `publishTerminal` resolves, check if state is `timed_out` or `failed` and output is empty; if so, call `summarizeAgent` and update the stored result.
- [ ] Run manager tests and confirm all pass.
- [ ] Commit as `feat(subagent): integrate summarizer on timeout and error`.

### Task 7: Widget UI refresh

**Files:** Modify `render.ts`, `index.ts`.

**Interfaces:** `formatWidgetRow` returns tree-glyph-prefixed lines with context percentage and activity preview; `AgentWidgetRow` gains `contextWindow` and `activity` fields.

- [ ] Write failing tests: `formatWidgetRow` with a running agent at depth 0 produces `├─ ⠋ subagent(id): desc · 10s · 3 tools · 1.2k tokens (10%)`.
- [ ] Write failing test: `formatWidgetRow` with a succeeded agent at depth 0 as last sibling produces `└─ ✓ subagent(id): desc · 5s · 0 tools · 200 tokens`.
- [ ] Write failing test: `formatWidgetRow` with `activity: "Reading read_symbol"` produces a second line `│  └─ Reading read_symbol`.
- [ ] Write failing test: `formatWidgetRow` with `activity: null` produces no second line.
- [ ] Write failing test: `formatWidgetRow` with `contextWindow: null` omits the percentage.
- [ ] Write failing test: `formatWidgetRow` with `activity` longer than 60 chars truncates with `…`.
- [ ] Run render tests and confirm the new assertions fail.
- [ ] Update `AgentWidgetRow` interface: add `contextWindow: number | null` and `activity: string | null`.
- [ ] Rewrite `formatWidgetRow` to produce the new format: tree glyph based on sibling position and depth, state marker, `subagent({profile})`, description, elapsed, tools, tokens with optional context %, and activity preview line.
- [ ] In `index.ts` `widgetRows()`, populate `contextWindow` from `manifest.profile.contextWindow` and `activity` from the manifest.
- [ ] Run render tests and confirm all pass.
- [ ] Commit as `feat(subagent): refresh widget UI with tree glyphs and activity preview`.

### Task 8: Notification and footer alignment

**Files:** Modify `render.ts`.

**Interfaces:** `renderNotificationItem` and `retrieveSummary` use updated format; footer counts remain unchanged.

- [ ] Write failing test: `renderNotificationItem` for a `timed_out` agent includes the summary text (not raw output).
- [ ] Write failing test: `retrieveSummary` for a summarized result returns the summary, not `"No output"`.
- [ ] Run notification tests and confirm they fail.
- [ ] Update `renderNotificationItem` and `retrieveSummary` to handle summarized output gracefully (no format change needed — they already use `result.output`; verify they display summaries correctly).
- [ ] Run notification tests and confirm all pass.
- [ ] Commit as `fix(subagent): align notifications with summarized output`.

### Task 9: Full test suite and diagnostics

**Files:** All modified files.

- [ ] Run the complete subagent test suite: `npx vitest run extensions/subagent/__tests__/`.
- [ ] Run lens diagnostics on all modified files and confirm no blocking errors.
- [ ] Manually verify: spawn an agent without `subagent_type`, confirm it uses `general-purpose` profile and Ornith model.
- [ ] Manually verify: set a short timeout (e.g. 15s), confirm the summarizer produces a summary on timeout.
- [ ] Commit as `chore(subagent): verify full test suite and diagnostics`.
