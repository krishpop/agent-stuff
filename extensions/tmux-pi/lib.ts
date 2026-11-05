/** Pure dump/parse/classify for tmux-pi. No SSH. */

const TAB = "\t";

/** stdin for `ssh HOST bash -s`. Prints HOST <hostname>. NO_TMUX if none. */
export const REMOTE_DUMP = [
	"printf 'HOST '",
	"hostname",
	"if ! command -v tmux >/dev/null 2>&1; then",
	"  echo NO_TMUX",
	"  exit 0",
	"fi",
	"if ! tmux list-panes -a >/dev/null 2>&1; then",
	"  echo NO_TMUX",
	"  exit 0",
	"fi",
	`tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}${TAB}#{pane_pid}${TAB}#{pane_current_command}${TAB}#{pane_title}${TAB}#{pane_current_path}' | while IFS='${TAB}' read -r spec pid cmd title path; do`,
	'  [ -n "$spec" ] || continue',
	'  printf \'PANE %s\\n\' "$spec"',
	'  printf \'PID %s\\n\' "$pid"',
	'  printf \'CMD %s\\n\' "$cmd"',
	'  printf \'TITLE %s\\n\' "$title"',
	'  printf \'PATH %s\\n\' "$path"',
	'  if [ -r "/proc/$pid/cmdline" ]; then',
	"    printf 'CMDLINE '",
	'    tr \'\\0\' \' \' < "/proc/$pid/cmdline"',
	"    echo",
	"  fi",
	"  echo CAPTURE",
	'  tmux capture-pane -t "$spec" -p -S -40 2>/dev/null || true',
	"  echo END",
	"done",
].join("\n");

/** stdin: print `herdr pane list` JSON, or HERDR_NONE. */
export const REMOTE_HERDR_LIST = [
	'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"',
	'if ! command -v herdr >/dev/null 2>&1; then echo HERDR_NONE; exit 0; fi',
	"herdr pane list",
].join("\n");

export type Agent = "pi" | "claude" | "grok" | "other";
export type Via = "tmux" | "herdr";
export type Srun = { jobid?: string; nodelist?: string };

export type Pane = {
	spec: string;
	pid: string;
	cmd: string;
	title: string;
	path: string;
	cmdline?: string;
	capture: string;
	jobid?: string;
	nodelist?: string;
	agent: Agent;
	ctx?: string;
	via?: Via;
};

export type Dump = { host: string; noTmux: boolean; panes: Pane[] };

export function isHerdrSpec(spec: string): boolean {
	return /^w\d+:p\d+$/.test(spec.trim());
}

export function parseSrun(cmdline: string): Srun {
	const out: Srun = {};
	const job = cmdline.match(/--jobid(?:=|\s+)(\d+)/);
	if (job) out.jobid = job[1];
	const nl = cmdline.match(/--nodelist(?:=|\s+)(\S+)/) || cmdline.match(/(?:^|\s)-w(?:\s+|=)(\S+)/);
	if (nl) out.nodelist = nl[1];
	return out;
}

export function classify(p: { cmd: string; title: string; capture: string }): Agent {
	const cmd = p.cmd ?? "";
	const title = p.title ?? "";
	const capture = p.capture ?? "";
	if (
		title.includes("(pi)") ||
		title.includes("π") ||
		cmd === "pi" ||
		capture.includes("napkin distill") ||
		capture.includes("ponytail") ||
		capture.includes("example-provider-")
	) {
		return "pi";
	}
	if (capture.includes("auto mode on") || capture.includes("ctrl+t to hide tasks") || cmd === "claude") {
		return "claude";
	}
	if (cmd === "grok") return "grok";
	return "other";
}

export function parseCtx(capture: string): string | undefined {
	const hits = capture.match(/\d{1,3}(?:\.\d+)?%/g);
	return hits?.at(-1);
}

export function parseLastJson(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed === "HERDR_NONE") return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		/* fall through */
	}
	for (const line of trimmed.split(/\r?\n/).reverse()) {
		try {
			return JSON.parse(line) as unknown;
		} catch {
			/* next */
		}
	}
	const i = trimmed.indexOf("{");
	if (i >= 0) {
		try {
			return JSON.parse(trimmed.slice(i)) as unknown;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function parseHerdrPanes(stdout: string): Pane[] {
	const parsed = parseLastJson(stdout);
	if (!parsed || typeof parsed !== "object") return [];
	const root = parsed as { result?: { panes?: unknown }; panes?: unknown };
	const raw = root.result?.panes ?? root.panes;
	if (!Array.isArray(raw)) return [];
	const out: Pane[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const p = item as Record<string, unknown>;
		const spec = String(p.pane_id ?? "").trim();
		if (!spec) continue;
		const title = String(p.terminal_title_stripped ?? p.terminal_title ?? "");
		const cmd = String(p.agent ?? "herdr");
		const path = String(p.cwd ?? p.foreground_cwd ?? "");
		const capture = "";
		out.push({
			spec,
			pid: "",
			cmd,
			title,
			path,
			capture,
			agent: classify({ cmd, title, capture }),
			via: "herdr",
		});
	}
	return out;
}

export function parseDump(text: string): Dump {
	const panes: Pane[] = [];
	let host = "";
	let noTmux = false;
	let cur: Omit<Pane, "agent" | "jobid" | "nodelist" | "ctx"> | undefined;
	let inCapture = false;
	const cap: string[] = [];

	const finish = () => {
		if (!cur) return;
		const capture = cap.join("\n");
		const srun = parseSrun(cur.cmdline ?? "");
		const ctx = parseCtx(capture);
		panes.push({
			...cur,
			capture,
			...srun,
			agent: classify({ cmd: cur.cmd, title: cur.title, capture }),
			via: cur.via ?? "tmux",
			...(ctx ? { ctx } : {}),
		});
		cur = undefined;
		cap.length = 0;
		inCapture = false;
	};

	for (const raw of text.split(/\r?\n/)) {
		if (inCapture) {
			if (raw === "END") {
				finish();
				continue;
			}
			cap.push(raw);
			continue;
		}
		if (raw.startsWith("HOST ")) {
			host = raw.slice(5).trim();
			continue;
		}
		if (raw.trim() === "NO_TMUX") {
			noTmux = true;
			continue;
		}
		if (raw.startsWith("PANE ")) {
			finish();
			cur = { spec: raw.slice(5).trim(), pid: "", cmd: "", title: "", path: "", capture: "" };
			continue;
		}
		if (!cur) continue;
		if (raw.startsWith("PID ")) cur.pid = raw.slice(4).trim();
		else if (raw.startsWith("CMD ")) cur.cmd = raw.slice(4).trim();
		else if (raw.startsWith("TITLE ")) cur.title = raw.slice(6);
		else if (raw.startsWith("PATH ")) cur.path = raw.slice(5);
		else if (raw.startsWith("CMDLINE ")) cur.cmdline = raw.slice(8);
		else if (raw === "CAPTURE") inCapture = true;
	}
	finish();
	return { host, noTmux, panes };
}

export function mergeHerdr(dump: Dump, herdrStdout: string): Dump {
	const extra = parseHerdrPanes(herdrStdout);
	if (!extra.length) return dump;
	const have = new Set(dump.panes.map((p) => p.spec));
	return { ...dump, panes: dump.panes.concat(extra.filter((p) => !have.has(p.spec))) };
}

export function sshHosts(configText: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const line of configText.split(/\r?\n/)) {
		const m = line.match(/^\s*Host\s+(\S.*)$/i);
		if (!m) continue;
		for (const tok of m[1].replace(/#.*$/, "").split(/\s+/)) {
			if (!tok || /[*?]/.test(tok)) continue;
			if (seen.has(tok)) continue;
			seen.add(tok);
			out.push(tok);
		}
	}
	return out;
}

export function paneId(spec: string): string {
	return spec.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function formatList(dump: Dump, opts?: { all?: boolean }): string {
	const lines = [`host ${dump.host || "?"}`];
	const panes = opts?.all ? dump.panes : dump.panes.filter((p) => p.agent === "pi");
	if (!panes.length) {
		if (dump.noTmux && !dump.panes.length) lines.push("NO_TMUX");
		else lines.push(opts?.all ? "(no panes)" : "(no pi panes; pass all=true)");
		return lines.join("\n");
	}
	const cols = ["pane", "via", "agent", "cmd", "job/node", "title", "ctx"];
	const rows = panes.map((p) => [
		p.spec,
		p.via ?? "tmux",
		p.agent,
		p.cmd,
		[p.jobid, p.nodelist].filter(Boolean).join("/") || "-",
		p.title,
		p.ctx ?? "-",
	]);
	const width = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
	const fmt = (r: string[]) => r.map((c, i) => c.padEnd(width[i])).join("  ");
	lines.push(fmt(cols));
	for (const r of rows) lines.push(fmt(r));
	return lines.join("\n");
}
