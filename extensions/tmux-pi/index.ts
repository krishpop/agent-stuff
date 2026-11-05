/**
 * /tmux-pi — list/capture/steer pi panes in remote tmux and Herdr.
 *
 * pi.exec has no stdin, so we spawn `ssh -o BatchMode=yes HOST bash -s` and
 * feed the script on stdin. host `local` or `.` is local `bash -s`.
 *
 * Gateways (gateway etc.) already drop you on the login node you use — dump
 * prints that hostname. Do not scan other hosts. Herdr pane ids look like w6:p1
 * (sessions resumed in Herdr leave tmux). steer pastes tmux PTY or runs
 * `herdr agent prompt`. msg/inbox files are async; slurm logs are not stdin.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	REMOTE_DUMP,
	REMOTE_HERDR_LIST,
	formatList,
	isHerdrSpec,
	mergeHerdr,
	paneId,
	parseDump,
	sshHosts,
} from "./lib.ts";

const ACTIONS = ["list", "capture", "steer", "keys", "log", "msg", "hosts", "set-host"] as const;
const SLASH_ACTIONS = new Set(["list", "hosts", "host", "capture", "steer", "keys", "log", "msg"]);
const KEY_RE = /^[A-Za-z0-9:._-]+$/;
const CFG = () => join(homedir(), ".pi/tmux-pi.json");

type Action = (typeof ACTIONS)[number];
type Params = {
	action: Action;
	host?: string;
	pane?: string;
	text?: string;
	submit?: boolean;
	keys?: string;
	lines?: number;
	all?: boolean;
};

function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function b64(s: string): string {
	return Buffer.from(s, "utf8").toString("base64");
}

function defaultHost(): string {
	const env = process.env.TMUX_PI_HOST?.trim();
	if (env) return env;
	const p = CFG();
	if (existsSync(p)) {
		const j = JSON.parse(readFileSync(p, "utf8")) as { host?: string };
		if (j.host?.trim()) return j.host.trim();
	}
	throw new Error("No tmux-pi host. Set TMUX_PI_HOST, pass host=, or /tmux-pi host <alias>");
}

function spawnScript(host: string, script: string): Promise<{ stdout: string; stderr: string; code: number }> {
	const local = host === "local" || host === ".";
	const cmd = local ? "bash" : "ssh";
	const args = local ? ["-s"] : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "bash", "-s"];
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
		child.stdin.end(script);
	});
}

async function remote(host: string, script: string): Promise<string> {
	const r = await spawnScript(host, script);
	if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`);
	return r.stdout;
}

function needPane(params: Params): string {
	const pane = params.pane?.trim();
	if (!pane) throw new Error(`${params.action} needs pane (session:win.pane)`);
	return pane;
}

const HERDR_PATH = 'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"';

async function dumpOf(host: string) {
	const dump = parseDump(await remote(host, REMOTE_DUMP));
	try {
		return mergeHerdr(dump, await remote(host, REMOTE_HERDR_LIST));
	} catch {
		return dump;
	}
}

function findPane(dump: ReturnType<typeof parseDump>, spec: string) {
	const pane = dump.panes.find((p) => p.spec === spec);
	if (!pane) throw new Error(`pane not found: ${spec}`);
	return pane;
}

async function run(params: Params): Promise<string> {
	if (params.action === "hosts") {
		const p = join(homedir(), ".ssh/config");
		if (!existsSync(p)) return "(no ~/.ssh/config)";
		const names = sshHosts(readFileSync(p, "utf8"));
		return names.length ? names.join("\n") : "(no Host aliases)";
	}
	if (params.action === "set-host") {
		const host = params.host?.trim();
		if (!host) throw new Error("set-host needs host");
		mkdirSync(join(homedir(), ".pi"), { recursive: true });
		writeFileSync(CFG(), JSON.stringify({ host }) + "\n");
		return `host set to ${host}`;
	}

	const host = params.host?.trim() || defaultHost();

	if (params.action === "list") {
		const dump = await dumpOf(host);
		return formatList(dump, { all: params.all });
	}

	const pane = needPane(params);
	const spec = q(pane);
	const id = paneId(pane);

	if (params.action === "capture") {
		const n = Math.max(1, params.lines ?? 80);
		if (isHerdrSpec(pane)) {
			const out = await remote(
				host,
				[
					HERDR_PATH,
					"printf 'HOST '",
					"hostname",
					`herdr pane read ${spec} --source recent-unwrapped --lines ${n} --format text`,
				].join("\n"),
			);
			return out.replace(/^HOST /, "host ");
		}
		const out = await remote(
			host,
			["printf 'HOST '", "hostname", `tmux capture-pane -t ${spec} -p -S -${n}`].join("\n"),
		);
		return out.replace(/^HOST /, "host ");
	}

	if (params.action === "steer") {
		const text = params.text ?? "";
		const submit = params.submit !== false;
		if (isHerdrSpec(pane)) {
			const out = await remote(
				host,
				[
					HERDR_PATH,
					"printf 'HOST '",
					"hostname",
					`payload=$(printf '%s' '${b64(text)}' | base64 -d)`,
					submit
						? `herdr agent prompt ${spec} "$payload"`
						: `herdr pane send-text ${spec} "$payload"`,
					"echo OK",
				].join("\n"),
			);
			const hn = out.match(/^HOST (\S+)/)?.[1] ?? host;
			return `steered herdr ${pane} on ${hn}${submit ? " (agent prompt)" : " (send-text)"}`;
		}
		const out = await remote(
			host,
			[
				"printf 'HOST '",
				"hostname",
				`printf '%s' '${b64(text)}' | base64 -d | tmux load-buffer -`,
				`tmux paste-buffer -d -t ${spec}`,
				submit ? `tmux send-keys -t ${spec} Enter` : "",
				"echo OK",
			]
				.filter(Boolean)
				.join("\n"),
		);
		const hn = out.match(/^HOST (\S+)/)?.[1] ?? host;
		return `steered ${pane} on ${hn}${submit ? " (+Enter)" : ""}\nlogin tmux is the PTY — works inside srun`;
	}

	if (params.action === "keys") {
		const toks = (params.keys ?? "").split(/\s+/).filter(Boolean);
		const ok = toks.filter((t) => KEY_RE.test(t));
		if (!ok.length) throw new Error("keys: tokens must match [A-Za-z0-9:._-]+");
		if (isHerdrSpec(pane)) {
			const mapped = ok.map((t) => (t === "C-c" ? "ctrl+c" : t === "Enter" ? "enter" : t === "Escape" ? "esc" : t));
			const out = await remote(
				host,
				[HERDR_PATH, "printf 'HOST '", "hostname", `herdr pane send-keys ${spec} ${mapped.map(q).join(" ")}`, "echo OK"].join(
					"\n",
				),
			);
			const hn = out.match(/^HOST (\S+)/)?.[1] ?? host;
			return `sent ${mapped.join(" ")} -> herdr ${pane} on ${hn}`;
		}
		const out = await remote(
			host,
			["printf 'HOST '", "hostname", `tmux send-keys -t ${spec} ${ok.map(q).join(" ")}`, "echo OK"].join("\n"),
		);
		const hn = out.match(/^HOST (\S+)/)?.[1] ?? host;
		return `sent ${ok.join(" ")} -> ${pane} on ${hn}`;
	}

	if (params.action === "log") {
		const dump = await dumpOf(host);
		const p = findPane(dump, pane);
		const jobid = p.jobid;
		const script = [
			"printf 'HOST '",
			"hostname",
			`id=${q(id)}`,
			'dir="$HOME/.pi/tmux-pi/$id"',
			'echo "=== $dir ==="',
			'echo "-- inbox --"',
			'if [ -f "$dir/inbox" ]; then cat "$dir/inbox"; else echo "(none)"; fi',
			'echo "-- outbox --"',
			'if [ -f "$dir/outbox" ]; then cat "$dir/outbox"; else echo "(none)"; fi',
			jobid
				? [
						`echo "=== scontrol show job ${jobid} ==="`,
						`if out=$(scontrol show job ${jobid} 2>/dev/null); then`,
						'  printf \'%s\\n\' "$out"',
						`  stdout=$(printf '%s\\n' "$out" | tr ' ' '\\n' | sed -n 's/^StdOut=//p' | head -n 1)`,
						'  if [ -n "$stdout" ] && [ -f "$stdout" ]; then',
						'    echo "=== tail StdOut $stdout ==="',
						'    tail -n 80 "$stdout"',
						'  elif [ -n "$stdout" ]; then',
						'    echo "StdOut=$stdout (missing)"',
						"  fi",
						"else",
						'  echo "(scontrol: job not found)"',
						"fi",
					].join("\n")
				: 'echo "(no jobid on this pane cmdline — not srun? still showing inbox/outbox)"',
		].join("\n");
		return (await remote(host, script)).replace(/^HOST /, "host ");
	}

	if (params.action === "msg") {
		const text = params.text;
		if (text === undefined || text === "") throw new Error("msg needs text");
		const dump = await dumpOf(host);
		const p = findPane(dump, pane);
		const jobid = p.jobid;
		const script = [
			"printf 'HOST '",
			"hostname",
			`id=${q(id)}`,
			'dir="$HOME/.pi/tmux-pi/$id"',
			'mkdir -p "$dir"',
			`payload=$(printf '%s' '${b64(text)}' | base64 -d)`,
			'{ printf \'%s\\n\' "$payload"; } >> "$dir/inbox"',
			'echo "appended $dir/inbox"',
			jobid
				? [
						`job=${jobid}`,
						`stdout=$(scontrol show job "$job" 2>/dev/null | tr ' ' '\\n' | sed -n 's/^StdOut=//p' | head -n 1)`,
						'if [ -n "$stdout" ]; then',
						'  printf \'%s\\n\' "$payload" >> "$stdout.inbox"',
						'  echo "appended $stdout.inbox"',
						"fi",
					].join("\n")
				: "",
			'echo "files are async; steer injects stdin. slurm log is not stdin."',
		]
			.filter(Boolean)
			.join("\n");
		return (await remote(host, script)).replace(/^HOST /, "host ");
	}

	throw new Error(`unknown action ${params.action}`);
}

function parseSlash(raw: string): Params {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	let host: string | undefined;
	let all = false;
	let submit = true;
	const pos: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "-h" || t === "--host") {
			host = tokens[++i];
			continue;
		}
		if (t === "--all") {
			all = true;
			continue;
		}
		if (t === "--no-submit") {
			submit = false;
			continue;
		}
		pos.push(t);
	}
	let action = "list";
	let rest = pos;
	if (pos[0] && SLASH_ACTIONS.has(pos[0])) {
		action = pos[0];
		rest = pos.slice(1);
	} else if (pos[0]) {
		host = pos[0];
		rest = pos.slice(1);
	}
	if (action === "host") return { action: "set-host", host: rest[0] || host };
	if (action === "hosts") return { action: "hosts" };
	const pane = rest[0];
	const tail = rest.slice(1).join(" ");
	const params: Params = { action: action as Action, host, all, submit, pane };
	if (action === "steer" || action === "msg") params.text = tail;
	if (action === "keys") params.keys = tail;
	if (action === "capture" && rest[1] && /^\d+$/.test(rest[1])) params.lines = Number(rest[1]);
	return params;
}

export default function tmuxPi(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tmux_pi",
		label: "tmux-pi",
		description:
			"List, capture, and steer pi sessions in remote login-node tmux AND Herdr. " +
			"Actions: list, capture, steer, keys, log, msg, hosts, set-host. " +
			"Default host: TMUX_PI_HOST or ~/.pi/tmux-pi.json. host=local or . is this machine. " +
			"Gateways like gateway auto-route to the login node you already use; the dump prints that hostname — do not scan other hosts. " +
			"list merges tmux panes and `herdr pane list` (resumed-in-Herdr sessions vanish from tmux). " +
			"pane ids: tmux session:win.pane, or Herdr wN:pN. steer uses tmux paste or `herdr agent prompt`. " +
			"msg appends ~/.pi/tmux-pi/<pane>/inbox (and StdOut.inbox if a slurm job is found). Those files are async; they do not inject stdin. Use steer for stdin.",
		promptSnippet: "tmux_pi - list/steer pi panes in remote tmux (steer=stdin, msg=async files)",
		parameters: Type.Object({
			action: StringEnum(ACTIONS),
			host: Type.Optional(Type.String({ description: "SSH alias, or local/." })),
			pane: Type.Optional(Type.String({ description: "tmux session:win.pane, or Herdr wN:pN" })),
			text: Type.Optional(Type.String({ description: "steer/msg payload" })),
			submit: Type.Optional(Type.Boolean({ description: "steer: send Enter after paste (default true)" })),
			keys: Type.Optional(Type.String({ description: "send-keys tokens matching [A-Za-z0-9:._-]+" })),
			lines: Type.Optional(Type.Number({ description: "capture-pane -S -N (default 80)" })),
			all: Type.Optional(Type.Boolean({ description: "list every agent, not just pi" })),
		}),
		async execute(_id, params) {
			const text = await run(params as Params);
			return { content: [{ type: "text" as const, text }] };
		},
	});

	pi.registerCommand("tmux-pi", {
		description: "Remote tmux/Herdr pi panes — /tmux-pi [-h HOST] [--all] [list|hosts|host|capture|steer|keys|log|msg]",
		handler: async (args, ctx) => {
			try {
				const text = await run(parseSlash(args ?? ""));
				ctx.ui.notify(text.slice(0, 4000), "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});
}
