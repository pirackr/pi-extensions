# Opt-In ntfy Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a session-local, default-off `/ntfy on|off|test` Pi extension that posts a project-aware notification when an agent run fully settles.

**Architecture:** Keep strict layered configuration, HTTP publishing, and Pi lifecycle wiring in three focused modules. The extension owns only two booleans (`enabled`, `pendingRun`), reloads configuration and resets both flags on every `session_start`, and delegates all network behavior to an injected, independently tested publisher.

**Tech Stack:** TypeScript ES modules loaded by Pi/jiti, Node native `fetch` and `AbortController`, Pi extension lifecycle APIs, Vitest.

## Global Constraints

- Completion notification title is exactly `Pi · <project-basename>` and body is exactly `Task finished`.
- Notifications are off at every session start and are never persisted.
- `/ntfy test` publishes regardless of session on/off state.
- Configuration precedence is packaged defaults, then `$PI_AGENT_DIR/ntfy/config.json`, then environment variables.
- Supported environment variables are `NTFY_SERVER`, `NTFY_TOPIC`, and `NTFY_TOKEN`.
- No project-local configuration is read.
- The default server is `https://ntfy.sh`; no topic or token is committed.
- Network requests time out after exactly five seconds.
- Never transmit prompt, response, file, transcript, or token data in status/error text.
- No new runtime dependency is permitted.

## File Structure

- Create `config/ntfy.json`: packaged server default only.
- Create `extensions/ntfy/config.ts`: strict config validation, layered loading, URL resolution, and redacted diagnostics.
- Create `extensions/ntfy/client.ts`: native-fetch ntfy POST with timeout, title, optional bearer authentication, and non-2xx handling.
- Create `extensions/ntfy/index.ts`: session-local state, lifecycle handlers, `/ntfy` command, project-aware payload, and UI warnings.
- Create `tests/ntfy-config.test.ts`: configuration precedence, validation, URL construction, and secret-redaction coverage.
- Create `tests/ntfy-client.test.ts`: request shape, authentication, HTTP/network failure, and timeout coverage.
- Create `tests/ntfy-extension.test.ts`: lifecycle deduplication, session reset, command behavior, payload privacy, and UI warning coverage.
- Modify `README.md`: user configuration, environment variables, command behavior, and privacy contract.

---

### Task 1: Layered ntfy Configuration

**Files:**

- Create: `config/ntfy.json`
- Create: `extensions/ntfy/config.ts`
- Test: `tests/ntfy-config.test.ts`

**Interfaces:**

- Produces: `NtfyConfiguration { server: string; topic?: string; token?: string }`.
- Produces: `LoadedNtfyConfiguration { config: NtfyConfiguration; userConfigPath: string; warnings: string[] }`.
- Produces: `loadNtfyConfiguration(options: LoadNtfyConfigurationOptions): LoadedNtfyConfiguration`.
- Produces: `resolveTopicUrl(config: NtfyConfiguration): string | null` for Task 2.

- [ ] **Step 1: Write packaged defaults and failing configuration tests**

Create `config/ntfy.json`:

```json
{
  "server": "https://ntfy.sh"
}
```

Create `tests/ntfy-config.test.ts` with table-driven coverage and mocked filesystem reads:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Fs from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn() };
});

import { readFileSync } from "node:fs";
import {
  loadNtfyConfiguration,
  resolveTopicUrl,
} from "../extensions/ntfy/config.ts";

const readFile = vi.mocked(readFileSync);
const options = {
  packageRoot: "/pkg",
  agentDir: "/agent",
  env: {} as NodeJS.ProcessEnv,
};

function files(contents: Record<string, string>): void {
  readFile.mockImplementation((input: Fs.PathOrFileDescriptor) => {
    const file = String(input);
    if (file in contents) return contents[file];
    const error = new Error("missing") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  });
}

beforeEach(() => readFile.mockReset());

describe("loadNtfyConfiguration", () => {
  it("loads the packaged default without inventing a topic or token", () => {
    files({ "/pkg/config/ntfy.json": JSON.stringify({ server: "https://ntfy.sh" }) });
    expect(loadNtfyConfiguration(options)).toMatchObject({
      config: { server: "https://ntfy.sh" },
      userConfigPath: "/agent/ntfy/config.json",
      warnings: [],
    });
  });

  it("applies user fields and then per-field environment overrides", () => {
    files({
      "/pkg/config/ntfy.json": JSON.stringify({ server: "https://ntfy.sh" }),
      "/agent/ntfy/config.json": JSON.stringify({
        server: "https://user.example",
        topic: "user-topic",
        token: "user-credential",
      }),
    });
    const result = loadNtfyConfiguration({
      ...options,
      env: {
        NTFY_SERVER: "https://env.example/",
        NTFY_TOPIC: "env-topic",
        NTFY_TOKEN: "env-credential",
      },
    });
    expect(result.config).toEqual({
      server: "https://env.example",
      topic: "env-topic",
      token: "env-credential",
    });
  });

  it.each([
    [{ server: 42 }, "server"],
    [{ topic: "" }, "topic"],
    [{ token: false }, "token"],
    [{ server: "https://valid.example", extra: true }, "extra"],
  ])("ignores an invalid user file atomically: %j", (userConfig, field) => {
    files({
      "/pkg/config/ntfy.json": JSON.stringify({ server: "https://ntfy.sh" }),
      "/agent/ntfy/config.json": JSON.stringify(userConfig),
    });
    const result = loadNtfyConfiguration(options);
    expect(result.config).toEqual({ server: "https://ntfy.sh" });
    expect(result.warnings.join("\n")).toContain(String(field));
  });

  it("keeps lower-precedence values when an environment URL is invalid", () => {
    files({
      "/pkg/config/ntfy.json": JSON.stringify({ server: "https://ntfy.sh" }),
      "/agent/ntfy/config.json": JSON.stringify({ topic: "alerts" }),
    });
    const result = loadNtfyConfiguration({
      ...options,
      env: { NTFY_SERVER: "file:///tmp/leak" },
    });
    expect(result.config).toEqual({ server: "https://ntfy.sh", topic: "alerts" });
    expect(result.warnings.join("\n")).toContain("NTFY_SERVER");
  });

  it("never includes a rejected token value in warnings", () => {
    files({
      "/pkg/config/ntfy.json": JSON.stringify({ server: "https://ntfy.sh" }),
      "/agent/ntfy/config.json": JSON.stringify({ token: 12345 }),
    });
    const result = loadNtfyConfiguration(options);
    expect(result.warnings.join("\n")).not.toContain("12345");
  });
});

describe("resolveTopicUrl", () => {
  it.each([
    [{ server: "https://ntfy.sh", topic: "pi-alerts" }, "https://ntfy.sh/pi-alerts"],
    [{ server: "https://ntfy.sh/", topic: "/pi-alerts" }, "https://ntfy.sh/pi-alerts"],
    [{ server: "https://ignored.example", topic: "https://push.example/team/pi" }, "https://push.example/team/pi"],
  ])("resolves %j", (config, expected) => {
    expect(resolveTopicUrl(config)).toBe(expected);
  });

  it("returns null without a topic", () => {
    expect(resolveTopicUrl({ server: "https://ntfy.sh" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail because the module is absent**

Run: `npx vitest run tests/ntfy-config.test.ts`

Expected: FAIL with an import error for `extensions/ntfy/config.ts`.

- [ ] **Step 3: Implement strict layered configuration and URL resolution**

Create `extensions/ntfy/config.ts` with these exact public types and behavior:

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface NtfyConfiguration {
  server: string;
  topic?: string;
  token?: string;
}

export interface LoadedNtfyConfiguration {
  config: NtfyConfiguration;
  userConfigPath: string;
  warnings: string[];
}

export interface LoadNtfyConfigurationOptions {
  packageRoot: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}

const FIELDS = new Set(["server", "topic", "token"]);

function normalizeServer(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function validateLayer(raw: unknown, source: string): { value: Partial<NtfyConfiguration> | null; warning?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: null, warning: `Ignored invalid ${source}: root must be an object.` };
  }
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!FIELDS.has(key)) return { value: null, warning: `Ignored invalid ${source}: unknown field '${key}'.` };
  }
  for (const key of FIELDS) {
    if (key in object && (typeof object[key] !== "string" || object[key] === "")) {
      return { value: null, warning: `Ignored invalid ${source}: '${key}' must be a non-empty string.` };
    }
  }
  if (typeof object.server === "string" && normalizeServer(object.server) === null) {
    return { value: null, warning: `Ignored invalid ${source}: 'server' must be an HTTP(S) URL.` };
  }
  return { value: object as Partial<NtfyConfiguration> };
}
```

Complete `loadNtfyConfiguration` so the packaged file is mandatory and valid, the missing user file is silently skipped, malformed/invalid user config is atomically ignored with a warning, and each non-empty environment variable overrides only its corresponding field after validation. Normalize server URLs at assignment. Never interpolate rejected values into warnings.

Implement `resolveTopicUrl` by returning `null` for an absent topic, accepting only HTTP(S) absolute topic URLs, and otherwise resolving the topic (after removing leading slashes) against `${server}/`. Reject a full URL with a non-HTTP(S) protocol by returning `null` rather than treating it as a topic name.

- [ ] **Step 4: Run focused tests and diagnostics**

Run: `npx vitest run tests/ntfy-config.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no new TypeScript errors in `extensions/ntfy/config.ts` or `tests/ntfy-config.test.ts`.

- [ ] **Step 5: Commit the configuration unit**

```bash
git add config/ntfy.json extensions/ntfy/config.ts tests/ntfy-config.test.ts
git commit -m "feat: add layered ntfy configuration"
```

---

### Task 2: Native HTTP Publisher

**Files:**

- Create: `extensions/ntfy/client.ts`
- Test: `tests/ntfy-client.test.ts`

**Interfaces:**

- Consumes: `NtfyConfiguration` and `resolveTopicUrl(config)` from Task 1.
- Produces: `NtfyMessage { title: string; body: string }`.
- Produces: `publishNtfy(config, message, options?): Promise<void>` where options can inject `fetch` and `timeoutMs` for deterministic tests.

- [ ] **Step 1: Write failing request, failure, and timeout tests**

Create `tests/ntfy-client.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishNtfy } from "../extensions/ntfy/client.ts";

const config = { server: "https://ntfy.sh", topic: "pi-alerts" };

afterEach(() => vi.useRealTimers());

describe("publishNtfy", () => {
  it("posts the body, title, and optional bearer token", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const credential = ["test", "credential"].join("-");
    await publishNtfy(
      { ...config, token: credential },
      { title: "Pi · grinder", body: "Task finished" },
      { fetch },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://ntfy.sh/pi-alerts",
      expect.objectContaining({
        method: "POST",
        body: "Task finished",
        headers: {
          Title: "Pi · grinder",
          Authorization: `Bearer ${credential}`,
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("omits Authorization when no token is configured", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 204 }));
    await publishNtfy(config, { title: "Pi · grinder", body: "Task finished" }, { fetch });
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ Title: "Pi · grinder" });
  });

  it("rejects missing topic before calling fetch", async () => {
    const fetch = vi.fn();
    await expect(
      publishNtfy({ server: "https://ntfy.sh" }, { title: "Pi", body: "test" }, { fetch }),
    ).rejects.toThrow("topic is not configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-success responses without reading response content", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("sensitive upstream body", { status: 403 }));
    await expect(
      publishNtfy(config, { title: "Pi", body: "test" }, { fetch }),
    ).rejects.toThrow("HTTP 403");
  });

  it("aborts after the configured timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = publishNtfy(config, { title: "Pi", body: "test" }, { fetch, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).rejects.toThrow("timed out");
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run: `npx vitest run tests/ntfy-client.test.ts`

Expected: FAIL with an import error for `extensions/ntfy/client.ts`.

- [ ] **Step 3: Implement the minimal publisher**

Create `extensions/ntfy/client.ts`:

```typescript
import type { NtfyConfiguration } from "./config.ts";
import { resolveTopicUrl } from "./config.ts";

export interface NtfyMessage {
  title: string;
  body: string;
}

export interface PublishNtfyOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export async function publishNtfy(
  config: NtfyConfiguration,
  message: NtfyMessage,
  options: PublishNtfyOptions = {},
): Promise<void> {
  const url = resolveTopicUrl(config);
  if (!url) throw new Error("ntfy topic is not configured or valid");

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { Title: message.title };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      body: message.body,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ntfy request failed with HTTP ${response.status}`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`ntfy request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

Do not include response bodies, request headers, topic values, or tokens in thrown errors.

- [ ] **Step 4: Run focused tests and diagnostics**

Run: `npx vitest run tests/ntfy-client.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no new TypeScript errors in the publisher or its tests.

- [ ] **Step 5: Commit the publishing unit**

```bash
git add extensions/ntfy/client.ts tests/ntfy-client.test.ts
git commit -m "feat: add ntfy HTTP publisher"
```

---

### Task 3: Pi Lifecycle and `/ntfy` Command

**Files:**

- Create: `extensions/ntfy/index.ts`
- Test: `tests/ntfy-extension.test.ts`

**Interfaces:**

- Consumes: `loadNtfyConfiguration`, `LoadedNtfyConfiguration`, and `resolveTopicUrl` from Task 1.
- Consumes: `publishNtfy(config, message)` from Task 2.
- Produces: default Pi extension factory.
- Produces for tests: `createNtfyExtension(pi, dependencies?)`, with injected loader, publisher, package root, and agent directory.

- [ ] **Step 1: Write failing registration, lifecycle, and command tests**

Create `tests/ntfy-extension.test.ts`. Use a fake Pi API that records `on` and `registerCommand`, and inject configuration/publishing functions rather than mocking global fetch:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNtfyExtension } from "../extensions/ntfy/index.ts";

function fakePi() {
  return { on: vi.fn(), registerCommand: vi.fn() };
}

function handler(pi: ReturnType<typeof fakePi>, event: string) {
  return pi.on.mock.calls.find(([name]) => name === event)?.[1] as (event: unknown, ctx: any) => Promise<void> | void;
}

function command(pi: ReturnType<typeof fakePi>) {
  return pi.registerCommand.mock.calls.find(([name]) => name === "ntfy")?.[1].handler as (args: string, ctx: any) => Promise<void>;
}

function context(cwd = "/work/grinder") {
  return { cwd, hasUI: true, ui: { notify: vi.fn() } };
}

const loaded = {
  config: { server: "https://ntfy.sh", topic: "pi-alerts" },
  userConfigPath: "/agent/ntfy/config.json",
  warnings: [],
};

function setup(config = loaded) {
  const pi = fakePi();
  const publish = vi.fn().mockResolvedValue(undefined);
  const loadConfiguration = vi.fn().mockReturnValue(config);
  createNtfyExtension(pi as any, {
    packageRoot: "/pkg",
    agentDir: "/agent",
    loadConfiguration,
    publish,
  });
  return { pi, publish, loadConfiguration };
}

beforeEach(() => vi.clearAllMocks());

describe("registration and reset", () => {
  it("registers session_start, agent_start, agent_settled, and /ntfy", () => {
    const { pi } = setup();
    expect(pi.on.mock.calls.map(([name]) => name)).toEqual([
      "session_start",
      "agent_start",
      "agent_settled",
    ]);
    expect(pi.registerCommand).toHaveBeenCalledWith("ntfy", expect.any(Object));
  });

  it.each(["startup", "reload", "new", "resume", "fork"])(
    "resets enabled and pending state on %s",
    async (reason) => {
      const { pi, publish } = setup();
      const ctx = context();
      handler(pi, "session_start")({ reason: "startup" }, ctx);
      await command(pi)("on", ctx);
      handler(pi, "agent_start")({}, ctx);
      handler(pi, "session_start")({ reason }, ctx);
      await handler(pi, "agent_settled")({}, ctx);
      expect(publish).not.toHaveBeenCalled();
    },
  );
});

describe("completion delivery", () => {
  it("sends one fixed, project-aware message for a started and settled run", async () => {
    const { pi, publish } = setup();
    const ctx = context("/work/grinder");
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    handler(pi, "agent_start")({}, ctx);
    await handler(pi, "agent_settled")({}, ctx);
    await handler(pi, "agent_settled")({}, ctx);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      loaded.config,
      { title: "Pi · grinder", body: "Task finished" },
    );
  });

  it("does not publish while off or without a preceding agent_start", async () => {
    const { pi, publish } = setup();
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    handler(pi, "agent_start")({}, ctx);
    await handler(pi, "agent_settled")({}, ctx);
    await command(pi)("on", ctx);
    await handler(pi, "agent_settled")({}, ctx);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("/ntfy", () => {
  it("reports off by default without exposing the token", async () => {
    const authenticatedConfig = {
      ...loaded,
      config: { ...loaded.config, token: ["hidden", "credential"].join("-") },
    };
    const { pi } = setup(authenticatedConfig);
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("", ctx);
    const report = ctx.ui.notify.mock.calls[0][0] as string;
    expect(report).toContain("Notifications: off");
    expect(report).toContain("Authentication: enabled");
    expect(report).not.toContain("hidden-credential");
  });

  it("supports on and off", async () => {
    const { pi } = setup();
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("ntfy notifications enabled for this session", "info");
    await command(pi)("off", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("ntfy notifications disabled", "info");
  });

  it("refuses to enable without a topic", async () => {
    const { pi } = setup({ ...loaded, config: { server: "https://ntfy.sh" } });
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("topic"), "warning");
  });

  it("sends a test while off", async () => {
    const { pi, publish } = setup();
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("test", ctx);
    expect(publish).toHaveBeenCalledWith(
      loaded.config,
      { title: "Pi · grinder", body: "ntfy test notification" },
    );
  });

  it("shows usage for unknown arguments", async () => {
    const { pi } = setup();
    const ctx = context();
    await command(pi)("sometimes", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /ntfy [on|off|test]", "warning");
  });
});

describe("safe failures", () => {
  it("warns on publishing failure without rejecting the settled handler", async () => {
    const { pi, publish } = setup();
    publish.mockRejectedValue(new Error("ntfy request failed with HTTP 500"));
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    handler(pi, "agent_start")({}, ctx);
    await expect(handler(pi, "agent_settled")({}, ctx)).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("ntfy notification failed: ntfy request failed with HTTP 500", "warning");
  });
});
```

Add a second failure assertion for `/ntfy test`, and one `hasUI: false` assertion proving warning/report helpers do not call `ctx.ui.notify` in print/JSON modes.

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run: `npx vitest run tests/ntfy-extension.test.ts`

Expected: FAIL with an import error for `extensions/ntfy/index.ts`.

- [ ] **Step 3: Implement lifecycle state and commands**

Create `extensions/ntfy/index.ts` with dependency injection at the factory boundary:

```typescript
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadNtfyConfiguration,
  resolveTopicUrl,
  type LoadedNtfyConfiguration,
} from "./config.ts";
import { publishNtfy, type NtfyMessage } from "./client.ts";

const defaultPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface NtfyDependencies {
  packageRoot?: string;
  agentDir?: string;
  loadConfiguration?: typeof loadNtfyConfiguration;
  publish?: (config: LoadedNtfyConfiguration["config"], message: NtfyMessage) => Promise<void>;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    // Session replacement or reload can stale an asynchronous context.
  }
}

function projectTitle(cwd: string): string {
  return `Pi · ${path.basename(path.resolve(cwd)) || "task"}`;
}

export function createNtfyExtension(pi: ExtensionAPI, dependencies: NtfyDependencies = {}): void {
  const loadConfiguration = dependencies.loadConfiguration ?? loadNtfyConfiguration;
  const publish = dependencies.publish ?? publishNtfy;
  let loaded: LoadedNtfyConfiguration | null = null;
  let enabled = false;
  let pendingRun = false;

  pi.on("session_start", (_event, ctx) => {
    enabled = false;
    pendingRun = false;
    try {
      loaded = loadConfiguration({
        packageRoot: dependencies.packageRoot ?? defaultPackageRoot,
        agentDir: dependencies.agentDir ?? getAgentDir(),
        env: process.env,
      });
    } catch (error) {
      loaded = null;
      notify(ctx, `ntfy configuration failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("agent_start", () => {
    pendingRun = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingRun) return;
    pendingRun = false;
    if (!enabled || !loaded) return;
    try {
      await publish(loaded.config, { title: projectTitle(ctx.cwd), body: "Task finished" });
    } catch (error) {
      notify(ctx, `ntfy notification failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
```

Complete the factory with `pi.registerCommand("ntfy", ...)`. Normalize command arguments with `args.trim().toLowerCase()` and implement:

- empty argument: status lines for on/off, resolved server/topic URL or `not configured`, authentication enabled/disabled, user config path, and each redacted config warning;
- `on`: require both `loaded` and `resolveTopicUrl(loaded.config)`, then set `enabled = true` and notify success;
- `off`: set `enabled = false` and notify success;
- `test`: require valid configuration, publish `{ title: projectTitle(ctx.cwd), body: "ntfy test notification" }`, then notify success; catch and warn exactly as the settled handler does;
- any other argument: warning `Usage: /ntfy [on|off|test]`.

Finish with:

```typescript
export default function ntfyExtension(pi: ExtensionAPI): void {
  createNtfyExtension(pi);
}
```

Do not use `pi.sendMessage`; command output and failures must stay out of model context.

- [ ] **Step 4: Run focused lifecycle tests and diagnostics**

Run: `npx vitest run tests/ntfy-extension.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no new TypeScript errors in the extension or tests.

- [ ] **Step 5: Commit the Pi integration unit**

```bash
git add extensions/ntfy/index.ts tests/ntfy-extension.test.ts
git commit -m "feat: add opt-in ntfy completion notifications"
```

---

### Task 4: User Documentation and End-to-End Verification

**Files:**

- Modify: `README.md`

**Interfaces:**

- Consumes: final command names, paths, defaults, and privacy behavior from Tasks 1–3.
- Produces: install-time documentation sufficient to configure and use the extension without reading source.

- [ ] **Step 1: Add an ntfy section to README**

Insert a `## ntfy Notifications` section before `## Add a New Extension` containing:

~~~~markdown
## ntfy Notifications

The ntfy extension sends a notification after Pi fully settles following a prompt. It is session-local and disabled by default.

Configure a topic in `$PI_AGENT_DIR/ntfy/config.json` (normally `~/.pi/agent/ntfy/config.json`):

```json
{
  "server": "https://ntfy.sh",
  "topic": "your-private-topic",
  "token": "optional-access-token"
}
```

Environment variables override file settings: `NTFY_SERVER`, `NTFY_TOPIC`, and `NTFY_TOKEN`. `NTFY_TOPIC` may be either a topic name or a full HTTP(S) topic URL. No project-local configuration is read.

Commands:

- `/ntfy` — show status without exposing the token.
- `/ntfy on` — enable completion notifications for the current session.
- `/ntfy off` — disable completion notifications.
- `/ntfy test` — send a test notification even while notifications are off.

Every new, resumed, forked, or reloaded session starts with notifications off. Completion messages contain only `Pi · <project>` and `Task finished`; prompts, responses, files, and transcripts are never sent.
~~~~

- [ ] **Step 2: Run all ntfy tests together**

Run:

```bash
npx vitest run tests/ntfy-config.test.ts tests/ntfy-client.test.ts tests/ntfy-extension.test.ts
```

Expected: all ntfy tests PASS and no test contacts an external server.

- [ ] **Step 3: Run proactive diagnostics and the complete test suite**

Run: `npx tsc --noEmit`

Expected: no TypeScript errors attributable to the ntfy files.

Run: `npm test`

Expected: complete Vitest suite PASS.

- [ ] **Step 4: Smoke-load the package extension**

Run:

```bash
pi -e ./extensions/ntfy/index.ts --list-models >/dev/null
```

Expected: Pi exits successfully after loading the extension; no notification is sent because no session command enabled it.

- [ ] **Step 5: Review the final diff for privacy and scope**

Run:

```bash
git diff --check
git diff -- config/ntfy.json extensions/ntfy tests/ntfy-config.test.ts tests/ntfy-client.test.ts tests/ntfy-extension.test.ts README.md
```

Confirm the diff contains no real topic, token, prompt forwarding, response forwarding, project config read, persistence write, new dependency, or notification-on-start behavior.

- [ ] **Step 6: Commit documentation and final verification changes**

```bash
git add README.md
git commit -m "docs: document opt-in ntfy notifications"
```
