import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level fs mock — hoisted by vi.mock so it is in place when
// config.ts is imported.  We use a shared ref object so the mock
// closure captures the current file contents without relying on
// mockImplementation ordering.
// ---------------------------------------------------------------------------
const __filesRef = { contents: null as Record<string, string> | null };

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn((path: string) => {
      const contents = __filesRef.contents;
      const file = String(path);
      if (contents && file in contents) return contents[file];
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }),
  };
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

function setFiles(contents: Record<string, string>): void {
  __filesRef.contents = contents;
}

beforeEach(() => {
  __filesRef.contents = null;
  vi.clearAllMocks();
});

describe("loadNtfyConfiguration", () => {
  it("loads the packaged default without inventing a topic or token", () => {
    setFiles({ "/pkg/config/ntfy.json": JSON.stringify({ server: "https://ntfy.sh" }) });
    expect(loadNtfyConfiguration(options)).toMatchObject({
      config: { server: "https://ntfy.sh" },
      userConfigPath: "/agent/ntfy/config.json",
      warnings: [],
    });
  });

  it("applies user fields and then per-field environment overrides", () => {
    setFiles({
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
    setFiles({
      "/pkg/config/ntfy.json": JSON.stringify({ server: "https://ntfy.sh" }),
      "/agent/ntfy/config.json": JSON.stringify(userConfig),
    });
    const result = loadNtfyConfiguration(options);
    expect(result.config).toEqual({ server: "https://ntfy.sh" });
    expect(result.warnings.join("\n")).toContain(String(field));
  });

  it("keeps lower-precedence values when an environment URL is invalid", () => {
    setFiles({
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
    setFiles({
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
