import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export function runControlMode(controlName) {
  process.stdout.write(`Subagent controller: ${controlName || "unknown"}\n`);
  const timer = setInterval(() => {}, 60_000);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

const TOOLS_ACTIVE = new Set([
  "read", "edit", "write", "bash", "grep", "find", "ls", "git",
  "web_lookup", "fetch_web", "ctx_read", "ctx_edit", "ctx_shell",
  "ctx_grep", "ctx_find", "ctx_ls", "lsp_diagnostics", "lens_diagnostics",
  "run_subagents",
]);

export function runTaskMode(requestPath) {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  } catch (error) {
    process.stderr.write(`Failed to parse request file: ${error.message}\n`);
    process.exit(2);
  }
  const startedAt = new Date().toISOString();
  let child;

  // --- Live status fields ---
  let currentTools = [];
  let currentActivity = "";
  let compactionCount = 0;
  let contextWindow = null;
  // Live context usage uses the latest valid assistant-message usage, never
  // the cumulative billing total; compaction_end resets it to null until a
  // post-compaction assistant message arrives.
  let latestContextTokens = null;

  // Best-effort private transcript: mirrors the human-readable pane output
  // (assistant text, tool markers, stderr, terminal summary) into a file the
  // extension owns. Appends so a resumed/re-run task keeps its full history.
  const transcript = request.transcriptPath
    ? fs.createWriteStream(request.transcriptPath, { flags: "a", mode: 0o600 })
    : null;
  if (transcript) {
    transcript.on("error", () => {});
  }
  const mirror = (text) => {
    if (!transcript) return;
    try {
      transcript.write(text);
    } catch {
      // Best-effort only.
    }
  };
  const emit = (text) => {
    process.stdout.write(text);
    mirror(text);
  };
  let timeout;
  let killTimer;
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let buffer = "";
  let finalOutput = "";
  let stopReason;
  let errorMessage;
  let sessionStats = null;
  // Track response ids for get_session_stats delivery
  let nextResponseId = 0;
  let getStatsSent = false;
  let getStatsId = 0;
  let statsReceived = false;
  // Track get_state response id
  let getStateId = 0;
  // Track prompt id for output capture
  let promptId = 0;
  let closeCode = null;

  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 0,
  };

  const writeStatus = (status) => {
    const temporary = `${request.statusPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(status, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, request.statusPath);
  };

  const baseStatus = () => ({
    taskId: request.taskId,
    agent: request.agent,
    startedAt,
    model: request.model,
  });

  const killChild = (signal) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  };

  const requestTermination = (state) => {
    if (settled) return;
    if (state === "timed_out") timedOut = true;
    if (state === "cancelled") cancelled = true;
    killChild("SIGTERM");
    killTimer = setTimeout(() => killChild("SIGKILL"), 5_000);
  };

  const truncate = (s, n = 120) =>
    typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : (s ?? "");

  const summarizeArgs = (args) => {
    if (!args || typeof args !== "object") return "";
    const parts = [];
    if (typeof args.query === "string")
      parts.push(`query="${truncate(args.query)}"`);
    if (typeof args.url === "string") parts.push(`url=${truncate(args.url)}`);
    if (typeof args.path === "string")
      parts.push(`path=${truncate(args.path)}`);
    if (args.limit) parts.push(`limit=${args.limit}`);
    if (args.engine) parts.push(`engine=${args.engine}`);
    if (typeof args.command === "string")
      parts.push(`cmd=${truncate(args.command)}`);
    return parts.join(" ");
  };

  const summarizeResult = (toolName, event) => {
    const result = event.result;
    const details = result?.details;
    if (event.isError) return `ERROR: ${result?.error ?? "tool failed"}`;
    if (toolName === "web_lookup") {
      const results = Array.isArray(details?.results) ? details.results : [];
      const engines = details?.engines?.length
        ? details.engines.join(",")
        : "none";
      const head = results
        .slice(0, 2)
        .map((r) => `${r.title} — ${r.url}`)
        .join(" | ");
      const failures = details?.partialFailures?.length
        ? ` | failures: ${details.partialFailures.map((p) => p.engine).join(",")}`
        : "";
      return `${results.length} results [${engines}]${results.length ? " | " + truncate(head, 180) : ""}${failures}`;
    }
    if (toolName === "fetch_web") {
      const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
      return `"${truncate(details?.title ?? "(no title)", 80)}" ${text.length} chars`;
    }
    const text =
      result?.content
        ?.map((c) => c.text ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim() ?? "";
    return truncate(text || "(no content)", 160);
  };

  const toolCounts = {};

  // --- RPC helpers ---

  const writeRpcCommand = (id, type, params) => {
    const cmd = params
      ? JSON.stringify({ type, id, ...params })
      : JSON.stringify({ type, id });
    child.stdin.write(cmd + "\n");
  };

  // Live context usage derived from the latest valid assistant-message usage
  // and the context window captured from get_state. tokens/percent are null
  // until an assistant message arrives (and after compaction_end).
  const liveContextUsage = () => ({
    tokens: latestContextTokens,
    window: contextWindow,
    percent:
      latestContextTokens != null && contextWindow > 0
        ? Math.round((latestContextTokens / contextWindow) * 100)
        : null,
  });

  const liveStatus = () => ({
    ...baseStatus(),
    state: "running",
    pid: child?.pid,
    tools: currentTools,
    activity: currentActivity,
    contextUsage: liveContextUsage(),
    compactionCount,
    usage: { ...usage },
    turns: usage.turns,
  });

  let stdinEnded = false;
  const endStdin = () => {
    if (stdinEnded) return;
    stdinEnded = true;
    try {
      child.stdin.end();
    } catch {
      // stdin already closed.
    }
  };
  let statsFallbackTimer;

  const activityFor = (toolName) => {
    const base = toolName.replace(/_web$/, "").replace(/web_/g, "web ");
    const active = TOOLS_ACTIVE.has(toolName);
    const short = active ? base : toolName;
    return short.length > 40 ? short.slice(0, 40) + "…" : short;
  };

  const processRpcEvent = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    // response id routing
    if (event.type === "response") {
      const rid = event.id ?? 0;

      // Route get_state response — capture model contextWindow from data
      if (rid === getStateId) {
        const model = event.data?.model;
        contextWindow = model?.contextWindow ?? null;
        return;
      }

      // Route prompt response — success:false means the task was rejected
      if (rid === promptId) {
        if (event.success === false) {
          errorMessage = event.error || "prompt rejected";
          requestTermination("cancelled");
        }
        return;
      }

      // Route get_session_stats response — authoritative contextUsage from data
      if (rid === getStatsId) {
        statsReceived = true;
        if (statsFallbackTimer) clearTimeout(statsFallbackTimer);
        const data = event.data ?? {};
        const tokens = data.tokens ?? {};
        // get_session_stats returns cost as a scalar number, not the
        // {input, output, cacheRead, cacheWrite, total} object the renderers
        // expect — normalize it.
        const costTotal = typeof data.cost === "number" ? data.cost : data.cost?.total ?? 0;
        sessionStats = {
          input: tokens.input || 0,
          output: tokens.output || 0,
          cacheRead: tokens.cacheRead || 0,
          cacheWrite: tokens.cacheWrite || 0,
          totalTokens: tokens.total || 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: costTotal,
          },
          // turns stay as accumulated from message_end, never toolCalls
          turns: usage.turns,
        };
        const authoritative = data.contextUsage;
        if (authoritative) {
          contextWindow = authoritative.contextWindow ?? null;
          latestContextTokens = authoritative.tokens ?? null;
        }
        // Write one last running status with the best available contextUsage,
        // then end stdin so the child exits and `close` writes the terminal
        // status (sole terminal-status writer).
        writeStatus(liveStatus());
        endStdin();
        return;
      }
      return;
    }

    // agent_settled → send get_session_stats (authoritative contextUsage)
    if (event.type === "agent_settled") {
      stopReason = event.stopReason;
      const finalMsg = event.message;
      if (finalMsg?.content) {
        finalOutput = finalMsg.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
      }
      // Send get_session_stats with a unique id
      getStatsId = ++nextResponseId;
      writeRpcCommand(getStatsId, "get_session_stats");
      // Bounded ~3s fallback: write the last running status from live
      // contextUsage and end stdin; the `close` handler remains the sole
      // terminal-status writer, so a non-zero exit cannot be masked.
      statsFallbackTimer = setTimeout(() => {
        if (!statsReceived && !timedOut && !cancelled) {
          writeStatus(liveStatus());
          endStdin();
        }
      }, 3000);
      return;
    }

    // compaction_end — reset live tokens/percent until a post-compaction
    // assistant message arrives; increment the counter.
    if (event.type === "compaction_end") {
      compactionCount += 1;
      latestContextTokens = null;
      writeStatus(liveStatus());
      return;
    }

    // tool_execution_start — track active tools & activity
    if (event.type === "tool_execution_start") {
      const name = event.toolName || event.toolCall?.name || "tool";
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      const args = event.args ?? event.toolCall?.arguments ?? {};
      const summary = summarizeArgs(args);
      emit(`\n[${name}]${summary ? " " + summary : ""}\n`);
      const activity = summary ? `${name}(${summary})` : name;
      currentActivity = activity;
      currentTools = Object.keys(toolCounts);
      writeStatus(liveStatus());
      return;
    }

    // tool_execution_end
    if (event.type === "tool_execution_end") {
      const name = event.toolName || "tool";
      emit(`  ${summarizeResult(name, event)}\n`);
      currentActivity = "";
      writeStatus(liveStatus());
      return;
    }

    // message_update — emit text delta
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && update.delta) emit(update.delta);
    }

    // message_end — accumulate usage + set stopReason/finalOutput for backward compat
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      usage.turns += 1;
      usage.input += message.usage?.input || 0;
      usage.output += message.usage?.output || 0;
      usage.cacheRead += message.usage?.cacheRead || 0;
      usage.cacheWrite += message.usage?.cacheWrite || 0;
      usage.totalTokens += message.usage?.totalTokens || 0;
      usage.cost.input += message.usage?.cost?.input || 0;
      usage.cost.output += message.usage?.cost?.output || 0;
      usage.cost.cacheRead += message.usage?.cost?.cacheRead || 0;
      usage.cost.cacheWrite += message.usage?.cost?.cacheWrite || 0;
      usage.cost.total += message.usage?.cost?.total || 0;
      stopReason = stopReason || message.stopReason;
      if (!finalOutput && message.content) {
        finalOutput = message.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
      }
      // Live context usage tracks the latest valid assistant-message usage
      // (per-message totalTokens), never the cumulative billing total.
      if (Number.isFinite(message.usage?.totalTokens)) {
        latestContextTokens = message.usage.totalTokens;
      }
      writeStatus(liveStatus());
    }
  };

  // Fallback: write final status when child exits (pre-rpc path or timeout)
  const writeFinalStatusFromBuffer = () => {
    settled = true;
    clearGlobalTimers();
    const stoppedNormally =
      stopReason !== "error" &&
      stopReason !== "aborted" &&
      finalOutput.trim();
    const state =
      timedOut
        ? "timed_out"
        : cancelled
          ? "cancelled"
          : stoppedNormally
            ? "succeeded"
            : "failed";
    const result = finalOutput.trim() || "(no output)";
    // Merge session stats into usage if available
    const mergedUsage = sessionStats || { ...usage };
    writeStatus({
      ...baseStatus(),
      state,
      pid: child?.pid,
      exitCode: closeCode ?? null,
      finishedAt: new Date().toISOString(),
      stopReason,
      errorMessage,
      result,
      usage: mergedUsage,
      contextUsage: liveContextUsage(),
      compactionCount,
    });
    emit(`\n\n[${request.agent} ${state}]\n`);
    if (Object.keys(toolCounts).length) {
      const summary = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      emit(`tool calls: ${summary}\n`);
    }
    transcript?.end();
    process.exitCode = state === "succeeded" ? 0 : 1;
  };

  const clearGlobalTimers = () => {
    clearTimeout(timeout);
    if (statsFallbackTimer) clearTimeout(statsFallbackTimer);
    if (killTimer) clearTimeout(killTimer);
  };

  // --- Pane header ---
  emit(`━━━ ${request.agent} · ${request.taskId} · ${request.model} ━━━\n`);

  // --- Status: starting ---
  writeStatus({ ...baseStatus(), state: "starting" });

  // --- Spawn with --mode rpc ---
  const output = fs.createWriteStream(request.outputPath, {
    flags: "w",
    mode: 0o600,
  });
  const stderr = fs.createWriteStream(request.stderrPath, {
    flags: "w",
    mode: 0o600,
  });
  const args = [
    ...request.pi.args,
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    ...request.childExtensions.flatMap((extension) => [
      "--extension",
      extension,
    ]),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    ...(request.loadContextFiles ? [] : ["--no-context-files"]),
    "--model",
    request.model,
    ...(request.thinking ? ["--thinking", request.thinking] : []),
    "--tools",
    request.tools.join(","),
    // Pass web-search budgets directly as CLI flags (no env vars).
    // The web-search extension registers these and reads them via getFlag().
    ...(Number.isInteger(request.webSearchMaxLookups) &&
    request.webSearchMaxLookups > 0
      ? ["--web-search-max-lookups", String(request.webSearchMaxLookups)]
      : []),
    ...(Number.isInteger(request.webSearchMaxFetches) &&
    request.webSearchMaxFetches > 0
      ? ["--web-search-max-fetches", String(request.webSearchMaxFetches)]
      : []),
    "--append-system-prompt",
    request.promptPath,
  ];

  child = spawn(request.pi.command, args, {
    cwd: request.cwd,
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", (error) => {
    errorMessage ||= `Failed to send task input to Pi: ${error.message}`;
  });

  // --- RPC task delivery: get_state then prompt ---
  getStateId = ++nextResponseId;
  writeRpcCommand(getStateId, "get_state");
  writeStatus({ ...baseStatus(), state: "running", pid: child.pid });

  const taskText = fs.readFileSync(request.taskPath, "utf8");
  promptId = ++nextResponseId;
  writeRpcCommand(promptId, "prompt", { message: taskText });

  child.stdout.on("data", (chunk) => {
    output.write(chunk);
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      processRpcEvent(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr.write(chunk);
    process.stderr.write(chunk);
    mirror(chunk.toString());
  });

  child.on("error", (error) => {
    errorMessage = error.message;
  });

  child.on("exit", () => {
    if (timedOut || cancelled || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
      killTimer = setTimeout(() => killChild("SIGKILL"), 1_000);
    } catch {
      // No descendants remain in the detached process group.
    }
  });

  child.on("close", (code) => {
    closeCode = code;
    if (buffer.trim()) processRpcEvent(buffer);
    output.end();
    stderr.end();
    writeFinalStatusFromBuffer();
  });

  timeout = setTimeout(
    () => requestTermination("timed_out"),
    request.timeoutMs,
  );
  process.on("SIGINT", () => requestTermination("cancelled"));
  process.on("SIGTERM", () => requestTermination("cancelled"));
  process.on("SIGHUP", () => requestTermination("cancelled"));
}

export function main(argv = process.argv) {
  const [, , requestArg, controlName] = argv;

  if (requestArg === "--control") {
    runControlMode(controlName);
  } else {
    if (!requestArg) {
      process.stderr.write("Usage: node runner.mjs <request.json>\n");
      process.exit(2);
    }
    runTaskMode(requestArg);
  }
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule =
  process.argv[1] === __filename || process.argv[1]?.endsWith("runner.mjs");

if (isMainModule) {
  main();
}
