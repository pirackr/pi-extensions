/**
 * Task 14: Legacy restore behavior.
 *
 * A legacy deep-research run (pre-refactor) lived in a /tmp scratch
 * workspace with its own session data (`session.json`, old `run-state.json`)
 * and never produced the new `.research/` lifecycle contract. The new
 * engine must:
 *  - report an explicit cannot-resume message for such runs,
 *  - preserve the old session data untouched,
 *  - never resume legacy state under the new engine,
 *  - never import old /tmp workspaces into the retained-workspace listing,
 *  - keep the generic /loop available,
 *  - ignore the old `$PI_AGENT_DIR/deep-research/config.json` override.
 *
 * Reuses the resume.ts / history.ts modules (and the /research command
 * wiring) — the same code paths a user hits with `/research resume`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resumeWorkspace, type ResumeDependencies } from "../extensions/research/resume.ts";
import {
  listWorkspaces,
  lookupWorkspace,
} from "../extensions/research/history.ts";
import { loadResearchAgentConfig } from "../extensions/tmux-subagent/config.ts";
import { loadPackagedConfig } from "../extensions/research/config.ts";
import piLoop from "../extensions/loop/index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
  parseFrontmatter: vi.fn(),
}));

// ===========================================================================
// Helpers
// ===========================================================================

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a LEGACY deep-research workspace: old session data at the top
 * level, optionally an old-format `.research/run-state.json`, and NO
 * new-format lifecycle.json. Mirrors the pre-refactor /tmp scratch layout.
 */
function buildLegacyWorkspace(
  root: string,
  name: string,
  opts: { withRunState?: boolean } = {},
): string {
  const wsPath = path.join(root, name);
  fs.mkdirSync(wsPath, { recursive: true });
  fs.writeFileSync(
    path.join(wsPath, "session.json"),
    JSON.stringify(
      {
        mission: "legacy mission",
        round: 3,
        profile: "standard",
        workingDir: `/tmp/pi-${name}/research/run-1-${name}`,
      },
      null,
      2,
    ),
    "utf-8",
  );
  if (opts.withRunState) {
    const researchPath = path.join(wsPath, ".research");
    fs.mkdirSync(researchPath, { recursive: true });
    fs.writeFileSync(
      path.join(researchPath, "run-state.json"),
      JSON.stringify(
        {
          revision: 1,
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          mission: "legacy mission",
          runId: "run-1",
          coordinatorUsage: 0,
          nestedUsage: 0,
          tokensUsed: 0,
          concurrentReservations: 0,
          researchRound: 3,
          checkpointVerdict: "CONTINUE",
          checkpointDigest: "",
          checkpointUnmet: [],
          checkpointUniqueSources: 0,
          loopIteration: 3,
          checkpointProfile: "standard",
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
  return wsPath;
}

/** Minimal model/provider registry views for resumeWorkspace. */
function resumeDeps(): ResumeDependencies {
  const models = {
    get(name: string) {
      const entries: Record<string, { id: string; name: string; provider: string }> = {
        strong: { id: "local/strong", name: "strong", provider: "local" },
        eval: { id: "local/eval", name: "eval", provider: "local" },
        light: { id: "local/light", name: "light", provider: "local" },
      };
      return entries[name] ? { ...entries[name], capabilities: [] } : undefined;
    },
    has(name: string) {
      return name === "strong" || name === "eval" || name === "light";
    },
  };
  const providers = {
    get: () => undefined,
    has: () => true,
    getAll: () => [],
  };
  return {
    config: loadPackagedConfig(),
    getModels: () => models,
    getProviders: () => providers,
  };
}

// ===========================================================================
// resumeWorkspace / history — legacy workspaces
// ===========================================================================

describe("legacy restore — resumeWorkspace", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir("research-legacy-restore-");
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("returns an explicit cannot-resume message for a legacy run and preserves session data", async () => {
    const wsPath = buildLegacyWorkspace(tmpDir, "legacy-run");
    const sessionBefore = fs.readFileSync(
      path.join(wsPath, "session.json"),
      "utf8",
    );
    const deps = { ...resumeDeps() };

    const result = await resumeWorkspace(wsPath, deps);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("no_lifecycle");
      expect(result.error).toMatch(/No lifecycle snapshot found/);
    }
    // Explicit command-layer message a user would see.
    const message = `Cannot resume ${path.basename(wsPath)}: ${(result as { error: string }).error} (${(result as { reason: string }).reason}).`;
    expect(message).toMatch(
      /Cannot resume legacy-run: No lifecycle snapshot found \(no_lifecycle\)\./,
    );

    // Session data preserved — nothing deleted or rewritten.
    expect(fs.readFileSync(path.join(wsPath, "session.json"), "utf8")).toBe(
      sessionBefore,
    );
    // No migration into the new workspace layout either.
    expect(fs.existsSync(path.join(wsPath, ".research", "lifecycle.json"))).toBe(
      false,
    );
  });

  it("never resumes legacy state: old run-state without lifecycle is refused and preserved", async () => {
    const wsPath = buildLegacyWorkspace(tmpDir, "legacy-state", {
      withRunState: true,
    });
    const stateBefore = fs.readFileSync(
      path.join(wsPath, ".research", "run-state.json"),
      "utf8",
    );
    const deps = { ...resumeDeps() };

    // resumeWorkspace itself requires the new lifecycle contract — the old
    // mutable state alone is not enough to resume under the new engine.
    const result = await resumeWorkspace(wsPath, deps);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("no_lifecycle");
    }
    expect(
      fs.readFileSync(path.join(wsPath, ".research", "run-state.json"), "utf8"),
    ).toBe(stateBefore);
  });

  it("does not import old /tmp workspaces into the retained-workspace listing", async () => {
    // Simulate the pre-refactor scratch root: /tmp/<project-folder>/research/...
    const scratchRoot = createTempDir("tmp-legacy-project-");
    try {
      const legacyScratch = path.join(
        scratchRoot,
        "research",
        "run-1-some-topic",
      );
      fs.mkdirSync(legacyScratch, { recursive: true });
      fs.writeFileSync(
        path.join(legacyScratch, "session.json"),
        JSON.stringify({ mission: "old topic", round: 2 }),
        "utf-8",
      );

      // Discovery is project-root scoped: the /tmp workspace is invisible.
      const { entries } = listWorkspaces(tmpDir);
      expect(entries).toHaveLength(0);
      expect(lookupWorkspace(tmpDir, "some-topic")).toBeNull();
    } finally {
      cleanup(scratchRoot);
    }
  });
});

// ===========================================================================
// /research resume command — explicit message through the real wiring
// ===========================================================================

describe("legacy restore — /research resume command", () => {
  let mock: { pi: unknown; tools: Record<string, unknown>; commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> };
  let cwd: string;
  let notices: Array<{ level: string; message: string }>;

  function mockCtx(confirmResponse = true) {
    return {
      cwd,
      ui: {
        notify: (message: string, level: string) => {
          notices.push({ level, message });
        },
        confirm: async (_title: string, _message: string) => confirmResponse,
        setStatus: () => {},
      },
      isIdle: () => false,
      modelRegistry: {
        getAll: () => [
          { id: "local/strong", name: "strong", provider: "local", reasoning: true, input: ["text"] },
          { id: "local/eval", name: "eval", provider: "local", reasoning: true, input: ["text"] },
          { id: "local/light", name: "light", provider: "local", reasoning: false, input: ["text"] },
        ],
        getRegisteredProviderIds: () => ["local"],
        getProvider: () => undefined,
      },
    };
  }

  beforeEach(() => {
    notices = [];
    cwd = createTempDir("research-legacy-cmd-");
    const tools: Record<string, unknown> = {};
    const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
    mock = {
      pi: {
        registerTool: (def: { name: string }) => {
          tools[def.name] = def;
        },
        registerCommand: (cmd: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
          commands[cmd] = def;
        },
        on: () => {},
        sendMessage: () => {},
        appendEntry: vi.fn(),
        getActiveTools: () => [] as string[],
        setActiveTools: () => {},
      },
      tools,
      commands,
    };
    piLoop(mock.pi as never);
    // Clear any loop state carried over from a previous test (module cached).
    mock.commands.research.handler("clear", mockCtx()).catch(() => {});
  });

  afterEach(() => {
    cleanup(cwd);
  });

  it("surfaces an explicit cannot-resume message for a legacy run", async () => {
    // Old-format state only — no lifecycle.json.
    const legacyPath = buildLegacyWorkspace(cwd, "legacy-cmd-run", {
      withRunState: true,
    });

    await mock.commands.research.handler(
      `resume ${legacyPath}`,
      mockCtx(),
    );

    // Baseline notices from the beforeEach `clear` are ignored.
    const resumeNotices = notices.slice(1);
    const warning = resumeNotices.find((n) => n.level === "warning");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/^Cannot resume /);
    expect(warning!.message).toContain("legacy-cmd-run");
    expect(warning!.message).toMatch(/\(state_not_resumable|no_lifecycle\)\.$/);

    // Legacy session data is still on disk after the refused resume.
    expect(fs.existsSync(path.join(legacyPath, "session.json"))).toBe(true);
    expect(fs.existsSync(path.join(legacyPath, ".research", "run-state.json"))).toBe(
      true,
    );
  });

  it("keeps generic /loop available after a refused legacy resume", async () => {
    const legacyPath = buildLegacyWorkspace(cwd, "legacy-loop-run", {
      withRunState: true,
    });
    await mock.commands.research.handler(`resume ${legacyPath}`, mockCtx());
    // Baseline notices from the beforeEach `clear` are ignored; the resume
    // attempt itself must have surfaced an explicit cannot-resume warning.
    const resumeNotices = notices.slice(1);
    expect(
      resumeNotices.some((n) => n.level === "warning" && n.message.startsWith("Cannot resume ")),
    ).toBe(true);

    // Generic /loop still starts a fresh loop state (commandName "loop").
    await mock.commands.loop.handler("generic mission", mockCtx());
    const appendCalls = (mock.pi as { appendEntry: ReturnType<typeof vi.fn> })
      .appendEntry.mock.calls;
    const last = appendCalls[appendCalls.length - 1][1] as {
      loop?: { commandName?: string; mission?: string };
    };
    expect(last.loop?.commandName).toBe("loop");
    expect(last.loop?.mission).toBe("generic mission");
  });
});

// ===========================================================================
// Old user-override path is ignored
// ===========================================================================

describe("legacy restore — old user-override path ignored", () => {
  let agentDir: string;
  const packageRoot = path.resolve(import.meta.dirname, "..");

  beforeEach(() => {
    agentDir = createTempDir("research-legacy-agentdir-");
  });

  afterEach(() => {
    cleanup(agentDir);
  });

  it("ignores $PI_AGENT_DIR/deep-research/config.json and reads research/config.json", () => {
    // Old override path present with a distinctive role — must be ignored.
    const oldDir = path.join(agentDir, "deep-research");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(
      path.join(oldDir, "config.json"),
      JSON.stringify({
        agents: {
          legacy_phantom: {
            description: "must be ignored",
            model: "strong",
            thinking: "high",
            tools: ["read"],
            access: "read",
            timeoutSeconds: 300,
            promptPath: "phantom.md",
            resultFormat: "markdown",
          },
        },
      }),
      "utf-8",
    );

    const withoutOverride = loadResearchAgentConfig(packageRoot, agentDir);
    expect(withoutOverride.roles.legacy_phantom).toBeUndefined();
    // Packaged roles (single config owner) are still loaded.
    expect(withoutOverride.roles.judge).toBeDefined();

    // New override path is honored.
    const newDir = path.join(agentDir, "research");
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(
      path.join(newDir, "config.json"),
      JSON.stringify({
        roles: {
          judge: {
            description: "override judge",
            model: "eval",
            thinking: "medium",
            tools: ["read"],
            access: "read",
            timeoutSeconds: 1200,
            promptPath: "judge-override.md",
            resultFormat: "markdown",
          },
        },
      }),
      "utf-8",
    );

    const withOverride = loadResearchAgentConfig(packageRoot, agentDir);
    expect(withOverride.roles.judge.description).toBe("override judge");
    // Prompt paths for override roles resolve against the override dir.
    expect(withOverride.roles.judge.promptPath).toBe(
      path.join(newDir, "judge-override.md"),
    );
  });
});
