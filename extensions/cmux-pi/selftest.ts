import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildArgv } from "./cmux.ts";

const VIEWER = join(homedir(), ".pi/agent/npm/node_modules/pi-session-tree-browser/extensions/session-tree-browser.ts");
const JITI = join(homedir(), ".pi/agent/npm/node_modules/jiti/lib/jiti-register.mjs");

export default function (_pi: unknown) {
	let pass = 0;
	let fail = 0;
	const check = (name: string, got: unknown, want: unknown) => {
		const ok = JSON.stringify(got) === JSON.stringify(want);
		if (ok) pass++;
		else {
			fail++;
			console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
		}
	};
	check("viewer ts exists", existsSync(VIEWER), true);
	check("jiti register exists", existsSync(JITI), true);
	check(
		"open-split url",
		buildArgv({ action: "open", split: true, args: ["https://ex.com"], focus: true }),
		["--json", "browser", "open-split", "https://ex.com", "--focus", "true"],
	);
	check(
		"new-workspace",
		buildArgv({ action: "new-workspace", name: "gpu", cwd: "/tmp" }),
		["--json", "new-workspace", "--name", "gpu", "--cwd", "/tmp"],
	);
	check(
		"ssh-tmux new window",
		buildArgv({ action: "ssh-tmux", args: ["s10"], newWindow: true }),
		["--json", "ssh-tmux", "s10", "--new-window"],
	);
	check(
		"send enter",
		buildArgv({ action: "send", surface: "surface:2", text: "ls\n" }),
		["--json", "send", "--surface", "surface:2", "--", "ls\n"],
	);
	check(
		"read-screen lines",
		buildArgv({ action: "read-screen", surface: "surface:4", lines: 20, scrollback: true }),
		["--json", "read-screen", "--surface", "surface:4", "--lines", "20", "--scrollback"],
	);
	check(
		"ssh dest first",
		buildArgv({ action: "ssh", args: ["dev@box"], name: "gpu", port: 2222 }),
		["--json", "ssh", "dev@box", "--name", "gpu", "--port", "2222"],
	);
	console.error(`SELFTEST ${fail === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
	if (fail) throw new Error("cmux-pi selftest failed");
}
