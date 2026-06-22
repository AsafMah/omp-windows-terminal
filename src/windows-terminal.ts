/**
 * Windows Terminal integration for oh-my-pi.
 *
 * - Auto-pane on fork: when you run the built-in `/fork`, the session you just
 *   left is reopened in a split pane (`omp --resume <previous>`) so it is not
 *   lost. `/branch` is intentionally NOT hooked — branching is a lightweight
 *   "escape + pick a message" navigation, not something that deserves a new
 *   window. Disable the auto-pane with `OMP_WT_AUTOPANE=0`.
 * - `/wtpane [fork|current] [vertical|horizontal]`  open the session in a split pane.
 * - `/wttab [fork|current]`    open the session in a new tab.
 * - `/wtwindow [fork|current]` open the session in a new window.
 *     `fork` (default) launches an independent clone (`omp --fork`); `current`
 *     reopens the same session (`omp --resume`) — see the README for the
 *     concurrent-writer caveat.
 * - `spawn_session_pane`       LLM-callable tool: open a fork/resume/new session
 *     in a pane, tab, or window (optional title/profile).
 * - `list_omp_sessions`        LLM-callable tool: list recent terminals (incl.
 *     ones this extension did not start) from the core breadcrumb registry.
 * - `arrange_sessions`         LLM-callable tool: open several sessions arranged
 *     in an even columns/rows layout, each in its recorded directory.
 *
 * Requires Windows Terminal (`wt.exe`); all commands and the hook are no-ops
 * outside it (gated on `WT_SESSION`). Works on native Windows and under WSL —
 * WSL launches translate the `-d` start directory to a Windows path and wrap the
 * child command in `wsl.exe` so the Linux `omp` runs in the right distro/dir.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type PaneTarget = "pane" | "tab" | "window";
type SplitDir = "auto" | "vertical" | "horizontal";
type SessionMode = "fork" | "current";

export interface WtPaneOptions {
	/** Where the session opens: split pane, new tab, or new window. */
	target: PaneTarget;
	/** Split direction for `target: "pane"`. "auto" lets WT pick the longest edge. */
	split?: SplitDir;
	/** Pane split size as a fraction in (0,1) (`wt sp -s`). Ignored for tab/window. */
	size?: number;
	/** Starting directory for the new pane (`wt -d`). Omitted from the args when unset — e.g. WSL path translation was unavailable — letting WT use its default. */
	cwd?: string;
	/** Pane/tab title (`wt --title`). */
	title?: string;
	/** Windows Terminal profile to launch the pane with (`wt -p`). */
	profile?: string;
	/** Child command line, executable first, e.g. ["omp", "--fork", "/path.jsonl"]. */
	commandline: string[];
}

/** wt accepts a 0<size<1 split fraction; trim to 4 decimals for stable, predictable args. */
function formatSize(size: number): string {
	return String(Number(size.toFixed(4)));
}

/**
 * Emit the option + command tail shared by `nt` (new-tab) and `sp` (split-pane):
 * `[-p <profile>] [--title <title>] [-d <cwd>] <command…>`. The leading executable
 * token of the command ends WT's own option parsing, so child flags pass through.
 */
function paneTailArgs(pane: Pick<WtPaneOptions, "profile" | "title" | "cwd" | "commandline">): string[] {
	const tail: string[] = [];
	if (pane.profile) tail.push("-p", pane.profile);
	if (pane.title) tail.push("--title", pane.title);
	if (pane.cwd) tail.push("-d", pane.cwd);
	tail.push(...pane.commandline);
	return tail;
}

/**
 * Build the `wt.exe` argument vector for opening `commandline` in a pane/tab/window.
 *
 * `-w 0` targets the most-recently-used (i.e. current) window so panes/tabs land
 * next to this session; `-w new` forces a fresh window. The child command line is
 * appended verbatim after the pane options; its leading executable token ends WT's
 * own option parsing, so child flags like `--fork` pass through untouched.
 */
export function buildWtArgs(opts: WtPaneOptions): string[] {
	const args: string[] = ["-w", opts.target === "window" ? "new" : "0"];
	if (opts.target === "pane") {
		args.push("sp");
		if (opts.split === "vertical") args.push("-V");
		else if (opts.split === "horizontal") args.push("-H");
		if (opts.size !== undefined) args.push("-s", formatSize(opts.size));
	} else {
		args.push("nt");
	}
	args.push(...paneTailArgs(opts));
	return args;
}

export type LayoutKind = "columns" | "rows";

/** One pane in a multi-session layout. */
export interface LayoutPane {
	/** Starting directory for the pane (`wt -d`); omitted when unset. */
	cwd?: string;
	/** Pane title (`wt --title`). */
	title?: string;
	/** Windows Terminal profile (`wt -p`). */
	profile?: string;
	/** Child command line, executable first. */
	commandline: string[];
}

export interface LayoutOptions {
	/** "columns" = side by side (vertical splits); "rows" = stacked (horizontal splits). */
	layout: LayoutKind;
	/** Target window: a fresh window (typical for layouts) or the current one. */
	window: "new" | "current";
}

/**
 * Build ONE chained `wt.exe` argv that opens every pane in a single window,
 * evenly sized and in input order. The first pane is a new tab (`nt`); each
 * subsequent pane splits the previously-added pane (`sp -V` for columns, `-H` for
 * rows), peeling an even slice so all panes end up the same size. Actions are
 * joined by a standalone `;` token — Windows Terminal's command delimiter, which
 * survives the `cmd.exe /d /s /c wt.exe` argv path verbatim (verified end-to-end).
 *
 * Sizing: at split k (1-based) the focused pane is the previous pane, currently
 * holding `(n-k+1)/n` of the row; giving the new pane `(n-k)/(n-k+1)` of it leaves
 * the old pane an exact `1/n` slice and the new pane `(n-k)/n` to keep splitting.
 */
export function buildLayoutArgs(panes: LayoutPane[], opts: LayoutOptions): string[] {
	if (panes.length === 0) throw new Error("buildLayoutArgs requires at least one pane");
	const args: string[] = ["-w", opts.window === "new" ? "new" : "0", "nt", ...paneTailArgs(panes[0])];
	const splitFlag = opts.layout === "rows" ? "-H" : "-V";
	const n = panes.length;
	for (let k = 1; k < n; k++) {
		const size = (n - k) / (n - k + 1);
		args.push(";", "sp", splitFlag, "-s", formatSize(size), ...paneTailArgs(panes[k]));
	}
	return args;
}

export interface WtLauncher {
	command: string;
	prefixArgs: string[];
}

/**
 * Resolve how to invoke `wt.exe`.
 *
 * `wt.exe` is a Windows App Execution Alias — a 0-byte reparse stub in
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`. Bun/ptree's PATH resolver returns
 * `null` for it (and CreateProcess-style spawns reject the stub), so a direct
 * `pi.exec("wt.exe", …)` fails with "Executable not found in $PATH". `cmd.exe`
 * resolves the alias natively, so route through `cmd.exe /d /s /c wt.exe …`
 * (`/d` skips AutoRun, `/s` keeps quote handling predictable, `/c` run-and-exit)
 * on Windows and under WSL alike. Callers gate on `WT_SESSION` first, so cmd.exe
 * is always present by the time we get here.
 */
export function resolveWtLauncher(): WtLauncher {
	return { command: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "wt.exe"] };
}

/** Translate a POSIX path to its Windows form via `wslpath -w`. Returns undefined when interop is unavailable or the path can't be mapped, so callers omit `-d` rather than feed wt.exe a path it can't use. */
function wslpathToWindows(posixPath: string): string | undefined {
	const result = Bun.spawnSync(["wslpath", "-w", posixPath], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) return undefined;
	const win = new TextDecoder().decode(result.stdout).trim();
	return win.length > 0 ? win : undefined;
}

/**
 * Wrap a child command so it runs inside the current WSL distro:
 * `wsl.exe -d <distro> --cd <cwd> -- <command>`. wt.exe launches this as a
 * Windows process and `wsl.exe` re-enters Linux to run the real `omp` in `cwd`
 * (a POSIX path, which `--cd` accepts) instead of a Windows `omp` in the wrong
 * directory. `--cd` is dropped when `cwd` is unknown.
 */
export function wslWrapCommandline(commandline: string[], distro: string, cwd?: string): string[] {
	const wrapped = ["wsl.exe", "-d", distro];
	if (cwd) wrapped.push("--cd", cwd);
	wrapped.push("--", ...commandline);
	return wrapped;
}

/**
 * Adapt pane options for the host. Native Windows is identity. Under WSL,
 * `WT_SESSION` is inherited but `cwd`/`commandline` are POSIX while wt.exe is a
 * Windows program, so translate the `-d` start directory to a Windows path and
 * run the child through `wsl.exe`. `host` is injectable for tests; in production
 * the distro comes from `WSL_DISTRO_NAME` and translation from `wslpath`.
 */
export function adaptPaneOptionsForHost(
	opts: WtPaneOptions,
	host?: { wslDistro?: string; toWindowsPath?: (posixPath: string) => string | undefined },
): WtPaneOptions {
	let distro: string | undefined;
	if (host) distro = host.wslDistro;
	else if (process.platform === "linux") distro = Bun.env.WSL_DISTRO_NAME;
	if (!distro) return opts;
	const toWindowsPath = host?.toWindowsPath ?? wslpathToWindows;
	return {
		...opts,
		cwd: opts.cwd ? toWindowsPath(opts.cwd) : undefined,
		commandline: wslWrapCommandline(opts.commandline, distro, opts.cwd),
	};
}

/** Adapt a layout pane for the host, reusing the same WSL translation as single panes. */
export function adaptLayoutPaneForHost(
	pane: LayoutPane,
	host?: { wslDistro?: string; toWindowsPath?: (posixPath: string) => string | undefined },
): LayoutPane {
	const adapted = adaptPaneOptionsForHost({ target: "pane", cwd: pane.cwd, commandline: pane.commandline }, host);
	return { ...pane, cwd: adapted.cwd, commandline: adapted.commandline };
}

/**
 * Executable tokens used to launch the spawned session. Installed users have
 * `omp` on PATH. `OMP_BIN` may carry arguments (e.g. `wt-omp --foo`); it is split
 * on whitespace so each token is its own argv element rather than one fused word.
 */
function ompLauncher(): string[] {
	const tokens = (Bun.env.OMP_BIN || "omp").trim().split(/\s+/).filter(Boolean);
	return tokens.length > 0 ? tokens : ["omp"];
}

// ============================================================================
// Session discovery (plugin-agnostic, from the core breadcrumb registry)
// ============================================================================

/** A recent oh-my-pi terminal, recovered from a `<agent>/terminal-sessions/*` breadcrumb. */
export interface TerminalSession {
	/** Breadcrumb filename, e.g. "wt-<guid>" (Windows Terminal) or "tmux-%1". */
	terminalId: string;
	/** Working directory recorded for the terminal (breadcrumb line 1). */
	cwd: string;
	/** Session .jsonl path the terminal last had open (breadcrumb line 2). */
	sessionFile: string;
	/** Breadcrumb modification time (ms). A recency proxy — NOT proof the session is live. */
	mtimeMs: number;
	/** True when this breadcrumb belongs to the current terminal (`wt-$WT_SESSION`). */
	current: boolean;
}

/**
 * Resolve the agent directory (`~/.omp/agent` by default). Honors an explicit
 * `PI_CODING_AGENT_DIR` (authoritative — oh-my-pi sets it after resolving
 * profiles/XDG), else falls back to `<home>/<PI_CONFIG_DIR|".omp">/agent`, with a
 * `profiles/<name>` segment when `OMP_PROFILE`/`PI_PROFILE` is active.
 */
function agentDir(): string {
	const override = Bun.env.PI_CODING_AGENT_DIR;
	if (override) return override;
	const configDir = Bun.env.PI_CONFIG_DIR || ".omp";
	const profileRaw = (Bun.env.OMP_PROFILE ?? Bun.env.PI_PROFILE ?? "").trim();
	const profile = profileRaw && profileRaw !== "default" ? profileRaw : undefined;
	const root = path.join(os.homedir(), configDir);
	return profile ? path.join(root, "profiles", profile, "agent") : path.join(root, "agent");
}

/**
 * Discover recent oh-my-pi terminals from the core breadcrumb registry
 * (`<agent>/terminal-sessions/*`). Each breadcrumb is two lines — cwd, then
 * session file — written by oh-my-pi core (NOT this extension), so discovery is
 * agnostic to whether the plugin started the session. Newest first; the current
 * terminal is flagged so callers can exclude it.
 *
 * Coverage: core writes a breadcrumb only for a PERSISTED session (not
 * `--no-session`) in an IDENTIFIABLE terminal — on Windows that means Windows
 * Terminal (`WT_SESSION` set) or a multiplexer (tmux/zellij/kitty/wezterm); a
 * plain cmd/PowerShell/conhost console sets no `WT_SESSION` and gets no
 * breadcrumb. `/tan` named subagent forks are suppressed, and only the LATEST
 * session per terminal is kept (older ones are overwritten — their `.jsonl` still
 * lives under `<agent>/sessions/`). A breadcrumb is a "last seen" marker, not a
 * liveness signal — resuming one that is live elsewhere risks two writers on a
 * session file.
 */
export async function discoverTerminalSessions(): Promise<TerminalSession[]> {
	const dir = path.join(agentDir(), "terminal-sessions");
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	// Current Windows Terminal's breadcrumb is `wt-$WT_SESSION`; used to flag/exclude self.
	const curId = Bun.env.WT_SESSION ? `wt-${Bun.env.WT_SESSION}` : undefined;
	const out: TerminalSession[] = [];
	await Promise.all(
		names.map(async (name) => {
			const file = path.join(dir, name);
			try {
				const stat = await fs.stat(file);
				if (!stat.isFile()) return;
				const content = await fs.readFile(file, "utf8");
				const lines = content.split(/\r?\n/);
				const cwd = (lines[0] ?? "").trim();
				const sessionFile = (lines[1] ?? "").trim();
				if (!sessionFile) return;
				out.push({ terminalId: name, cwd, sessionFile, mtimeMs: stat.mtimeMs, current: name === curId });
			} catch {
				// Unreadable or partially-written breadcrumb — skip it.
			}
		}),
	);
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

/** Human-readable "N{s,m,h,d} ago" from an mtime in ms. */
function formatAge(mtimeMs: number): string {
	const sec = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));
	if (sec < 60) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.round(hr / 24)}d ago`;
}

/** Two-line, agent-readable rendering of one discovered session. */
function formatSessionLine(s: TerminalSession): string {
	const marker = s.current ? "  (current)" : "";
	return `• ${formatAge(s.mtimeMs).padEnd(8)} ${s.cwd || "(unknown cwd)"}${marker}\n    ${s.sessionFile}`;
}

/** A short pane label, preferring the project (cwd) basename over the opaque session filename. */
function paneTitle(cwd: string | undefined, sessionRef: string): string {
	if (cwd) {
		const base = path.basename(cwd.replace(/[\\/]+$/, ""));
		if (base) return base;
	}
	return path.basename(sessionRef).replace(/\.jsonl$/i, "").slice(0, 24) || "omp";
}

export default function windowsTerminalExtension(pi: ExtensionAPI) {
	const z = pi.zod;

	/**
	 * Gate on Windows Terminal, then run `wt.exe` with `wtArgs` via the cmd.exe
	 * launcher. `execCwd` is the spawn's working directory (the original, possibly
	 * Linux-under-WSL, path). Throws on a non-zero `wt.exe` exit.
	 */
	async function runWt(wtArgs: string[], execCwd?: string): Promise<void> {
		if (!Bun.env.WT_SESSION) {
			throw new Error("Not running inside Windows Terminal (WT_SESSION unset); cannot control panes.");
		}
		const launcher = resolveWtLauncher();
		const result = await pi.exec(launcher.command, [...launcher.prefixArgs, ...wtArgs], { cwd: execCwd });
		if (result.code !== 0) {
			throw new Error(`wt.exe exited ${result.code}: ${result.stderr.trim() || "unknown error"}`);
		}
	}

	/**
	 * Launch `commandline` in a Windows Terminal pane/tab/window. Returns a short
	 * human-readable status string; throws on a non-zero `wt.exe` exit.
	 */
	async function openPane(opts: WtPaneOptions): Promise<string> {
		// Native Windows: identity. WSL: `-d` becomes a Windows path and the child
		// is wrapped in `wsl.exe`. The exec cwd stays the original (Linux under WSL)
		// path — the spawn chdirs in Linux before interop launches cmd.exe.
		await runWt(buildWtArgs(adaptPaneOptionsForHost(opts)), opts.cwd);
		const where = opts.target === "window" ? "new window" : opts.target === "tab" ? "new tab" : "split pane";
		return `Opened ${opts.commandline.includes("--fork") ? "fork" : "session"} in a ${where}.`;
	}

	// `/wtpane`, `/wttab`, and `/wtwindow` differ only in where the session lands;
	// the `[fork|current]` argument selects an independent clone vs. the same
	// session, and (panes only) `[vertical|horizontal]` picks the split direction.
	function openSessionCommand(target: PaneTarget) {
		return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const mode: SessionMode = tokens.includes("current") ? "current" : "fork";
			const split: SplitDir = tokens.includes("vertical")
				? "vertical"
				: tokens.includes("horizontal")
					? "horizontal"
					: "auto";
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No persisted session (running with --no-session?).", "warning");
				return;
			}
			const commandline = [...ompLauncher(), mode === "fork" ? "--fork" : "--resume", sessionFile];
			try {
				ctx.ui.notify(await openPane({ target, split, cwd: ctx.cwd, commandline }), "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		};
	}

	pi.registerCommand("wtpane", {
		description:
			"Open this session in a Windows Terminal split pane ([fork|current] [vertical|horizontal], default fork auto)",
		handler: openSessionCommand("pane"),
	});

	pi.registerCommand("wttab", {
		description: "Open this session in a Windows Terminal tab ([fork|current], default fork)",
		handler: openSessionCommand("tab"),
	});

	pi.registerCommand("wtwindow", {
		description: "Open this session in a new Windows Terminal window ([fork|current], default fork)",
		handler: openSessionCommand("window"),
	});

	pi.registerTool({
		name: "spawn_session_pane",
		label: "Spawn Session Pane",
		description:
			"Open an oh-my-pi session in a Windows Terminal pane, tab, or window. " +
			"Use mode 'fork' to clone the current conversation into an independent copy, " +
			"'resume' to reopen an existing session by id/prefix, or 'new' for a fresh session.",
		approval: "exec",
		parameters: z.object({
			mode: z
				.enum(["fork", "resume", "new"])
				.default("fork")
				.describe("fork = clone current session; resume = reopen existing; new = fresh session"),
			target: z.enum(["pane", "tab", "window"]).default("pane").describe("Where to open the session"),
			split: z
				.enum(["auto", "vertical", "horizontal"])
				.default("auto")
				.describe("Split direction when target is 'pane'"),
			session: z
				.string()
				.optional()
				.describe("Session id/prefix/path for mode 'resume' (ignored otherwise)"),
			title: z.string().optional().describe("Optional pane/tab title"),
			profile: z.string().optional().describe("Optional Windows Terminal profile name"),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { mode, target, split, session, title, profile } = params;
			let commandline: string[];
			if (mode === "fork") {
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					return { isError: true, content: [{ type: "text", text: "No persisted session to fork." }] };
				}
				commandline = [...ompLauncher(), "--fork", sessionFile];
			} else if (mode === "resume") {
				if (!session) {
					return {
						isError: true,
						content: [{ type: "text", text: "mode 'resume' requires a `session` id/prefix." }],
					};
				}
				commandline = [...ompLauncher(), "--resume", session];
			} else {
				commandline = ompLauncher();
			}
			try {
				return {
					content: [
						{ type: "text", text: await openPane({ target, split, cwd: ctx.cwd, commandline, title, profile }) },
					],
				};
			} catch (err) {
				return {
					isError: true,
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
				};
			}
		},
	});

	pi.registerTool({
		name: "list_omp_sessions",
		label: "List OMP Sessions",
		description:
			"List recent oh-my-pi terminal sessions from the core breadcrumb registry " +
			"(~/.omp/agent/terminal-sessions), newest first — INCLUDING sessions this extension did not start. " +
			"Each entry has the recorded working directory and session file. Use to pick sessions to resume or " +
			"arrange. Coverage is partial: only PERSISTED sessions run in an identifiable terminal (Windows " +
			"Terminal with WT_SESSION set, or a tmux/zellij/kitty/wezterm multiplexer) leave a breadcrumb — a " +
			"plain cmd/PowerShell console does not — and only the latest session per terminal is kept. Recency " +
			"is a 'last seen' proxy, not proof a session is still open.",
		approval: "read",
		parameters: z.object({
			limit: z.number().int().min(1).max(100).default(20).describe("Max sessions to list"),
			includeCurrent: z
				.boolean()
				.default(false)
				.describe("Include the current terminal's own session in the list"),
		}),
		async execute(_toolCallId, params) {
			const { limit, includeCurrent } = params;
			let sessions = await discoverTerminalSessions();
			if (!includeCurrent) sessions = sessions.filter((s) => !s.current);
			sessions = sessions.slice(0, limit);
			if (sessions.length === 0) {
				return { content: [{ type: "text", text: "No oh-my-pi terminal sessions found." }] };
			}
			return { content: [{ type: "text", text: sessions.map(formatSessionLine).join("\n") }] };
		},
	});

	pi.registerTool({
		name: "arrange_sessions",
		label: "Arrange Sessions",
		description:
			"Open several oh-my-pi sessions arranged together in one Windows Terminal window — evenly sized " +
			"columns (side by side) or rows (stacked), each resumed in its recorded working directory. " +
			"Pass `sessions` (ids/prefixes/paths, in order) to choose them, or omit it to auto-pick the most " +
			"recent terminals. Discovers sessions started outside this extension via the breadcrumb registry. " +
			"Opens a NEW arranged layout of resumable sessions; it cannot move or reflow already-running panes. " +
			"Resuming a session that is live in another terminal risks two concurrent writers.",
		approval: "exec",
		parameters: z.object({
			sessions: z
				.array(z.string())
				.optional()
				.describe("Session ids/prefixes/paths to arrange, in order. Omit to auto-pick recent terminals."),
			layout: z
				.enum(["columns", "rows"])
				.default("columns")
				.describe("columns = side by side; rows = stacked vertically"),
			count: z
				.number()
				.int()
				.min(1)
				.max(8)
				.default(4)
				.describe("How many recent sessions to arrange when `sessions` is omitted"),
			window: z
				.enum(["new", "current"])
				.default("new")
				.describe("Open the layout in a new window or split the current one"),
			includeCurrent: z
				.boolean()
				.default(false)
				.describe("Include the current terminal's own session when auto-picking"),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { sessions: refs, layout, count, window, includeCurrent } = params;
			const discovered = await discoverTerminalSessions();
			const pool = includeCurrent ? discovered : discovered.filter((s) => !s.current);

			let chosen: LayoutPane[];
			if (refs && refs.length > 0) {
				chosen = refs.map((ref) => {
					const match =
						pool.find((s) => s.sessionFile === ref) ??
						pool.find((s) => path.basename(s.sessionFile).startsWith(ref)) ??
						pool.find((s) => s.sessionFile.includes(ref));
					const cwd = match?.cwd || undefined;
					const sessionRef = match?.sessionFile ?? ref;
					return {
						cwd,
						title: paneTitle(cwd, sessionRef),
						commandline: [...ompLauncher(), "--resume", sessionRef],
					};
				});
			} else {
				chosen = pool.slice(0, count).map((s) => ({
					cwd: s.cwd || undefined,
					title: paneTitle(s.cwd, s.sessionFile),
					commandline: [...ompLauncher(), "--resume", s.sessionFile],
				}));
			}

			if (chosen.length === 0) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "No sessions to arrange. None found in the breadcrumb registry — pass `sessions` explicitly.",
						},
					],
				};
			}

			try {
				const adapted = chosen.map((p) => adaptLayoutPaneForHost(p));
				await runWt(buildLayoutArgs(adapted, { layout, window }), ctx.cwd);
				const noun = chosen.length === 1 ? "session" : "sessions";
				const where = window === "new" ? "a new window" : "the current window";
				return {
					content: [{ type: "text", text: `Arranged ${chosen.length} ${noun} in ${where} (${layout}).` }],
				};
			} catch (err) {
				return {
					isError: true,
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
				};
			}
		},
	});

	// Auto-pane on fork: `/fork` moves THIS pane onto the new clone and emits
	// `session_switch(reason:"fork", previousSessionFile)`. Reopen the session
	// being left in a split pane so it stays visible. `/branch` is deliberately
	// not handled. Gated to Windows Terminal and OMP_WT_AUTOPANE != "0".
	const autoPaneEnabled = Boolean(Bun.env.WT_SESSION) && Bun.env.OMP_WT_AUTOPANE !== "0";

	pi.on("session_switch", async (event, ctx: ExtensionContext) => {
		if (!autoPaneEnabled || event.reason !== "fork" || !event.previousSessionFile) return;
		try {
			await openPane({
				target: "pane",
				split: "auto",
				cwd: ctx.cwd,
				commandline: [...ompLauncher(), "--resume", event.previousSessionFile],
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			pi.logger.debug("wt auto-pane failed", { err: message });
			// Surface it: a silent debug log left "/fork did nothing" indistinguishable
			// from success. A warning tells the user why no pane appeared.
			if (ctx.hasUI) ctx.ui.notify(`Auto-pane on fork failed: ${message}`, "warning");
		}
	});
}
