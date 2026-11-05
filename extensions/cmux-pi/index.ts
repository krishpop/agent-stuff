/**
 * cmux from Pi: /cmux-pi opens the session-tree viewer; the `cmux` tool
 * shells out to the cmux CLI (links, workspaces, ssh/tmux, pane send/read).
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ACTIONS, type CmuxParams, buildArgv } from "./cmux.ts";

export const NPM = join(homedir(), ".pi/agent/npm/node_modules");
export const VIEWER = join(NPM, "pi-session-tree-browser/extensions/session-tree-browser.ts");
export const JITI = join(NPM, "jiti/lib/jiti-register.mjs");
const HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_SESSION_VIEWER_PORT ?? "17876");
const SCAN = 20;
const START_MS = 30_000;
const OUT_CAP = 50_000;

export function viewerUrl(sessionFile: string, port: number): string {
	return `http://${HOST}:${port}/?session=${encodeURIComponent(sessionFile)}`;
}

async function health(port: number): Promise<boolean> {
	try {
		const r = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(400) });
		return r.ok;
	} catch {
		return false;
	}
}

export async function findViewerPort(): Promise<number | undefined> {
	for (let i = 0; i < SCAN; i++) {
		if (await health(DEFAULT_PORT + i)) return DEFAULT_PORT + i;
	}
	return undefined;
}

export async function ensureViewer(): Promise<number> {
	const existing = await findViewerPort();
	if (existing !== undefined) return existing;
	if (!existsSync(VIEWER) || !existsSync(JITI)) {
		throw new Error("pi-session-tree-browser is not installed. Run: pi install npm:pi-session-tree-browser");
	}
	const log = join(tmpdir(), "pi-session-viewer.log");
	const fd = openSync(log, "a");
	try {
		const child = spawn(
			process.execPath,
			["--import", pathToFileURL(JITI).href, VIEWER, "--session-viewer-server"],
			{
				cwd: process.cwd(),
				detached: true,
				env: { ...process.env, PI_SESSION_VIEWER_SERVER: "1" },
				stdio: ["ignore", fd, fd],
			},
		);
		child.unref();
	} finally {
		closeSync(fd);
	}
	const t0 = Date.now();
	while (Date.now() - t0 < START_MS) {
		const port = await findViewerPort();
		if (port !== undefined) return port;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`session viewer did not start (log: ${log})`);
}

async function callerWorkspace(pi: ExtensionAPI): Promise<string | undefined> {
	const ident = await pi.exec("cmux", ["identify", "--json"], { timeout: 3000 });
	if (ident.code !== 0) return undefined;
	try {
		const ws = JSON.parse(ident.stdout).caller?.workspace_ref;
		return typeof ws === "string" ? ws : undefined;
	} catch {
		return undefined;
	}
}

async function openSessionTree(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
	const session = ctx.sessionManager.getSessionFile();
	if (!session) throw new Error("/cmux-pi needs a persisted session (don't use --no-session).");
	const ping = await pi.exec("cmux", ["ping"], { timeout: 3000 });
	const port = await ensureViewer();
	const url = viewerUrl(session, port);
	if (ping.code !== 0) return `cmux not running. Open: ${url}`;
	const args = ["--json", "browser", "open-split", url, "--focus", "true"];
	const ws = await callerWorkspace(pi);
	if (ws) args.push("--workspace", ws);
	const opened = await pi.exec("cmux", args, { timeout: 10_000 });
	if (opened.code !== 0) {
		throw new Error(
			`cmux browser open-split failed: ${(opened.stderr || opened.stdout || "").trim() || opened.code}. URL: ${url}`,
		);
	}
	return `Pi session in cmux browser: ${url}\n${opened.stdout.trim()}`;
}

function cap(s: string): string {
	return s.length <= OUT_CAP ? s : s.slice(0, OUT_CAP) + `\n… truncated ${s.length - OUT_CAP} chars`;
}

export default function cmuxPiExtension(pi: ExtensionAPI) {
	pi.registerCommand("cmux-pi", {
		description: "Open this Pi session in a cmux browser pane (tree + composer)",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify("Starting session viewer...", "info");
				ctx.ui.notify(await openSessionTree(pi, ctx), "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	pi.registerTool({
		name: "cmux",
		label: "cmux",
		description:
			"Control cmux: open URLs, workspaces, ssh/tmux sessions, and other panes (read/send), " +
			"same CLI surface as cmux-orchestrate. action=pi opens this Pi session in a browser pane. " +
			"Does not wrap close-workspace. identify/tree first when locating panes.",
		promptSnippet: "cmux - open links/workspaces/ssh/tmux and control cmux panes",
		promptGuidelines: [
			"Call cmux action=identify or tree before send/read if you don't have a surface ref.",
			"Open a link in a pane: action=open split=true args=[url].",
			"New workspace: action=new-workspace name=… cwd=… . SSH box: action=ssh args=[host]. Remote tmux: action=ssh-tmux args=[host] newWindow=true.",
			"Send Enter with text ending in \\n. AI CLI surfaces may reject send — report the error, don't retry close-workspace.",
			"action=pi opens the session-tree browser for the current Pi session.",
		],
		parameters: Type.Object({
			action: StringEnum(ACTIONS, {
				description:
					"cmux CLI verb, or pi for the session-tree viewer. args are positionals (url, host, direction, send body).",
			}),
			args: Type.Optional(Type.Array(Type.String(), { description: "Positionals: url, ssh host, split direction, browser subcommand, …" })),
			workspace: Type.Optional(Type.String({ description: "workspace:N" })),
			surface: Type.Optional(Type.String({ description: "surface:N" })),
			window: Type.Optional(Type.String({ description: "window:N" })),
			pane: Type.Optional(Type.String({ description: "pane:N" })),
			split: Type.Optional(Type.Boolean({ description: "open: use browser open-split" })),
			focus: Type.Optional(Type.Boolean()),
			name: Type.Optional(Type.String({ description: "workspace/ssh title" })),
			cwd: Type.Optional(Type.String()),
			command: Type.Optional(Type.String({ description: "command after new-workspace or ssh" })),
			text: Type.Optional(Type.String({ description: "send / send-key body" })),
			lines: Type.Optional(Type.Integer({ description: "read-screen last N lines" })),
			scrollback: Type.Optional(Type.Boolean()),
			newWindow: Type.Optional(Type.Boolean({ description: "ssh-tmux --new-window" })),
			identity: Type.Optional(Type.String({ description: "ssh -i" })),
			port: Type.Optional(Type.Integer({ description: "ssh port" })),
			sessionId: Type.Optional(Type.String({ description: "ssh-session-attach --session-id" })),
		}),

		async execute(_id, params, signal, _onUpdate, ctx) {
			const p = params as CmuxParams;
			if (p.action === "pi") {
				const text = await openSessionTree(pi, ctx);
				return { content: [{ type: "text" as const, text }], details: { action: "pi" } };
			}
			const argv = buildArgv(p);
			const timeout = p.action === "ssh" || p.action === "ssh-tmux" ? 60_000 : 20_000;
			const r = await pi.exec("cmux", argv, { signal, timeout });
			const out = cap((r.stdout || r.stderr || "").trim() || `(exit ${r.code})`);
			if (r.code !== 0) throw new Error(`cmux ${argv.slice(1).join(" ")}\n${out}`);
			return { content: [{ type: "text" as const, text: out }], details: { action: p.action, argv } };
		},
	});
}
