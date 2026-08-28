# `tmuxify` Pi session lifecycle — design

## Status

Approved design. Implementation remains gated on a separate implementation plan and its review.

## Goal

Make the main Pi process and its subagents share one tmux session without making `tmuxify` Pi-specific.

For Pi, the topology is:

```text
pi-a7k2
├── main
├── subagent-q9xm
└── subagent-4vnr
```

For other commands, `tmuxify` remains a generic launcher using a `tmuxify-<id>` session. Every `tmuxify` session is temporary: when its main command exits, the launcher destroys the entire session.

## Decisions

- `tmuxify pi ...` is the only Pi-specific invocation form.
- Pi sessions are named `pi-<id>`; generic sessions are named `tmuxify-<id>`.
- IDs are collision-checked four-character lowercase hexadecimal strings, which satisfy the subagent extension's four-character lowercase alphanumeric ID contract.
- Pi receives `PI_SESSION_ID=<id>` in its environment.
- The requested command runs in a window named `main`.
- The launcher owns tmux creation and cleanup. Pi lifecycle events do not kill tmux sessions.
- When the main command exits, cleanup kills the whole tmux session, including running subagents.
- Cleanup removes only the tmux session. Durable subagent artifacts under `/tmp/<project>/pi-<id>` remain for inspection and normal operating-system cleanup.
- This behavior applies to every command launched through `tmuxify`; generic commands no longer leave an interactive Fish shell behind.

## Scope

The primary implementation lives in the Home Manager Fish configuration:

```text
/home/pirackr/.config/home-manager/modules/fish.nix
```

The existing subagent extension already implements the required integration:

- `extensions/subagent/identity.ts` prefers the suffix of a current `pi-[a-z0-9]{4}` tmux session.
- `extensions/subagent/tmux.ts` creates `subagent-<agent-id>` windows in that session.
- `extensions/subagent/index.ts` also accepts `PI_SESSION_ID` as an identity fallback.

The extension should not need production changes unless verification exposes a missing contract. Tests or documentation may be updated to make the launcher integration explicit.

## Ownership model

### `tmuxify`

The launcher owns:

- command classification (`pi` versus generic)
- short-ID allocation
- tmux session creation
- the `main` window
- Pi's `PI_SESSION_ID` environment value
- client attach or switch behavior
- unconditional session destruction after the main command exits

### Subagent extension

The extension owns:

- recognizing `pi-<id>` as the current parent identity
- placing each child in a sibling `subagent-<agent-id>` window
- subagent process and artifact management while Pi is running
- durable logs and results

The extension does not destroy the parent tmux session from `session_shutdown`. That event also fires for `/reload`, `/new`, `/resume`, and `/fork`, so using it for tmux cleanup would destroy a live main process during normal in-process lifecycle transitions.

## Launcher algorithm

Given `tmuxify <command> [arguments...]`:

1. Return without side effects when no command is supplied.
2. Treat the invocation as Pi-specific only when the first argument is exactly `pi`.
3. Generate a four-character lowercase hexadecimal ID.
4. Choose `pi-<id>` for Pi or `tmuxify-<id>` for any other command.
5. Attempt to create that tmux session atomically. If the name already exists, allocate another ID and retry. Report other creation failures immediately.
6. Create the initial window as `main`.
7. Build the command with Fish's argument-escaping facilities. Do not flatten raw arguments into an unescaped `eval` string.
8. For Pi only, export `PI_SESSION_ID=<id>` inside the command wrapper.
9. Run the requested command in the foreground.
10. After any normal or non-zero command exit, idempotently run `tmux kill-session -t <session-name>`.
11. When called inside tmux, switch the current client to the new session. Otherwise attach to it.

The command wrapper, not a Pi extension event or external supervisor, performs cleanup. The wrapper remains alive while the requested command is its foreground child, so Ctrl-D, Ctrl-C, command failure, and ordinary Pi crashes all return control to the wrapper and trigger cleanup.

## Command construction and safety

`tmux new-session` ultimately receives a shell command, while `pi` is a Fish function supplied by Home Manager rather than a standalone executable. The launcher therefore uses a Fish wrapper but constructs the requested command from individually escaped argv elements.

Dynamic values are limited to:

- a validated four-character hexadecimal ID
- a derived session name with a fixed prefix
- argv elements escaped by Fish before inclusion in the wrapper

No prompt, project path, or raw argument is interpolated unescaped. Arguments containing whitespace, quotes, semicolons, dollar signs, or glob characters must reach the requested command unchanged.

## Cleanup semantics

Cleanup begins only when the top-level command exits. For Pi, killing `pi-<id>` also terminates every running `subagent-<id>` window. This is deliberate: subagents do not survive their main agent.

Cleanup does not run for Pi session events while the Pi process remains alive. In particular, `/reload`, `/new`, `/resume`, and `/fork` retain the same tmux session and parent ID.

A direct `SIGKILL` of the Fish wrapper can bypass its finalizer and leave sibling windows alive. Covering that case would require a separate watcher or tmux-hook design, which is outside this scope. Killing Pi itself does not have this limitation because the wrapper survives and observes Pi's exit.

## Error handling

| Case | Behavior |
| --- | --- |
| No arguments | Return without creating a session. |
| Generated session already exists | Generate another ID and retry. |
| tmux missing | Print a clear launcher error and return non-zero. |
| Session creation fails for another reason | Report the tmux error; do not attach. |
| Requested command is missing | Command exits non-zero; wrapper still destroys the session. |
| Requested command fails | Wrapper still destroys the session. |
| Attach or switch fails after creation | Report the session name and destroy the newly created session rather than leave hidden work. |
| Session already disappeared during cleanup | Treat cleanup as complete. |
| Pi extension reloads or switches conversations | Do not clean up; the Pi process is still alive. |
| Main Pi exits with running subagents | Destroy the whole session and terminate the subagents. |

Because switching to another tmux session is asynchronous from the original pane's perspective, `tmuxify` does not promise to propagate the wrapped command's exact exit status to the invoking shell. Its lifecycle guarantee is session cleanup.

## Verification

### Home Manager and Fish

- Evaluate or build the Home Manager configuration successfully.
- Confirm `tmuxify` with no arguments is a no-op.
- Run a generic successful command and confirm its `tmuxify-<id>` session disappears.
- Run a generic failing command and confirm its session disappears.
- Run a missing command and confirm its session disappears.
- Pass arguments containing spaces and shell metacharacters and verify exact argument preservation.
- Exercise both invocation paths: outside tmux (`attach-session`) and inside tmux (`switch-client`).

### Pi and subagents

1. Start `tmuxify pi`.
2. Confirm the session is named `pi-<id>` and its initial window is `main`.
3. Confirm Pi receives the matching `PI_SESSION_ID`.
4. Spawn multiple subagents.
5. Confirm each appears as a sibling `subagent-<agent-id>` window in the same session and that no second parent session is created.
6. Exercise `/reload` and a conversation replacement flow; confirm the tmux session survives with the same ID.
7. Exit Pi while at least one subagent is running.
8. Confirm the entire `pi-<id>` session and child processes disappear.
9. Confirm `/tmp/<project>/pi-<id>` artifacts remain.
10. Run the existing subagent identity, tmux, integration, and lifecycle tests.

## Non-goals

- Keeping subagents alive after the main Pi process exits
- Deleting durable subagent artifacts
- Propagating the wrapped command's exact status through tmux attach/switch
- Adding an external supervisor daemon or watcher
- Recovering from `SIGKILL` of the Fish wrapper itself
- Making arbitrary aliases, paths, or `npx` invocations count as Pi; only an exact first command of `pi` selects the Pi convention
- Changing subagent IDs, window names, queue semantics, or result storage
