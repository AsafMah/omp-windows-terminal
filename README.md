# omp-windows-terminal

Windows Terminal integration for [oh-my-pi](https://github.com/can1357/oh-my-pi).

When you `/fork` a session, the session you just left is reopened in a new
Windows Terminal **split pane** instead of being lost — and you get commands and
a tool for opening forks/sessions in panes, tabs, or windows on demand. All via
`wt.exe`; no oh-my-pi core changes.

> Requires [Windows Terminal](https://aka.ms/terminal) (`wt.exe`). Everything is
> a no-op outside it (gated on the `WT_SESSION` environment variable).

## What you get

| Surface | Behavior |
| --- | --- |
| **Auto-pane on `/fork`** | After the built-in `/fork`, the previous session is reopened in a split pane (`omp --resume <previous>`). The native `/fork` is otherwise unchanged. |
| `/wtpane [fork\|current]` | Open this session in an adjacent split pane. |
| `/wtwindow [fork\|current]` | Open this session in a new window. |
| `spawn_session_pane` (tool) | LLM-callable: open a `fork` / `resume` / `new` session in a `pane` / `tab` / `window`. |

`/branch` is **not** hooked on purpose — branching is a lightweight "escape and
pick a message" navigation, not something that warrants a new pane.

### `fork` vs `current`

- `fork` (default) launches an **independent clone** via `omp --fork` — safe, no
  shared state.
- `current` reopens the **same** session via `omp --resume`. Two live processes
  then append to the same session file; oh-my-pi's session journal is not
  designed for concurrent writers, so prefer `fork` unless you specifically want
  a second view and accept the risk.

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
| `OMP_BIN` | `omp` | Executable used to launch the spawned session. |

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

## Pairs well with

OSC 7 / OSC 9;9 cwd reporting in oh-my-pi core
([can1357/oh-my-pi#2718](https://github.com/can1357/oh-my-pi/pull/2718)): with
that, the reopened/duplicated panes also start in the session's working
directory.

## Develop

```sh
bun install
bun test        # pure wt.exe argv / launcher builders
bun run check   # tsc --noEmit
```

## License

MIT
