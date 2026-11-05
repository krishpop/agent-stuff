/** Allowlisted `cmux --json …` argv. Special action `pi` is handled in index.ts. */

export const ACTIONS = [
	"identify",
	"tree",
	"list-workspaces",
	"list-panes",
	"list-pane-surfaces",
	"open",
	"new-window",
	"new-workspace",
	"new-split",
	"new-surface",
	"new-pane",
	"select-workspace",
	"rename-workspace",
	"ssh",
	"ssh-tmux",
	"ssh-session-list",
	"ssh-session-attach",
	"read-screen",
	"send",
	"send-key",
	"browser",
	"pi",
] as const;

export type Action = (typeof ACTIONS)[number];

export type CmuxParams = {
	action: Action;
	args?: string[];
	workspace?: string;
	surface?: string;
	window?: string;
	pane?: string;
	split?: boolean;
	focus?: boolean;
	name?: string;
	cwd?: string;
	command?: string;
	text?: string;
	lines?: number;
	scrollback?: boolean;
	newWindow?: boolean;
	identity?: string;
	port?: number;
	sessionId?: string;
};

export function buildArgv(p: CmuxParams): string[] {
	if (p.action === "pi") throw new Error("action=pi is handled by the extension, not the cmux CLI");

	const extra = p.args ?? [];
	const flags: string[] = [];
	const flag = (name: string, val?: string | number | boolean) => {
		if (val === undefined || val === false) return;
		if (val === true) flags.push(name);
		else flags.push(name, String(val));
	};
	flag("--workspace", p.workspace);
	flag("--surface", p.surface);
	flag("--window", p.window);
	flag("--pane", p.pane);
	flag("--name", p.name);
	flag("--cwd", p.cwd);
	flag("--command", p.command);
	flag("--identity", p.identity);
	flag("--port", p.port);
	flag("--session-id", p.sessionId);
	flag("--lines", p.lines);
	if (p.scrollback) flags.push("--scrollback");
	if (p.newWindow) flags.push("--new-window");
	if (p.focus === true) flags.push("--focus", "true");
	if (p.focus === false) flags.push("--no-focus");

	if (p.action === "open") {
		const head = p.split ? ["browser", "open-split"] : ["open"];
		return ["--json", ...head, ...extra, ...flags];
	}
	if (p.action === "browser") {
		return ["--json", "browser", ...extra, ...flags];
	}
	if (p.action === "send") {
		const text = p.text ?? extra.join(" ");
		if (!text) throw new Error("send requires text (or args)");
		return ["--json", "send", ...flags, "--", text];
	}
	if (p.action === "send-key") {
		const key = p.text ?? extra[0];
		if (!key) throw new Error("send-key requires text or args[0]");
		return ["--json", "send-key", ...flags, key];
	}
	if (p.action === "ssh" || p.action === "ssh-tmux") {
		const dest = extra[0];
		if (!dest) throw new Error(`${p.action} requires args[0] = destination`);
		return ["--json", p.action, dest, ...flags, ...extra.slice(1)];
	}
	if (p.action === "new-split") {
		const dir = extra[0];
		if (!dir) throw new Error("new-split requires args[0] = left|right|up|down");
		return ["--json", "new-split", dir, ...flags, ...extra.slice(1)];
	}
	if (p.action === "rename-workspace") {
		const title = extra[0] ?? p.name;
		if (!title) throw new Error("rename-workspace requires args[0] or name");
		return ["--json", "rename-workspace", ...flags, title];
	}
	return ["--json", p.action, ...flags, ...extra];
}
