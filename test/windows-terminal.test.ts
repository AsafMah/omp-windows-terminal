import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	adaptLayoutPaneForHost,
	adaptPaneOptionsForHost,
	buildLayoutArgs,
	buildWtArgs,
	discoverTerminalSessions,
	resolveWtLauncher,
	scanStoredSessions,
	wslWrapCommandline,
} from "../src/windows-terminal";

describe("buildWtArgs", () => {
	const cmd = ["omp", "--resume", "/s.jsonl"];

	it("targets the current window and auto-splits a pane", () => {
		expect(buildWtArgs({ target: "pane", split: "auto", cwd: "/proj", commandline: cmd })).toEqual([
			"-w",
			"0",
			"sp",
			"-d",
			"/proj",
			"omp",
			"--resume",
			"/s.jsonl",
		]);
	});

	it("emits the split-direction flag before -d", () => {
		expect(buildWtArgs({ target: "pane", split: "vertical", cwd: "/proj", commandline: cmd })).toEqual([
			"-w",
			"0",
			"sp",
			"-V",
			"-d",
			"/proj",
			"omp",
			"--resume",
			"/s.jsonl",
		]);
		expect(buildWtArgs({ target: "pane", split: "horizontal", cwd: "/proj", commandline: cmd })).toContain("-H");
	});

	it("uses new-tab in the current window for target 'tab'", () => {
		expect(buildWtArgs({ target: "tab", cwd: "/proj", commandline: cmd })).toEqual([
			"-w",
			"0",
			"nt",
			"-d",
			"/proj",
			"omp",
			"--resume",
			"/s.jsonl",
		]);
	});

	it("forces a new window for target 'window'", () => {
		expect(buildWtArgs({ target: "window", cwd: "/proj", commandline: cmd })).toEqual([
			"-w",
			"new",
			"nt",
			"-d",
			"/proj",
			"omp",
			"--resume",
			"/s.jsonl",
		]);
	});

	it("appends the child command line verbatim after the starting directory", () => {
		const args = buildWtArgs({ target: "pane", cwd: "/a b", commandline: ["omp", "--fork", "/x;y.jsonl"] });
		expect(args.slice(args.indexOf("-d"))).toEqual(["-d", "/a b", "omp", "--fork", "/x;y.jsonl"]);
	});

	it("omits -d when cwd is unset (WSL path translation unavailable)", () => {
		const args = buildWtArgs({ target: "pane", commandline: ["omp", "--resume", "/s.jsonl"] });
		expect(args).not.toContain("-d");
		expect(args).toEqual(["-w", "0", "sp", "omp", "--resume", "/s.jsonl"]);
	});
});

describe("resolveWtLauncher", () => {
	it("routes through cmd.exe because wt.exe is an unresolvable App Execution Alias", () => {
		// Bun/ptree can't resolve the wt.exe alias stub, so it must be launched via
		// cmd.exe, which resolves the alias natively.
		expect(resolveWtLauncher()).toEqual({ command: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "wt.exe"] });
	});
});

describe("wslWrapCommandline", () => {
	it("wraps the child in `wsl.exe -d <distro> --cd <cwd> -- ...`", () => {
		expect(wslWrapCommandline(["omp", "--resume", "/s.jsonl"], "Ubuntu", "/proj")).toEqual([
			"wsl.exe",
			"-d",
			"Ubuntu",
			"--cd",
			"/proj",
			"--",
			"omp",
			"--resume",
			"/s.jsonl",
		]);
	});

	it("drops --cd when cwd is unknown", () => {
		expect(wslWrapCommandline(["omp"], "Ubuntu")).toEqual(["wsl.exe", "-d", "Ubuntu", "--", "omp"]);
	});
});

describe("adaptPaneOptionsForHost", () => {
	const base = { target: "pane" as const, split: "auto" as const, cwd: "/proj", commandline: ["omp", "--resume", "/s.jsonl"] };

	it("is identity on a non-WSL host", () => {
		expect(adaptPaneOptionsForHost(base, { wslDistro: undefined })).toBe(base);
	});

	it("translates cwd to a Windows path and wraps the child under WSL", () => {
		const adapted = adaptPaneOptionsForHost(base, { wslDistro: "Ubuntu", toWindowsPath: () => "C:\\proj" });
		expect(adapted.cwd).toBe("C:\\proj");
		// `-d` gets the Windows path; the child stays a Linux command via wsl.exe --cd.
		expect(adapted.commandline).toEqual(["wsl.exe", "-d", "Ubuntu", "--cd", "/proj", "--", "omp", "--resume", "/s.jsonl"]);
		// End to end: wt.exe receives a valid Windows -d and a wsl.exe child.
		expect(buildWtArgs(adapted)).toEqual(["-w", "0", "sp", "-d", "C:\\proj", "wsl.exe", "-d", "Ubuntu", "--cd", "/proj", "--", "omp", "--resume", "/s.jsonl"]);
	});

	it("drops -d but still wraps the child when wslpath translation fails", () => {
		const adapted = adaptPaneOptionsForHost(base, { wslDistro: "Ubuntu", toWindowsPath: () => undefined });
		expect(adapted.cwd).toBeUndefined();
		// No wt-level `-d <cwd>` precedes the command — it goes straight to the
		// wsl.exe child (whose own `-d` selects the distro). wsl.exe --cd still sets
		// the working directory, so the session lands in the right place.
		expect(buildWtArgs(adapted)).toEqual([
			"-w",
			"0",
			"sp",
			"wsl.exe",
			"-d",
			"Ubuntu",
			"--cd",
			"/proj",
			"--",
			"omp",
			"--resume",
			"/s.jsonl",
		]);
	});
});

describe("buildWtArgs options", () => {
	it("emits -s, -p, and --title before -d in a pane", () => {
		expect(
			buildWtArgs({
				target: "pane",
				split: "vertical",
				size: 0.3,
				profile: "Ubuntu",
				title: "work",
				cwd: "/p",
				commandline: ["omp"],
			}),
		).toEqual(["-w", "0", "sp", "-V", "-s", "0.3", "-p", "Ubuntu", "--title", "work", "-d", "/p", "omp"]);
	});

	it("omits the pane-only -s for a tab but still emits --title", () => {
		const args = buildWtArgs({ target: "tab", size: 0.5, title: "t", cwd: "/p", commandline: ["omp"] });
		expect(args).not.toContain("-s");
		expect(args.slice(args.indexOf("nt"))).toEqual(["nt", "--title", "t", "-d", "/p", "omp"]);
	});
});

describe("buildLayoutArgs", () => {
	const pane = (n: string) => ({ cwd: `C:\\${n}`, title: n, commandline: ["omp", "--resume", `${n}.jsonl`] });

	it("opens a single pane as a new tab with no splits", () => {
		expect(buildLayoutArgs([pane("a")], { layout: "columns", window: "new" })).toEqual([
			"-w", "new", "nt", "--title", "a", "-d", "C:\\a", "omp", "--resume", "a.jsonl",
		]);
	});

	it("chains even vertical splits for columns, in order, with ; delimiters", () => {
		expect(buildLayoutArgs([pane("a"), pane("b"), pane("c")], { layout: "columns", window: "new" })).toEqual([
			"-w", "new", "nt", "--title", "a", "-d", "C:\\a", "omp", "--resume", "a.jsonl",
			";", "sp", "-V", "-s", "0.6667", "--title", "b", "-d", "C:\\b", "omp", "--resume", "b.jsonl",
			";", "sp", "-V", "-s", "0.5", "--title", "c", "-d", "C:\\c", "omp", "--resume", "c.jsonl",
		]);
	});

	it("uses horizontal splits for rows and targets the current window", () => {
		const args = buildLayoutArgs([pane("a"), pane("b")], { layout: "rows", window: "current" });
		expect(args.slice(0, 3)).toEqual(["-w", "0", "nt"]);
		expect(args).toContain("-H");
		expect(args).not.toContain("-V");
		expect(args.filter((a) => a === ";")).toHaveLength(1);
	});

	it("peels even slices so every pane ends up 1/n wide", () => {
		const args = buildLayoutArgs([pane("a"), pane("b"), pane("c"), pane("d")], { layout: "columns", window: "new" });
		const sizes = args.filter((_, i) => args[i - 1] === "-s");
		expect(sizes).toEqual(["0.75", "0.6667", "0.5"]);
	});

	it("throws on an empty pane list", () => {
		expect(() => buildLayoutArgs([], { layout: "columns", window: "new" })).toThrow();
	});
});

describe("adaptLayoutPaneForHost", () => {
	it("wraps the command in wsl.exe and translates cwd under a WSL host", () => {
		const out = adaptLayoutPaneForHost(
			{ cwd: "/home/u/p", title: "p", commandline: ["omp", "--resume", "/s.jsonl"] },
			{ wslDistro: "Ubuntu", toWindowsPath: () => "\\\\wsl$\\Ubuntu\\home\\u\\p" },
		);
		expect(out.title).toBe("p");
		expect(out.cwd).toBe("\\\\wsl$\\Ubuntu\\home\\u\\p");
		expect(out.commandline).toEqual([
			"wsl.exe", "-d", "Ubuntu", "--cd", "/home/u/p", "--", "omp", "--resume", "/s.jsonl",
		]);
	});

	it("is identity on a native host", () => {
		const inputPane = { cwd: "C:\\p", title: "p", commandline: ["omp"] };
		expect(adaptLayoutPaneForHost(inputPane, { wslDistro: undefined })).toEqual(inputPane);
	});
});

describe("discoverTerminalSessions", () => {
	let tmp: string;
	const savedAgentDir = Bun.env.PI_CODING_AGENT_DIR;
	const savedWt = Bun.env.WT_SESSION;

	const writeCrumb = (id: string, cwd: string, sessionFile: string, mtime?: Date) => {
		const file = path.join(tmp, "terminal-sessions", id);
		writeFileSync(file, `${cwd}\n${sessionFile}\n`);
		if (mtime) utimesSync(file, mtime, mtime);
	};

	beforeEach(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), "wt-disco-"));
		mkdirSync(path.join(tmp, "terminal-sessions"), { recursive: true });
		Bun.env.PI_CODING_AGENT_DIR = tmp;
		delete Bun.env.WT_SESSION;
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		if (savedAgentDir === undefined) delete Bun.env.PI_CODING_AGENT_DIR;
		else Bun.env.PI_CODING_AGENT_DIR = savedAgentDir;
		if (savedWt === undefined) delete Bun.env.WT_SESSION;
		else Bun.env.WT_SESSION = savedWt;
	});

	it("parses breadcrumbs newest-first and flags the current terminal", async () => {
		Bun.env.WT_SESSION = "cur-guid";
		writeCrumb("wt-old", "C:\\old", "C:\\s\\old.jsonl", new Date(Date.now() - 100_000));
		writeCrumb("wt-cur-guid", "C:\\cur", "C:\\s\\cur.jsonl", new Date(Date.now() - 1_000));
		const sessions = await discoverTerminalSessions();
		expect(sessions.map((s) => s.terminalId)).toEqual(["wt-cur-guid", "wt-old"]);
		expect(sessions[0]).toMatchObject({ current: true, cwd: "C:\\cur", sessionFile: "C:\\s\\cur.jsonl" });
		expect(sessions[1].current).toBe(false);
	});

	it("skips breadcrumbs missing the session-file line", async () => {
		writeCrumb("wt-good", "C:\\a", "C:\\s\\a.jsonl");
		writeFileSync(path.join(tmp, "terminal-sessions", "wt-bad"), "C:\\only-cwd\n");
		const sessions = await discoverTerminalSessions();
		expect(sessions.map((s) => s.terminalId)).toEqual(["wt-good"]);
	});

	it("returns an empty list when the registry directory is absent", async () => {
		Bun.env.PI_CODING_AGENT_DIR = path.join(tmp, "nope");
		expect(await discoverTerminalSessions()).toEqual([]);
	});
});

describe("scanStoredSessions", () => {
	let tmp: string;
	const savedAgentDir = Bun.env.PI_CODING_AGENT_DIR;

	const writeSession = (project: string, id: string, cwd: string, title: string, mtime?: Date) => {
		const dir = path.join(tmp, "sessions", project);
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${id}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd, title })}\n{"type":"message"}\n`);
		if (mtime) utimesSync(file, mtime, mtime);
	};

	beforeEach(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), "wt-store-"));
		Bun.env.PI_CODING_AGENT_DIR = tmp;
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		if (savedAgentDir === undefined) delete Bun.env.PI_CODING_AGENT_DIR;
		else Bun.env.PI_CODING_AGENT_DIR = savedAgentDir;
	});

	it("recovers cwd/title from headers, newest-first, across projects", async () => {
		writeSession("projA", "id-old", "C:\\a", "Old one", new Date(Date.now() - 100_000));
		writeSession("projB", "id-new", "C:\\b", "New one", new Date(Date.now() - 1_000));
		const sessions = await scanStoredSessions();
		expect(sessions.map((s) => s.id)).toEqual(["id-new", "id-old"]);
		expect(sessions[0]).toMatchObject({ cwd: "C:\\b", title: "New one" });
		expect(sessions[0].sessionFile.endsWith("id-new.jsonl")).toBe(true);
	});

	it("skips non-jsonl files and headers without a cwd", async () => {
		writeSession("projA", "good", "C:\\a", "");
		const dir = path.join(tmp, "sessions", "projA");
		writeFileSync(path.join(dir, "note.txt"), "ignore me");
		writeFileSync(path.join(dir, "nocwd.jsonl"), `${JSON.stringify({ type: "session", id: "nocwd" })}\n`);
		const sessions = await scanStoredSessions();
		expect(sessions.map((s) => s.id)).toEqual(["good"]);
	});

	it("returns an empty list when the store is absent", async () => {
		Bun.env.PI_CODING_AGENT_DIR = path.join(tmp, "nope");
		expect(await scanStoredSessions()).toEqual([]);
	});
});
