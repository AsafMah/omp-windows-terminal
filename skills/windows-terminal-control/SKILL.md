---
name: windows-terminal-control
description: Control Windows Terminal from the agent via wt.exe — split panes, open tabs/windows, move focus, and arrange oh-my-pi (omp) sessions into a multi-pane layout. Use when the user asks to arrange, split, tile, or organize their terminal, open omp sessions side by side, lay out panes, or "arrange all my omps". Covers resolving the wt.exe App Execution Alias (run through cmd.exe), the wt command grammar, finding recent omp sessions from breadcrumbs, and the hard limits (can't reflow already-running panes).
---

# Windows Terminal control

Drive Windows Terminal (`wt.exe`) from the `bash` tool to build pane/tab/window
layouts — in particular, to open several omp sessions arranged together.

## When to use

- The user wants to **arrange / split / tile / organize** their terminal, or open
  multiple omp sessions **side by side** ("arrange all my omps", "put these in a grid").
- For opening **one** session in a single pane/tab/window, prefer the
  **`spawn_session_pane` tool** — it's gotcha-free. Use this skill for **multi-pane
  layouts** the tool can't express.

## Running wt.exe — read this first

`wt.exe` is a Windows **App Execution Alias** (a 0-byte stub). A bare `wt.exe`
through the agent's exec path fails with `Executable not found in $PATH`. **Always
invoke it through cmd.exe**, which resolves the alias natively:

```
cmd.exe /d /s /c wt.exe <args>
```

- Confirm it resolves: `cmd.exe /d /s /c where wt.exe`.
- `wt` is **fire-and-forget**: it dispatches to the terminal and returns
  immediately, with no stdout on success. A `0` exit means the action was sent.

## wt command grammar

- **Target window** (global, first): `-w 0` = current/most-recent window,
  `-w new` = a new window, `-w <name>` = a named window (created if absent).
- **new-tab**: `nt [-p <profile>] [-d <cwd>] [--title <t>] [<command…>]`
- **split-pane**: `sp [-H|-V] [-s <0..1>] [-d <cwd>] [<command…>]` — splits the
  **currently focused** pane (`-H` = stack below, `-V` = beside; `-s` = size fraction).
- **move-focus**: `mf <left|right|up|down|first|previous|next>`
- **focus-tab**: `ft -t <index>` | `ft --next` | `ft --previous`
- **Chain** actions inside one window with `;` to build a whole layout in a single call.

The `<command…>` is launched directly (not via a shell), so put the literal
executable first, e.g. `omp --resume C:\path\to\session.jsonl`.

## Finding omp sessions to lay out

There is **no live-pane enumeration** — `wt` exposes no API to list panes, and the
live-session registry is future work. Use these best-effort sources:

- **Recent omp terminals** — `~/.omp/agent/terminal-sessions/`: one file per
  terminal, two lines: `<cwd>` then `<sessionFile>`. These are the most recent
  sessions seen per terminal (stale entries may linger).
- **All sessions** — `~/.omp/agent/sessions/<project>/<id>.jsonl`, newest by mtime.

Resume one with `omp --resume "<sessionFile-or-id-prefix>"`.

**You can OPEN a new arranged layout** resuming these sessions. **You cannot move or
reflow panes that are already running** — a process is bound to its pane, so
"arrange my omps" means *open a fresh arranged layout* of resumable sessions, not
relocate live ones. If sessions are currently live elsewhere, say so and confirm
before resuming them (two live omps on one session file is unsafe).

## Recipes

**Three sessions in a row (new window):**
```
cmd.exe /d /s /c wt.exe -w new nt -d C:\a omp --resume A ; sp -V -d C:\b omp --resume B ; sp -V -d C:\c omp --resume C
```
`nt` opens A; each `sp -V` splits the focused pane to the right. Add `-s 0.33` etc.
to balance widths.

**2×2 grid:**
```
cmd.exe /d /s /c wt.exe -w new nt -d C:\a omp --resume A ; sp -H -d C:\c omp --resume C ; mf up ; sp -V -d C:\b omp --resume B ; mf down ; sp -V -d C:\d omp --resume D
```
Pattern: split the focused pane, `mf` to reposition focus, split again. Exact pixel
layout varies; use `-s` to tune.

**Split the current window for one session:**
```
cmd.exe /d /s /c wt.exe -w 0 sp -d C:\proj omp --resume <session>
```

## Gotchas & limits

- **Always pass an explicit `<command>`.** `sp -D` (duplicate) overwrites it with the
  profile's commandline ([terminal#17481](https://github.com/microsoft/terminal/issues/17481)).
- **Focus-relative addressing only** — you can't target "pane 3 of tab 2 of window X".
- **No reflow of live panes** — open a new layout instead.
- **Quote paths with spaces**; they pass through cmd.exe to wt.
- **WSL**: the `wt` alias isn't on PATH there; the `cmd.exe /d /s /c wt.exe` form
  still works via interop, but **both** the path and the command need translating.
  `-d` needs a Windows path (`wslpath -w "$cwd"`), and the child command is a
  *Windows* process to wt, so a Linux `omp` must be wrapped in `wsl.exe` to run in
  the distro. Per pane, use:
  ```
  cmd.exe /d /s /c wt.exe -w 0 sp -d "$(wslpath -w "$cwd")" wsl.exe -d "$WSL_DISTRO_NAME" --cd "$cwd" -- omp --resume <session>
  ```
  (`wsl.exe --cd` accepts the Linux `$cwd` directly. The `spawn_session_pane`
  tool and the `/fork` auto-pane do this wrapping for you.)

## Safety

These commands spawn processes and rearrange the user's terminal. Confirm before
anything that **closes or replaces live panes**, or that resumes a session that may
already be open elsewhere.
