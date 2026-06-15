import { describe, expect, it } from "bun:test";
import { buildWtArgs, resolveWtLauncher } from "../src/windows-terminal";

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
});

describe("resolveWtLauncher", () => {
	it("runs wt.exe directly on native Windows", () => {
		expect(resolveWtLauncher({ platform: "win32", wsl: false })).toEqual({ command: "wt.exe", prefixArgs: [] });
	});

	it("bounces through cmd.exe under WSL where the wt alias is unavailable", () => {
		expect(resolveWtLauncher({ platform: "linux", wsl: true })).toEqual({
			command: "cmd.exe",
			prefixArgs: ["/c", "wt.exe"],
		});
	});
});
