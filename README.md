# omp-windows-terminal

Windows Terminal integration for [oh-my-pi](https://github.com/can1357/oh-my-pi).

When you `/fork` a session, the session you just left is reopened in a new
Windows Terminal **split pane** instead of being lost. You also get commands and
tools for opening forks/sessions in panes, tabs, or windows on demand, for
**discovering** other omp terminals (even ones this extension didn't start), and
for **arranging** several sessions into an even columns/rows layout — all via
`wt.exe`; no oh-my-pi core changes.

> Requires [Windows Terminal](https://aka.ms/terminal) (`wt.exe`). Everything is
> a no-op outside it (gated on the `WT_SESSION` environment variable). Works on
> native Windows and inside WSL (panes are wrapped through `wsl.exe` — see
> [WSL](#wsl)).

## What you get

| Surface | Behavior |
| --- | --- |
| **Auto-pane on `/fork`** | After the built-in `/fork`, the previous session is reopened in a split pane (`omp --resume <previous>`). The native `/fork` is otherwise unchanged. |
| `/wtpane [fork\|current] [vertical\|horizontal]` | Open this session in an adjacent split pane (optional split direction). |
| `/wttab [fork\|current]` | Open this session in a new tab. |
| `/wtwindow [fork\|current]` | Open this session in a new window. |
| `spawn_session_pane` (tool) | LLM-callable: open a `fork` / `resume` / `new` session in a `pane` / `tab` / `window`, with optional `title` / `profile`. |
| `list_omp_sessions` (tool) | LLM-callable: list recent omp terminals — **including ones this extension did not start** — from the core breadcrumb registry, newest first. |
| `arrange_sessions` (tool) | LLM-callable: open several sessions as even **columns** or **rows** in one window, each resumed in its recorded directory. |
| `windows-terminal-control` (skill) | Teaches the agent to drive `wt.exe` for bespoke multi-pane layouts beyond `arrange_sessions` (custom grids, focus moves). Activates on "arrange/split/organize my terminal" or "arrange all my omps". |

`/branch` is **not** hooked on purpose — branching is a lightweight "escape and
pick a message" navigation, not something that warrants a new pane.

### `fork` vs `current`

- `fork` (default) launches an **independent clone** via `omp --fork` — safe, no
  shared state.
- `current` reopens the **same** session via `omp --resume`. Two live processes
  then append to the same session file; oh-my-pi's session journal is not
  designed for concurrent writers, so prefer `fork` unless you specifically want
  a second view and accept the risk.

## Arranging & discovering sessions

`arrange_sessions` opens several omp sessions together in one window — evenly
sized **columns** (side by side) or **rows** (stacked), each resumed in its
recorded working directory:

- Pass explicit `sessions` (ids/prefixes/paths, in order), or omit them to
  auto-pick the most recent terminals.
- The sessions need **not** have been started by this extension. They're
  discovered from oh-my-pi **core's** breadcrumb registry
  (`~/.omp/agent/terminal-sessions/*` — two lines per terminal: cwd, then session
  file), which core writes for *every* terminal. `list_omp_sessions` exposes the
  same list (newest first, with each recorded cwd) so the agent can pick.

This **opens a fresh arranged layout** of resumable sessions; it can't move or
reflow panes that are already running (a process is bound to its pane). Recency
is a "last seen" signal, not proof a session is still open — resuming one that's
live in another terminal means two processes appending to one session file, which
oh-my-pi's journal isn't built for. For bespoke layouts (true grids, focus moves)
the bundled `windows-terminal-control` skill drives `wt.exe` directly.

## Install

Requires oh-my-pi ≥ 16.0.0.

```sh
# From the Git repo (recommended)
omp plugin install https://github.com/AsafMah/omp-windows-terminal

# ...or clone and link a local checkout
git clone https://github.com/AsafMah/omp-windows-terminal
omp plugin link ./omp-windows-terminal
```

The extension is a TypeScript module loaded directly by oh-my-pi (which runs on
Bun) — there is no build step. The `@oh-my-pi/pi-coding-agent` dependency is
type-only and provided by the host at load time.

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `OMP_WT_AUTOPANE` | on | Set to `0` to disable the auto-pane-on-`/fork` behavior. |
| `OMP_BIN` | `omp` | Command used to launch the spawned session. May include arguments — it is split on whitespace (e.g. `OMP_BIN="omp --some-flag"`). |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | Where session discovery reads the breadcrumb registry. Honored from oh-my-pi core; set only if you've overridden the agent directory. |

## How it works

oh-my-pi's `/fork` emits a `session_switch` event with `reason: "fork"` and the
`previousSessionFile` being left. The extension listens for it and runs
`wt.exe -w 0 sp -d <cwd> omp --resume <previous>` to reopen that session beside
the current pane. The commands and tool build the same `wt.exe` invocation with
`--fork` / `--resume` / a fresh session and a `pane` / `tab` / `window` target.

`wt -w 0` targets the current window; `-w new` opens a new one. Every call is
routed through `cmd.exe /d /s /c wt.exe …`: `wt.exe` is a Windows App Execution
Alias that Bun/ptree can't resolve on PATH (a direct spawn fails with "Executable
not found"), and cmd.exe resolves the alias natively.

### WSL

Inside WSL, `WT_SESSION` is inherited but `wt.exe` is still a Windows program, so
a raw POSIX `cwd` and a Linux `omp` command can't be handed to it directly. Under
WSL the extension translates the `-d` start directory to a Windows path via
`wslpath -w` and wraps the child in `wsl.exe -d <distro> --cd <cwd> -- omp …`, so
the pane re-enters the current distro and runs the real Linux `omp` in the right
directory. If `wslpath` can't map the directory, `-d` is dropped (WT falls back to
its default) while `wsl.exe --cd` still places the session correctly.

## Pairs well with

OSC 7 / OSC 9;9 cwd reporting in oh-my-pi core
([can1357/oh-my-pi#2718](https://github.com/can1357/oh-my-pi/pull/2718)): with
that, the reopened/duplicated panes also start in the session's working
directory.

## Develop

```sh
bun install
bun test        # pure builders, layout chaining, and session discovery
bun run check   # tsc --noEmit
```

## License

MIT
