import { describe, expect, it } from "bun:test";
import { adaptPaneOptionsForHost, buildWtArgs, resolveWtLauncher, wslWrapCommandline } from "../src/windows-terminal";

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
