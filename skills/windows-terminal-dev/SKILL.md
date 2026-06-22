---
name: windows-terminal-dev
description: Develop and ship changes to this oh-my-pi Windows Terminal extension (omp-windows-terminal) itself — the build/test gates, the type-only host API, the wt.exe-via-cmd.exe launch and how to verify argv quoting, the even-split layout math, and breadcrumb-based session discovery. Use when editing src/windows-terminal.ts, its tests, the README, or the bundled skills. For merely USING wt.exe to arrange sessions, see the sibling windows-terminal-control skill instead.
---

# Developing omp-windows-terminal

Contributor guide for hacking on this extension. To *use* `wt.exe` for layouts at
runtime, use the sibling **`windows-terminal-control`** skill instead.

## Layout & gates

- One module: `src/windows-terminal.ts`; tests in `test/windows-terminal.test.ts`.
- **No build step** — oh-my-pi loads the `.ts` directly on Bun.
- `@oh-my-pi/pi-coding-agent` is a **type-only** dependency, provided by the host
  at load time. NEVER import its runtime functions into the extension — keep new
  code on `node:fs` / `os` / `path` + `Bun.*`. Its types live at
  `node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts`
  (`ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `ToolDefinition`).
- Gates before any PR: `bun test` **and** `bun run check` (`tsc --noEmit`). CI runs
  both on push/PR (`.github/workflows/ci.yml`).
- Style: don't extract one-expression / single-call-site helpers — inline them.

## wt.exe is the whole mechanic

- `wt.exe` is a Windows App Execution Alias; a direct spawn fails "Executable not
  found in $PATH". Always route through `cmd.exe /d /s /c wt.exe …`
  (`resolveWtLauncher`). Works on native Windows and under WSL.
- Under WSL, translate `-d` to a Windows path (`wslpath -w`) and wrap the child in
  `wsl.exe -d <distro> --cd <cwd> -- …` (`adaptPaneOptionsForHost` /
  `adaptLayoutPaneForHost`); native Windows is identity.
- Multi-pane layouts chain actions with a standalone `;` argv token (WT's command
  delimiter). It survives the cmd.exe argv path — but **verify argv quoting
  empirically** whenever you touch the chaining:
  1. Round-trip probe — spawn `cmd.exe /d /s /c <prog> …args` where `<prog>` prints
     `JSON.stringify(process.argv.slice(2))`; confirm `;` arrives as its own element.
  2. Real E2E — run the actual builder output through the launcher with
     self-closing marker panes (`cmd /c copy nul <dir>\mN.txt` — avoid `>`, the
     outer cmd would eat it) in a `-w new` window, then assert every marker exists.
- `sp`/`nt` accept `-p <profile>`, `--title <t>`, `-d <cwd>`; `sp` also `-s <0..1>`
  size. Even N-column sizing (`buildLayoutArgs`): at split k (1-based) give the new
  pane `(n-k)/(n-k+1)` of the focused pane, so all panes end up `1/n` wide in input
  order.

## Session discovery (plugin-agnostic)

oh-my-pi **core** (NOT this extension) writes a breadcrumb per terminal at
`<agentDir>/terminal-sessions/<id>` — two lines: cwd, then session `.jsonl` path —
so `discoverTerminalSessions` is agnostic to how a session launched. But core
writes one ONLY for a **persisted** session in an **identifiable terminal**: on
Windows that's Windows Terminal (`WT_SESSION` set) or a multiplexer
(tmux/zellij/kitty/wezterm) — a plain cmd/PowerShell/conhost console sets no
`WT_SESSION` and gets no breadcrumb. `/tan` named forks are suppressed, and only
the LATEST session per terminal is kept (older `.jsonl`s survive under
`<agent>/sessions/`).
The current Windows Terminal's file is `wt-$WT_SESSION`. `agentDir`
= `PI_CODING_AGENT_DIR` if set, else `<home>/<PI_CONFIG_DIR|".omp">/agent` (+
`profiles/<OMP_PROFILE>` when a profile is active). A breadcrumb is "last seen",
NOT a liveness signal — resuming a session that is live elsewhere means two writers
on one session file.

For the sessions breadcrumbs miss, `scanStoredSessions` walks
`<agentDir>/sessions/<project>/*.jsonl` and recovers `{ id, cwd, title }` from each
file's first-line header (`{ type:"session", … }`), reading only a bounded slice
(not whole files). `list_omp_sessions source:"all"` surfaces these, and
`arrange_sessions` uses it to recover the cwd of explicitly-named breadcrumb-less
sessions. Cost: no "current" flag and a full directory walk, so it's opt-in.

## Shipping

- If `git push` returns 403 because a *second* logged-in `gh` account is selected
  by the credential helper, push with the active account's token by overriding the
  helper for one push:
  `git -c credential.helper= -c credential.helper='!f() { echo username=<repo-owner>; echo "password=$(gh auth token)"; }; f' push -u origin <branch>`.
  Then `gh pr create` works (it uses the active `gh` account).
- After pushing, confirm CI is green: `gh run list --branch <branch>`.
