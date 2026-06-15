/**
 * Windows Terminal integration for oh-my-pi.
 *
 * - Auto-pane on fork: when you run the built-in `/fork`, the session you just
 *   left is reopened in a split pane (`omp --resume <previous>`) so it is not
 *   lost. `/branch` is intentionally NOT hooked — branching is a lightweight
 *   "escape + pick a message" navigation, not something that deserves a new
 *   window. Disable the auto-pane with `OMP_WT_AUTOPANE=0`.
 * - `/wtpane [fork|current]`   open the session in an adjacent split pane.
 * - `/wtwindow [fork|current]` open the session in a new window.
 *     `fork` (default) launches an independent clone (`omp --fork`); `current`
 *     reopens the same session (`omp --resume`) — see the README for the
 *     concurrent-writer caveat.
 * - `spawn_session_pane`       LLM-callable tool: open a fork/resume/new session
 *     in a pane, tab, or window.
 *
 * Requires Windows Terminal (`wt.exe`). All commands and the hook are no-ops
 * outside it (gated on `WT_SESSION`).
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type PaneTarget = "pane" | "tab" | "window";
type SplitDir = "auto" | "vertical" | "horizontal";
type SessionMode = "fork" | "current";

export interface WtPaneOptions {
	/** Where the session opens: split pane, new tab, or new window. */
	target: PaneTarget;
	/** Split direction for `target: "pane"`. "auto" lets WT pick the longest edge. */
	split?: SplitDir;
	/** Starting directory for the new pane (`wt -d`). */
	cwd: string;
	/** Child command line, executable first, e.g. ["omp", "--fork", "/path.jsonl"]. */
	commandline: string[];
}

/**
 * Build the `wt.exe` argument vector for opening `commandline` in a pane/tab/window.
 *
 * `-w 0` targets the most-recently-used (i.e. current) window so panes/tabs land
 * next to this session; `-w new` forces a fresh window. The child command line is
 * appended verbatim after `-d <cwd>`; its leading executable token ends WT's own
 * option parsing, so child flags like `--fork` pass through untouched.
 */
export function buildWtArgs(opts: WtPaneOptions): string[] {
	const args: string[] = ["-w", opts.target === "window" ? "new" : "0"];
	if (opts.target === "pane") {
		args.push("sp");
		if (opts.split === "vertical") args.push("-V");
		else if (opts.split === "horizontal") args.push("-H");
	} else {
		args.push("nt");
	}
	args.push("-d", opts.cwd, ...opts.commandline);
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

/** Executable used to launch the spawned session. Installed users have `omp` on PATH. */
function ompBin(): string {
	return Bun.env.OMP_BIN || "omp";
}

export default function windowsTerminalExtension(pi: ExtensionAPI) {
	const z = pi.zod;

	/**
	 * Launch `commandline` in a Windows Terminal pane/tab/window. Returns a short
	 * human-readable status string; throws on a non-zero `wt.exe` exit.
	 */
	async function openPane(opts: WtPaneOptions): Promise<string> {
		if (!Bun.env.WT_SESSION) {
			throw new Error("Not running inside Windows Terminal (WT_SESSION unset); cannot control panes.");
		}
		const launcher = resolveWtLauncher();
		const result = await pi.exec(launcher.command, [...launcher.prefixArgs, ...buildWtArgs(opts)], {
			cwd: opts.cwd,
		});
		if (result.code !== 0) {
			throw new Error(`wt.exe exited ${result.code}: ${result.stderr.trim() || "unknown error"}`);
		}
		const where = opts.target === "window" ? "new window" : opts.target === "tab" ? "new tab" : "split pane";
		return `Opened ${opts.commandline.includes("--fork") ? "fork" : "session"} in a ${where}.`;
	}

	// `/wtpane` and `/wtwindow` differ only in where the session lands; the
	// `[fork|current]` argument selects an independent clone vs. the same session.
	function openSessionCommand(target: PaneTarget) {
		return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const mode: SessionMode = args.trim().toLowerCase() === "current" ? "current" : "fork";
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No persisted session (running with --no-session?).", "warning");
				return;
			}
			const commandline = [ompBin(), mode === "fork" ? "--fork" : "--resume", sessionFile];
			try {
				ctx.ui.notify(await openPane({ target, split: "auto", cwd: ctx.cwd, commandline }), "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		};
	}

	pi.registerCommand("wtpane", {
		description: "Open this session in a Windows Terminal split pane ([fork|current], default fork)",
		handler: openSessionCommand("pane"),
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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { mode, target, split, session } = params;
			let commandline: string[];
			if (mode === "fork") {
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					return { isError: true, content: [{ type: "text", text: "No persisted session to fork." }] };
				}
				commandline = [ompBin(), "--fork", sessionFile];
			} else if (mode === "resume") {
				if (!session) {
					return {
						isError: true,
						content: [{ type: "text", text: "mode 'resume' requires a `session` id/prefix." }],
					};
				}
				commandline = [ompBin(), "--resume", session];
			} else {
				commandline = [ompBin()];
			}
			try {
				return {
					content: [{ type: "text", text: await openPane({ target, split, cwd: ctx.cwd, commandline }) }],
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
				commandline: [ompBin(), "--resume", event.previousSessionFile],
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
