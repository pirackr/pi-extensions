// Live integration test for the ntfy extension — uses the REAL code path:
//   loadNtfyConfiguration (real config files) -> resolveTopicUrl -> publishNtfy (real network POST)
// Run: node tests/ntfy-live-integration.mjs
//
// Verification: ntfy.sh caches published messages. We read back the topic's
// SSE feed (GET /json?since=all) over node:https — instant replay — and scan
// for our unique marker, proving end-to-end delivery. (node:fetch/undici does
// not stream this SSE endpoint promptly; node:https does. This is a
// verification-side quirk only — the extension itself only POSTs, and the POST
// path is exercised through the real publishNtfy client below.)

import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node 24 type-strips .ts imports natively.
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const agentDir = path.join(os.homedir(), ".pi", "agent");

const { loadNtfyConfiguration, resolveTopicUrl } = await import(
  "../extensions/ntfy/config.ts"
);
const { publishNtfy } = await import("../extensions/ntfy/client.ts");

function line(label, value) {
  console.log(`${label.padEnd(24)} ${value}`);
}

// Short-lived https GET of the SSE feed; resolves true as soon as `needle`
// appears in a JSON line, false on timeout. Destroys the socket either way.
function scanFeed(feedUrl, needle, timeoutMs = 4_000) {
  return new Promise((resolvePromise) => {
    const req = https.get(feedUrl, (res) => {
      res.setEncoding("utf8");
      let buffer = "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        req.destroy();
        resolvePromise(value);
      };
      res.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          if (raw.includes("{") && raw.includes(needle)) {
            finish(true);
            return;
          }
        }
      });
      res.on("end", () => finish(false));
      res.on("error", () => finish(false));
    });
    req.on("error", () => resolvePromise(false));
    setTimeout(() => {
      req.destroy();
      resolvePromise(false);
    }, timeoutMs);
  });
}

async function waitForOnFeed(feedUrl, needle, attempts = 4, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    if (await scanFeed(feedUrl, needle)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function run() {
  console.log("=== ntfy live integration ===");
  line("node", process.version);
  line("packageRoot", packageRoot);
  line("agentDir", agentDir);

  // 1. REAL config resolution (package config + $PI_AGENT_DIR/ntfy/config.json)
  const loaded = loadNtfyConfiguration({ packageRoot, agentDir, env: {} });
  line("server", loaded.config.server);
  line("userConfig", loaded.userConfigPath);
  line("warnings", loaded.warnings.length || "none");
  const topicUrl = resolveTopicUrl(loaded.config);
  line("resolved topic", topicUrl);
  if (!topicUrl) {
    console.log("\nFAIL: no configurable topic - cannot send.");
    process.exit(1);
  }
  const feedUrl = topicUrl.replace(/\/$/, "") + "/json?since=all";

  // 2. REAL publish of a test payload through the extension client
  const marker = `ntfy-live-${Date.now()}`;
  await publishNtfy(loaded.config, {
    title: "Pi · ntfy-integration-test",
    body: `Integration test ${marker}`,
  });
  line("publish", "POST accepted (no non-2xx thrown)");

  // 3. Verify delivery by reading the topic feed
  const delivered = await waitForOnFeed(feedUrl, marker);
  line("delivered", delivered ? "confirmed on topic feed" : "NOT observed");
  console.log(
    "\nRESULT:",
    delivered
      ? `PASS - message reached ${topicUrl}`
      : `FAIL - published OK but not observed back on ${topicUrl}`,
  );

  // 4. Verify the exact production payload shape ("Task finished") works too
  const marker2 = `finished-${Date.now()}`;
  await publishNtfy(loaded.config, {
    title: `Pi · ${path.basename(packageRoot)}`,
    body: `Task finished ${marker2}`,
  });
  line("prod-shape publish", "POST accepted");
  const delivered2 = await waitForOnFeed(feedUrl, marker2);
  line(
    "prod-shape delivered",
    delivered2 ? "confirmed on topic feed" : "NOT observed",
  );
  console.log(
    "RESULT:",
    delivered2
      ? "PASS - production payload delivered"
      : "FAIL - production payload not observed",
  );

  process.exit(delivered && delivered2 ? 0 : 1);
}

run().catch((error) => {
  console.error("FAIL:", error);
  process.exit(1);
});
