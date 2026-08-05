# Tavily Opt-in Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tavily as an opt-in search engine for `web_lookup` — it runs only when the model explicitly passes `engine: "tavily"` and never participates in the `"auto"` fallback chain.

**Architecture:** A new `TavilyEngine` mirrors the existing `ExaEngine` (same key-loading and result-mapping patterns). `search.ts` splits its registries: a private `chainEngines` array (`[Exa, DuckDuckGo]`) that `"auto"` walks, and the exported `searchEngines` full registry (`chain + Tavily`) used only for explicit engine selection via `resolveChain`. The tool schema gains the `"tavily"` literal; `webLookup` itself is unchanged.

**Tech Stack:** TypeScript (ESM, `.ts` with `allowImportingTsExtensions`), typebox 1.3.10 for the tool schema, vitest 2.1.9 for tests, pi extension runtime (jiti).

**Spec:** `docs/superpowers/specs/2026-08-05-tavily-optin-engine-design.md` (committed).

## Global Constraints

- Tavily must NEVER appear in the `"auto"` chain. `engine: "auto"` / `undefined` / unknown must resolve to exactly `["exa", "duckduckgo"]`.
- `search_depth: "advanced"` (hard requirement from the spec).
- `max_results` clamped to 1–20 (Tavily's cap; tool-level clamp stays 1–50 upstream).
- API key: `TAVILY_API_KEY`, env first then `.env` via `../../../.env` (same pattern as `EXA_API_KEY`).
- All files use tabs for indentation and double quotes (repo formatting — auto-formatter enforces this).
- Tests must stay deterministic: `vi.mock("node:fs")` at the top of the test file makes `.env` unreadable, so key-less behavior is testable by clearing `process.env`.
- Do NOT touch `extensions/loop/index.ts` (has unrelated uncommitted changes) or `examples/deep-research/` (out of scope).
- Working tree baseline: the engine-selection feature (engine param + fallback chain) from the prior session is present but uncommitted in `search.ts`, `index.ts`, `types.ts`, `types/typebox.d.ts`, `tests/web-search.test.ts`, `skills/web-search/SKILL.md`, `AGENTS.md`. Tasks build on top of it; commit only your own task's files.

---

## File Structure

| File | Responsibility | Action |
| ---- | -------------- | ------ |
| `extensions/web-search/types.ts` | `EngineChoice` union type | Modify (add `"tavily"`) |
| `extensions/web-search/engines/tavily.ts` | `TavilyEngine` — Tavily API client | Create |
| `extensions/web-search/search.ts` | Registry split (`chainEngines` + `searchEngines`), `resolveChain` | Modify |
| `extensions/web-search/index.ts` | Tool schema + description | Modify |
| `tests/web-search.test.ts` | Engine + chain + tool tests | Modify |
| `skills/web-search/SKILL.md` | User-facing engine docs | Modify (v2.2.0) |
| `AGENTS.md` | Architecture line | Modify |

---

### Task 1: TavilyEngine

**Files:**

- Modify: `extensions/web-search/types.ts:6` (`EngineChoice` line)
- Create: `extensions/web-search/engines/tavily.ts`
- Test: `tests/web-search.test.ts` (new `describe("TavilyEngine")` after the `DuckDuckGoEngine` describe)

**Interfaces:**

- Consumes: `SearchEngine` / `SearchResult` from `./types.ts` (already exists).
- Produces: `class TavilyEngine implements SearchEngine` with `name = "tavily"`, `isAvailable(): boolean`, `search(query, limit, signal): Promise<SearchResult[]>` — used by Task 2's registry.

- [ ] **Step 1: Add `"tavily"` to `EngineChoice`**

In `extensions/web-search/types.ts`, change line 6 from:

```typescript
export type EngineChoice = "auto" | "exa" | "duckduckgo";
```

to:

```typescript
export type EngineChoice = "auto" | "exa" | "duckduckgo" | "tavily";
```

Also update the doc comment above it (lines 1–5) to add a third bullet:

```typescript
/**
 * Engine selection for web_lookup:
 * - "auto": walk the fallback chain (Exa first, DuckDuckGo backup).
 * - "exa" / "duckduckgo": force a single engine, bypassing the chain.
 * - "tavily": opt-in engine for heavy deep research (advanced depth, needs TAVILY_API_KEY).
 */
```

- [ ] **Step 2: Write the failing TavilyEngine tests**

Append this block to `tests/web-search.test.ts` after the `DuckDuckGoEngine` describe (after line 187, `});` that closes it), plus add the import at the top of that section:

```typescript
import { TavilyEngine } from "../extensions/web-search/engines/tavily";

describe("TavilyEngine", () => {
 let engine: TavilyEngine;

 beforeEach(() => {
  engine = new TavilyEngine();
 });

 it("has correct name", () => {
  expect(engine.name).toBe("tavily");
 });

 it("isAvailable returns false when no API key", () => {
  const original = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  expect(engine.isAvailable()).toBe(false);
  if (original) process.env.TAVILY_API_KEY = original;
 });

 it("isAvailable returns true when API key exists", () => {
  process.env.TAVILY_API_KEY = "test-key";
  expect(engine.isAvailable()).toBe(true);
  delete process.env.TAVILY_API_KEY;
 });

 it("search returns empty results when no API key", async () => {
  const original = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  const results = await engine.search("test", 3);
  expect(results).toEqual([]);
  if (original) process.env.TAVILY_API_KEY = original;
 });

 it("clamps max_results to 1-20 and sends advanced depth", async () => {
  process.env.TAVILY_API_KEY = "test-key";
  const bodies: any[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_url: any, opts: any) => {
   bodies.push(JSON.parse(opts.body));
   return { ok: true, json: async () => ({ results: [] }) };
  };
  try {
   await engine.search("q", 500);
   await engine.search("q", 0);
   expect(bodies[0].max_results).toBe(20);
   expect(bodies[0].search_depth).toBe("advanced");
   expect(bodies[1].max_results).toBe(1);
  } finally {
   (globalThis as any).fetch = originalFetch;
   delete process.env.TAVILY_API_KEY;
  }
 });

 it("maps results with content as snippet", async () => {
  process.env.TAVILY_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({
   ok: true,
   json: async () => ({
    results: [
     {
      title: "T1",
      url: "https://example.com/1",
      content: "  snippet one  ",
     },
     {
      title: "T2",
      url: "https://example.com/2",
      content: "snippet two",
     },
     { url: "https://example.com/3" }, // no title/content
    ],
   }),
  });
  try {
   const results = await engine.search("q", 3);
   expect(results).toEqual([
    {
     title: "T1",
     url: "https://example.com/1",
     snippet: "snippet one",
     engine: "tavily",
    },
    {
     title: "T2",
     url: "https://example.com/2",
     snippet: "snippet two",
     engine: "tavily",
    },
    {
     title: "No title",
     url: "https://example.com/3",
     snippet: "",
     engine: "tavily",
    },
   ]);
  } finally {
   (globalThis as any).fetch = originalFetch;
   delete process.env.TAVILY_API_KEY;
  }
 });

 it("returns empty results on non-ok response", async () => {
  process.env.TAVILY_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({ ok: false, status: 429 });
  try {
   expect(await engine.search("q", 3)).toEqual([]);
  } finally {
   (globalThis as any).fetch = originalFetch;
   delete process.env.TAVILY_API_KEY;
  }
 });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx vitest run tests/web-search.test.ts -t TavilyEngine
```

Expected: FAIL — `Cannot find module '../extensions/web-search/engines/tavily'` (module does not exist yet).

- [ ] **Step 4: Write the minimal implementation**

Create `extensions/web-search/engines/tavily.ts` (exact content — mirrors `engines/exa.ts`):

```typescript
// extensions/web-search/engines/tavily.ts
import type { SearchEngine, SearchResult } from "../types.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadTavilyApiKey(): string | null {
 // Check env first
 if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY.trim();
 // Fall back to .env file
 try {
  const envPath = resolve(import.meta.dirname, "../../../.env");
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
   const m = line.match(/^TAVILY_API_KEY=(.+)$/);
   if (m) return m[1].trim();
  }
 } catch {
  /* .env may not exist */
 }
 return null;
}

export class TavilyEngine implements SearchEngine {
 name = "tavily";

 isAvailable(): boolean {
  return !!loadTavilyApiKey();
 }

 async search(
  query: string,
  limit: number,
  signal?: AbortSignal,
 ): Promise<SearchResult[]> {
  const apiKey = loadTavilyApiKey();
  if (!apiKey) return [];

  const response = await fetch("https://api.tavily.com/search", {
   method: "POST",
   headers: { "Content-Type": "application/json" },
   body: JSON.stringify({
    api_key: apiKey,
    query,
    search_depth: "advanced",
    max_results: Math.min(Math.max(limit, 1), 20),
   }),
   signal,
  });

  if (!response.ok) {
   return [];
  }

  const data = (await response.json()) as {
   results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const results: SearchResult[] = [];
  for (const item of data.results ?? []) {
   if (!item.url) continue;
   results.push({
    title: item.title || "No title",
    url: item.url,
    snippet: item.content?.trim().slice(0, 500) || "",
    engine: "tavily",
   });
  }
  return results;
 }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx vitest run tests/web-search.test.ts -t TavilyEngine
```

Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add extensions/web-search/types.ts extensions/web-search/engines/tavily.ts tests/web-search.test.ts
git commit -m "feat: add opt-in TavilyEngine (advanced depth, TAVILY_API_KEY)"
```

---

### Task 2: Registry split + chain tests

**Files:**

- Modify: `extensions/web-search/search.ts` (registry section, lines 1–37)
- Test: `tests/web-search.test.ts` ("search composition" describe)

**Interfaces:**

- Consumes: `TavilyEngine` from Task 1; existing `ExaEngine`/`DuckDuckGoEngine`.
- Produces: `chainEngines` (module-private `SearchEngine[]`), `searchEngines` (exported `SearchEngine[]`, full registry), `resolveChain(engine?: EngineChoice): SearchEngine[]` — same exported names as today, so `webLookup` (lines 39–84) is untouched.

- [ ] **Step 1: Write the failing registry/chain tests**

In `tests/web-search.test.ts`, update the `"search composition"` describe:

Replace the test at lines 196–199:

```typescript
 it("registers both engines with exa first (default chain)", () => {
  const names = searchEngines.map((e) => e.name);
  expect(names).toEqual(["exa", "duckduckgo"]);
 });
```

with:

```typescript
 it("full registry lists chain engines first, then opt-in tavily", () => {
  const names = searchEngines.map((e) => e.name);
  expect(names).toEqual(["exa", "duckduckgo", "tavily"]);
 });
```

Add `tavily` to the "forces a single engine" test (lines 214–219), after the `duckduckgo` line:

```typescript
  it("forces a single engine", () => {
   expect(resolveChain("exa").map((e) => e.name)).toEqual(["exa"]);
   expect(resolveChain("duckduckgo").map((e) => e.name)).toEqual([
    "duckduckgo",
   ]);
   expect(resolveChain("tavily").map((e) => e.name)).toEqual([
    "tavily",
   ]);
  });
```

Add a test after "degrades unknown choices to the default chain" (after line 226) proving the auto chain excludes Tavily:

```typescript
  it("auto chain never includes opt-in engines", () => {
   expect(resolveChain().map((e) => e.name)).toEqual([
    "exa",
    "duckduckgo",
   ]);
   expect(resolveChain("auto").map((e) => e.name)).toEqual([
    "exa",
    "duckduckgo",
   ]);
  });
```

In the `"webLookup chain behavior"` describe, extend the env cleanup to also clear the Tavily key. Replace lines 232–238:

```typescript
  const originalKey = process.env.EXA_API_KEY;
  beforeEach(() => {
   delete process.env.EXA_API_KEY;
  });
  afterEach(() => {
   if (originalKey) process.env.EXA_API_KEY = originalKey;
  });
```

with:

```typescript
  const originalKey = process.env.EXA_API_KEY;
  const originalTavilyKey = process.env.TAVILY_API_KEY;
  beforeEach(() => {
   delete process.env.EXA_API_KEY;
   delete process.env.TAVILY_API_KEY;
  });
  afterEach(() => {
   if (originalKey) process.env.EXA_API_KEY = originalKey;
   if (originalTavilyKey) process.env.TAVILY_API_KEY = originalTavilyKey;
  });
```

Add a forced-tavily-no-key test at the end of the `"webLookup chain behavior"` describe (after the "forced exa with no key" test, before its closing `});`):

```typescript
  it("forced tavily with no key returns no results and reports the skip", async () => {
   const result = await webLookup(
    "rust programming language",
    3,
    undefined,
    "tavily",
   );
   expect(result.results).toEqual([]);
   expect(result.engines).toEqual([]);
   expect(
    result.partialFailures.some((pf) => pf.engine === "tavily"),
   ).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx vitest run tests/web-search.test.ts -t "search composition"
```

Expected: FAIL — the "full registry" test gets `["exa", "duckduckgo"]` instead of 3 entries; `resolveChain("tavily")` returns the chain instead of `["tavily"]`.

- [ ] **Step 3: Split the registries in search.ts**

Replace the registry block in `extensions/web-search/search.ts` (lines 1–19: imports, doc comment, and `searchEngines` array) with:

```typescript
// extensions/web-search/search.ts
import type {
 EngineChoice,
 SearchEngine,
 SearchResponse,
 SearchResult,
} from "./types.ts";
import { ExaEngine } from "./engines/exa.ts";
import { DuckDuckGoEngine } from "./engines/duckduckgo.ts";
import { TavilyEngine } from "./engines/tavily.ts";

/**
 * Fallback chain walked by engine: "auto" — Exa default, DuckDuckGo backup.
 * Engines here run in order until one returns results.
 */
const chainEngines: SearchEngine[] = [
 new ExaEngine(),
 new DuckDuckGoEngine(),
];

/**
 * Every available engine. Engines NOT in chainEngines are opt-in only:
 * they run solely when the model passes engine: "<name>" explicitly.
 */
export const searchEngines: SearchEngine[] = [
 ...chainEngines,
 new TavilyEngine(),
];
```

Then update `resolveChain` (lines 32–37) to resolve from the chain vs full registry:

```typescript
export function resolveChain(engine?: EngineChoice): SearchEngine[] {
 if (!engine || engine === "auto") return chainEngines;
 const match = searchEngines.find((e) => e.name === engine);
 // Unknown choices (e.g. a future engine name) degrade to the default chain.
 return match ? [match] : chainEngines;
}
```

`dedupeResults` and `webLookup` stay exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx vitest run tests/web-search.test.ts
```

Expected: PASS (all tests, including the new registry/chain/tavily ones).

- [ ] **Step 5: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add extensions/web-search/search.ts tests/web-search.test.ts
git commit -m "feat: split chain and full engine registries; tavily opt-in only"
```

---

### Task 3: Tool schema + description

**Files:**

- Modify: `extensions/web-search/index.ts` (engine union at lines 55–68, description at lines 43–46)

**Interfaces:**

- Consumes: nothing new from Tasks 1–2 (schema only).
- Produces: `web_lookup` tool accepting `engine: "tavily"` at runtime; description advertises it.

- [ ] **Step 1: Write the failing schema test**

In `tests/web-search.test.ts`, inside the `"extension tools"` describe, after the existing `"web_lookup returns SearchResponse shape"` test, add:

```typescript
 it("web_lookup schema advertises the tavily engine", async () => {
  const results: any[] = [];
  const mockPi = {
   registerTool: (tool: any) => results.push(tool),
  };
  createExtension(mockPi as any);
  const lookupTool = results.find((t: any) => t.name === "web_lookup");
  expect(JSON.stringify(lookupTool.parameters)).toContain("tavily");
 });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx vitest run tests/web-search.test.ts -t "advertises the tavily"
```

Expected: FAIL — schema JSON does not contain `"tavily"`.

- [ ] **Step 3: Add the literal to the schema and update descriptions**

In `extensions/web-search/index.ts`, add the `tavily` literal to the union (after line 60, `Type.Literal("duckduckgo"),`):

```typescript
      Type.Literal("tavily"),
```

Update the union description (lines 63–65) to:

```typescript
     {
      description:
       "Engine to use: 'auto' (default) walks the fallback chain — Exa first, DuckDuckGo as backup. " +
       "'exa' or 'duckduckgo' force a single engine; 'tavily' runs Tavily alone (advanced depth, requires TAVILY_API_KEY) for heavy research.",
     },
```

Update the tool description (lines 43–46) to:

```typescript
  description:
   "Search the web. Uses Exa by default, falling back to DuckDuckGo if Exa is unavailable or returns nothing. " +
   "Pass engine to force a specific engine ('tavily' for heavy deep research — runs alone, needs TAVILY_API_KEY). " +
   "Returns search results with title, URL, and snippet. " +
   "Use for finding documentation, facts, code examples, or discovering relevant pages.",
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx vitest run tests/web-search.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add extensions/web-search/index.ts tests/web-search.test.ts
git commit -m "feat: expose tavily engine in web_lookup schema"
```

---

### Task 4: Docs

**Files:**

- Modify: `skills/web-search/SKILL.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: the finalized behavior from Tasks 1–3.
- Produces: nothing code-related.

- [ ] **Step 1: Update SKILL.md to v2.2.0**

In `skills/web-search/SKILL.md`:

1. Bump the frontmatter version (line 4) `version: 2.1.0` → `version: 2.2.0`.
2. In `## Engine Selection` (after the DuckDuckGo bullet, ~line 32), add an opt-in subsection:

```markdown
### Opt-in engines (not in the chain)

Engines listed here never run in the `"auto"` chain. They execute only when explicitly requested via `engine: "<name>"`:

- **Tavily** — advanced-depth crawl, good for heavy deep research. Requires `TAVILY_API_KEY` in `.env`. `engine: "tavily"` runs it alone (no fallback); without a key it is skipped and reported in `partialFailures`.
```

1. In the `engine` parameter bullet (~line 56), change:

```markdown
- `engine` (optional): `"auto"` (default) | `"exa"` | `"duckduckgo"` — see Engine Selection
```

to:

```markdown
- `engine` (optional): `"auto"` (default) | `"exa"` | `"duckduckgo"` | `"tavily"` (opt-in) — see Engine Selection
```

- [ ] **Step 2: Update AGENTS.md architecture line**

In `AGENTS.md`, the `search.ts` bullet (~line 43). Replace the current sentence with:

```markdown
- `extensions/web-search/search.ts` — `webLookup()` walks an ordered fallback chain (`resolveChain`): the first engine that returns results wins. `chainEngines` (Exa default, DuckDuckGo backup) is what `engine: "auto"` walks; the exported `searchEngines` registry adds opt-in engines (Tavily) that run only when explicitly selected. Tracks `partialFailures` for unavailable/empty/errored engines so the agent sees why a backup was used.
```

- [ ] **Step 3: Verify docs render**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
grep -n "2.2.0\|tavily\|Tavily" skills/web-search/SKILL.md AGENTS.md
```

Expected: version bump visible; `tavily`/`Tavily` present in both files.

- [ ] **Step 4: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add skills/web-search/SKILL.md AGENTS.md
git commit -m "docs: document opt-in tavily engine (skill v2.2.0, AGENTS.md)"
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx vitest run tests/web-search.test.ts
```

Expected: ALL tests PASS (the count should be the previous 33 plus the new TavilyEngine/registry/schema tests — ~44 total).

- [ ] **Step 2: Typecheck**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "linkedom\|readability"
```

Expected: no output (the only pre-existing errors are in the untouched `readability.ts` / `linkedom` typings — they must be filtered out and are not caused by this work).

- [ ] **Step 3: Runtime smoke test of the tool**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
node --experimental-strip-types -e "
import createExtension from './extensions/web-search/index.ts';
let tool;
createExtension({ registerTool: (t) => { if (t.name === 'web_lookup') tool = t; } });
const res = await tool.execute('id', { query: 'rust async runtime', limit: 2 });
console.log('engines:', JSON.stringify(res.details.engines));
console.log('partialFailures:', JSON.stringify(res.details.partialFailures));
const res2 = await tool.execute('id', { query: 'rust async runtime', limit: 2, engine: 'tavily' });
console.log('forced tavily engines:', JSON.stringify(res2.details.engines));
console.log('forced tavily partialFailures:', JSON.stringify(res2.details.partialFailures));
"
```

Expected:

- First call: `engines: ["exa"]` (or `["duckduckgo"]` if no Exa key on the machine) — Tavily absent either way.
- Second call: `engines: []` with a `tavily` "engine not available" entry in `partialFailures` (unless a real `TAVILY_API_KEY` is present, in which case it hits the live API).

- [ ] **Step 4: LSP diagnostics clean**

Check that the touched files have no new LSP errors (expect at most the pre-existing `params: any` hints in `index.ts`).

- [ ] **Step 5: Final commit if anything changed**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git status --short
git log --oneline -5
```

Expected: working tree contains only the unrelated pre-existing changes (`extensions/loop/index.ts`, `examples/deep-research/docs/`); the four feature commits from Tasks 1–4 are on top of `docs: add Tavily opt-in engine design spec`.

---

## Self-Review

**1. Spec coverage:**

- "Tavily never in the auto chain" → Task 2 (registry split + `auto chain never includes opt-in engines` test). ✓
- "`search_depth: advanced`" → Task 1 Step 4 body + Step 2 clamp/depth test. ✓
- "max_results 1–20" → Task 1 test + implementation clamp. ✓
- "TAVILY_API_KEY env then .env" → Task 1 implementation + isAvailable tests. ✓
- "EngineChoice gains tavily" → Task 1 Step 1. ✓
- "Type.Literal('tavily') + description" → Task 3. ✓
- "SKILL.md 2.2.0 + AGENTS.md" → Task 4. ✓
- "Tests: registry 3 entries, chain 2, resolveChain('tavily'), forced no-key, default never touches tavily" → Task 2. ✓
- "Out of scope: /research loop" → Global Constraints (do not touch). ✓

**2. Placeholder scan:** No TBD/TODO; every step has exact code or commands. ✓

**3. Type consistency:** `TavilyEngine` implements the same `SearchEngine` interface (`name`, `isAvailable`, `search(query, limit, signal)`), same signature as `ExaEngine`/`DuckDuckGoEngine`. `resolveChain` keeps its exact exported signature `(engine?: EngineChoice) => SearchEngine[]`, so `webLookup` needs zero changes. Registry names: `chainEngines` (private), `searchEngines` (exported) — used consistently across Tasks 2–3 and tests. ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-05-tavily-optin-engine.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
