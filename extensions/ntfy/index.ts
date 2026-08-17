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

const defaultPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

interface NtfyDependencies {
  packageRoot?: string;
  agentDir?: string;
  loadConfiguration?: typeof loadNtfyConfiguration;
  publish?: (
    config: LoadedNtfyConfiguration["config"],
    message: NtfyMessage,
  ) => Promise<void>;
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning",
): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    // Session replacement or reload can stale an asynchronous context.
  }
}

function projectTitle(cwd: string): string {
  return `Pi · ${path.basename(path.resolve(cwd)) || "task"}`;
}

export function createNtfyExtension(
  pi: ExtensionAPI,
  dependencies: NtfyDependencies = {},
): void {
  const loadConfiguration =
    dependencies.loadConfiguration ?? loadNtfyConfiguration;
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
      notify(
        ctx,
        `ntfy configuration failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
    }
  });

  pi.on("turn_start", () => {
    pendingRun = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingRun) return;
    pendingRun = false;
    if (!enabled || !loaded) return;
    try {
      await publish(loaded.config, {
        title: projectTitle(ctx.cwd),
        body: "Task finished",
      });
    } catch (error) {
      notify(
        ctx,
        `ntfy notification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
    }
  });

  pi.registerCommand("ntfy", {
    description: "Manage ntfy completion notifications",
    handler: async (args: string, ctx: ExtensionContext) => {
      const cmd = args.trim().toLowerCase();

      if (cmd === "on") {
        if (!loaded || !resolveTopicUrl(loaded.config)) {
          notify(
            ctx,
            loaded
              ? "ntfy notifications require a configured topic"
              : "ntfy not configured",
            "warning",
          );
          return;
        }
        enabled = true;
        notify(ctx, "ntfy notifications enabled for this session", "info");
      } else if (cmd === "off") {
        enabled = false;
        notify(ctx, "ntfy notifications disabled", "info");
      } else if (cmd === "test") {
        if (!loaded || !resolveTopicUrl(loaded.config)) {
          notify(
            ctx,
            loaded
              ? "ntfy test requires a configured topic"
              : "ntfy not configured",
            "warning",
          );
          return;
        }
        try {
          await publish(loaded.config, {
            title: projectTitle(ctx.cwd),
            body: "ntfy test notification",
          });
          notify(ctx, "ntfy test notification sent", "info");
        } catch (error) {
          notify(
            ctx,
            `ntfy test notification failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warning",
          );
        }
      } else {
        // Empty or unknown argument
        if (cmd === "") {
          // Status report
          const status = enabled ? "on" : "off";
          const topicUrl =
            loaded && resolveTopicUrl(loaded.config)
              ? resolveTopicUrl(loaded.config)!
              : "not configured";
          const auth = loaded && loaded.config.token
            ? "enabled"
            : "disabled";
          const warningSummary =
            loaded?.warnings.length
              ? ` (${loaded.warnings.length} config warning(s))`
              : "";
          notify(
            ctx,
            `ntfy notifications: ${status}\n` +
              `server: ${loaded?.config.server ?? "not configured"}\n` +
              `topic: ${topicUrl}\n` +
              `authentication: ${auth}\n` +
              `config: ${loaded?.userConfigPath ?? "not configured"}${warningSummary}`,
            "info",
          );
        } else {
          notify(
            ctx,
            "Usage: /ntfy [on|off|test]",
            "warning",
          );
        }
      }
    },
  });
}

export default function ntfyExtension(pi: ExtensionAPI): void {
  createNtfyExtension(pi);
}
