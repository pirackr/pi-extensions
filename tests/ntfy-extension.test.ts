import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(() => "/agent"),
}));

import { createNtfyExtension } from "../extensions/ntfy/index.ts";

function fakePi() {
  return { on: vi.fn(), registerCommand: vi.fn() };
}

function handler(pi: ReturnType<typeof fakePi>, event: string) {
  return pi.on.mock.calls.find(([name]) => name === event)?.[1] as (
    event: unknown,
    ctx: any,
  ) => Promise<void> | void;
}

function command(pi: ReturnType<typeof fakePi>) {
  return (
    pi.registerCommand.mock.calls.find(([name]) => name === "ntfy")?.[1]
      .handler as (args: string, ctx: any) => Promise<void>
  );
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
  it("registers session_start, turn_start, agent_settled, and /ntfy", () => {
    const { pi } = setup();
    expect(pi.on.mock.calls.map((call) => call[0] as string)).toEqual([
      "session_start",
      "turn_start",
      "agent_settled",
    ]);
    expect(pi.registerCommand).toHaveBeenCalledWith("ntfy", expect.any(Object));
  });

  it.each([
    "startup",
    "reload",
    "new",
    "resume",
    "fork",
  ])("resets enabled and pending state on %s", async (reason) => {
    const { pi, publish } = setup();
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    handler(pi, "turn_start")({}, ctx);
    handler(pi, "session_start")({ reason: reason as string }, ctx);
    await handler(pi, "agent_settled")({}, ctx);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("completion delivery", () => {
  it("sends one fixed, project-aware message for a started and settled run", async () => {
    const { pi, publish } = setup();
    const ctx = context("/work/grinder");
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    handler(pi, "turn_start")({}, ctx);
    await handler(pi, "agent_settled")({}, ctx);
    await handler(pi, "agent_settled")({}, ctx);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      loaded.config,
      { title: "Pi · grinder", body: "Task finished" },
    );
  });

  it("does not publish while off or without a preceding turn_start", async () => {
    const { pi, publish } = setup();
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    handler(pi, "turn_start")({}, ctx);
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
    expect(report).toContain("ntfy notifications: off");
    expect(report).toContain("authentication: enabled");
    expect(report).not.toContain("hidden-credential");
  });

  it("supports on and off", async () => {
    const { pi } = setup();
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "ntfy notifications enabled for this session",
      "info",
    );
    await command(pi)("off", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "ntfy notifications disabled",
      "info",
    );
  });

  it("refuses to enable without a topic", async () => {
    const { pi } = setup({
      ...loaded,
      config: { server: loaded.config.server } as any,
    });
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("topic"),
      "warning",
    );
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

  it("refuses to test without a topic", async () => {
    const { pi, publish } = setup({
      ...loaded,
      config: { server: loaded.config.server } as any,
    });
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("test", ctx);
    expect(publish).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("topic"),
      "warning",
    );
  });

  it("shows usage for unknown arguments", async () => {
    const { pi } = setup();
    const ctx = context();
    await command(pi)("sometimes", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /ntfy [on|off|test]",
      "warning",
    );
  });
});

describe("safe failures", () => {
  it("warns on publishing failure without rejecting the settled handler", async () => {
    const { pi, publish } = setup();
    publish.mockRejectedValue(
      new Error("ntfy request failed with HTTP 500"),
    );
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    handler(pi, "turn_start")({}, ctx);
    await expect(handler(pi, "agent_settled")({}, ctx)).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "ntfy notification failed: ntfy request failed with HTTP 500",
      "warning",
    );
  });

  it("warns on test failure without rejecting", async () => {
    const { pi, publish } = setup();
    publish.mockRejectedValue(new Error("network error"));
    const ctx = context();
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await expect(command(pi)("test", ctx)).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "ntfy test notification failed: network error",
      "warning",
    );
  });

  it("does not call ui.notify when hasUI is false", async () => {
    const { pi, publish } = setup();
    publish.mockResolvedValue(undefined);
    const ctx = { cwd: "/work/grinder", hasUI: false };
    handler(pi, "session_start")({ reason: "startup" }, ctx);
    await command(pi)("on", ctx);
    handler(pi, "turn_start")({}, ctx);
    await handler(pi, "agent_settled")({}, ctx);
    // No ui property means no calls should be made
    expect(ctx as any).toHaveProperty("hasUI", false);
    // publish should still work even without UI
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
