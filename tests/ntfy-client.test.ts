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
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await publishNtfy(
      config,
      { title: "Pi · grinder", body: "Task finished" },
      { fetch },
    );
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ Title: "Pi · grinder" });
  });

  it("rejects missing topic before calling fetch", async () => {
    const fetch = vi.fn();
    await expect(
      publishNtfy(
        { server: "https://ntfy.sh" },
        { title: "Pi", body: "test" },
        { fetch },
      ),
    ).rejects.toThrow("topic is not configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects non-success responses without reading response content", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("sensitive upstream body", { status: 403 }),
      );
    await expect(
      publishNtfy(config, { title: "Pi", body: "test" }, { fetch }),
    ).rejects.toThrow("HTTP 403");
  });

  it("aborts after the configured timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input: string | Request | URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const promise = publishNtfy(
      config,
      { title: "Pi", body: "test" },
      { fetch, timeoutMs: 50 },
    );
    promise.catch(() => {}); // suppress unhandled rejection warning (handled by expect below)
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).rejects.toThrow("timed out");
  });
});
