# ntfy Task Notifications Design

## Purpose

Add an opt-in Pi extension that sends an ntfy notification when Pi has fully settled after completing a prompt. Notifications are disabled by default and must be enabled explicitly for each session.

## Architecture

The extension lives under `extensions/ntfy/` and uses native `fetch`; it adds no runtime dependency. Configuration parsing, notification delivery, and Pi lifecycle integration remain separate, independently testable responsibilities.

The extension listens to Pi's `agent_start` and `agent_settled` events. `agent_start` marks that work occurred, and `agent_settled` sends at most one notification after Pi has finished tool calls, retries, compaction, and queued follow-ups. A settled event without a preceding agent run sends nothing.

## Session Control

Notifications begin disabled on every `session_start`, including startup, reload, new, resume, and fork flows. The state is held only in memory and is never persisted.

The extension registers one command:

- `/ntfy` reports current session state and resolved configuration.
- `/ntfy on` enables completion notifications for the current session.
- `/ntfy off` disables completion notifications for the current session.
- `/ntfy test` sends a test notification regardless of the current on/off state.

Unknown arguments produce concise usage guidance. Enabling notifications without a valid topic shows a warning and leaves notifications off.

## Configuration

Configuration comes from packaged defaults, user configuration, and environment variables, in increasing precedence order:

1. `config/ntfy.json`
2. `$PI_AGENT_DIR/ntfy/config.json`
3. Environment variables

Supported values are:

- `server` / `NTFY_SERVER`: ntfy server base URL; packaged default is `https://ntfy.sh`.
- `topic` / `NTFY_TOPIC`: required topic name or full topic URL.
- `token` / `NTFY_TOKEN`: optional bearer token.

No project-local configuration is read. This prevents project-controlled files from redirecting notifications or influencing authentication. The status command may show the resolved server and topic and whether authentication is enabled, but it must never expose the token.

A full topic URL takes precedence over the separate server when constructing the publish URL. Server and topic joins normalize trailing and leading slashes.

## Notification Delivery

A normal completion notification contains:

- Title: `Pi · <project>`, where `<project>` is the basename of the current working directory.
- Body: `Task finished`.

A test notification uses the same project-aware title and a body that clearly identifies it as a test.

Delivery uses an HTTP POST to the resolved topic URL. The request sets the ntfy title header and includes an `Authorization` bearer header only when a token is configured. A five-second abort timeout prevents an unavailable server from delaying Pi indefinitely.

No prompt, response, file content, session transcript, or other task details are transmitted.

## State and Deduplication

The extension keeps two session-local flags:

- whether notifications are enabled;
- whether an agent run has started and is awaiting settlement.

`agent_start` arms completion delivery. `agent_settled` consumes that armed state before attempting delivery, ensuring duplicate settled events cannot produce duplicate notifications. If notifications are off, the event clears pending state without sending. Each later agent run can arm a new notification.

## Error Handling

Missing or invalid optional user configuration does not prevent Pi from running. Configuration and delivery failures are reported through a small Pi UI warning when UI is available.

Non-2xx HTTP responses, network errors, and timeouts count as delivery failures. They never throw into the completed agent workflow, trigger another agent turn, retry the task, or write model-context messages.

## Testing

Vitest coverage will verify:

- packaged, user, and environment precedence;
- default server behavior;
- topic URL construction and slash normalization;
- full topic URL handling;
- optional bearer token headers without token disclosure;
- notifications defaulting off on every session start;
- `/ntfy on`, `/ntfy off`, status, test, and invalid arguments;
- refusal to enable without a valid topic;
- one notification per started-and-settled run when enabled;
- no notification for unarmed settled events or while disabled;
- state reset across all session-start reasons;
- timeout, network, and non-2xx failures producing warnings without escaping handlers;
- project-aware title and fixed, privacy-preserving body.

No external ntfy service is contacted by tests; HTTP and Pi UI boundaries are mocked.
