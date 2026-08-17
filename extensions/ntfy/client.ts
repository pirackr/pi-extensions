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
    if (!response.ok)
      throw new Error(`ntfy request failed with HTTP ${response.status}`);
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`ntfy request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
