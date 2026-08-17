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

function validateLayer(
  raw: unknown,
  source: string,
): { value: Partial<NtfyConfiguration> | null; warning?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      value: null,
      warning: `Ignored invalid ${source}: root must be an object.`,
    };
  }
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!FIELDS.has(key))
      return {
        value: null,
        warning: `Ignored invalid ${source}: unknown field '${key}'.`,
      };
  }
  for (const key of FIELDS) {
    if (
      key in object &&
      (typeof object[key] !== "string" || object[key] === "")
    ) {
      return {
        value: null,
        warning: `Ignored invalid ${source}: '${key}' must be a non-empty string.`,
      };
    }
  }
  if (
    typeof object.server === "string" &&
    normalizeServer(object.server) === null
  ) {
    return {
      value: null,
      warning: `Ignored invalid ${source}: 'server' must be an HTTP(S) URL.`,
    };
  }
  return { value: object as Partial<NtfyConfiguration> };
}

function readJsonFile(file: string): unknown {
  try {
    const content = readFileSync(file, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    // Preserve ENOENT so callers can silently skip missing optional config
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw error;
    }
    throw new Error(
      `Failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getEnvString(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
): string | undefined {
  return env?.[key];
}

export function loadNtfyConfiguration(
  options: LoadNtfyConfigurationOptions,
): LoadedNtfyConfiguration {
  const { packageRoot, agentDir, env } = options;
  const warnings: string[] = [];

  const packageConfigPath = resolve(packageRoot, "config", "ntfy.json");
  const userConfigPath = resolve(agentDir, "ntfy", "config.json");

  // Read and validate mandatory package config
  let base: Partial<NtfyConfiguration> = {};
  try {
    const raw = readJsonFile(packageConfigPath);
    const result = validateLayer(raw, "package config");
    if (!result.value) {
      throw new Error(result.warning!);
    }
    base = result.value;
  } catch (error) {
    throw new Error(
      `Failed to load ntfy configuration from ${packageConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Read optional user config
  let user: Partial<NtfyConfiguration> | undefined;
  try {
    const raw = readJsonFile(userConfigPath);
    const result = validateLayer(raw, "user config");
    if (result.value) {
      user = result.value;
    } else {
      warnings.push(result.warning!);
      user = undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Missing user config is silently skipped
    } else {
      throw error;
    }
  }

  // Merge: package + user
  let merged = { ...base };
  if (user) {
    merged = { ...merged, ...user };
  }

  // Apply environment overrides field by field
  const rawServer = getEnvString(env, "NTFY_SERVER");
  if (rawServer !== undefined && rawServer !== "") {
    const normalized = normalizeServer(rawServer);
    if (normalized === null) {
      warnings.push(
        `Ignored invalid NTFY_SERVER: 'server' must be an HTTP(S) URL.`,
      );
      // Keep existing server from merged
    } else {
      merged = { ...merged, server: normalized };
    }
  }

  const rawTopic = getEnvString(env, "NTFY_TOPIC");
  if (rawTopic !== undefined && rawTopic !== "") {
    merged = { ...merged, topic: rawTopic };
  }

  const rawToken = getEnvString(env, "NTFY_TOKEN");
  if (rawToken !== undefined && rawToken !== "") {
    merged = { ...merged, token: rawToken };
  }

  return {
    config: merged as NtfyConfiguration,
    userConfigPath,
    warnings,
  };
}

export function resolveTopicUrl(config: NtfyConfiguration): string | null {
  const topic = config.topic;
  if (!topic) return null;

  // Try parsing as a URL first
  try {
    const url = new URL(topic);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.toString();
    }
    // Non-HTTP(S) protocol — return null
    return null;
  } catch {
    // Not a URL — treat as a topic name
  }

  // Remove leading slashes and resolve against server
  const cleanTopic = topic.replace(/^\/+/, "");
  const server = config.server.replace(/\/$/, "");
  return `${server}/${cleanTopic}`;
}
