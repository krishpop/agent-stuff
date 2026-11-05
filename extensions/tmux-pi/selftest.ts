/**
 * Selftest for tmux-pi parse/classify. Run: pi -e extensions/tmux-pi/selftest.ts -p x
 */
import {
	REMOTE_DUMP,
	classify,
	formatList,
	isHerdrSpec,
	mergeHerdr,
	paneId,
	parseCtx,
	parseDump,
	parseHerdrPanes,
	parseSrun,
	sshHosts,
} from "./lib.ts";

let pass = 0,
	fail = 0;
function check(name: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.error(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
	ok ? pass++ : fail++;
}

const MIXED = [
	"HOST login-node",
	"PANE train:2.0",
	"PID 4321",
	"CMD srun",
	"TITLE example-provider-train (pi)",
	"PATH /home/user/dev",
	"CMDLINE srun --jobid=7654321 --nodelist=s11n23 --overlap pi",
	"CAPTURE",
	"ponytail mode",
	"ctx 27.2%",
	"END",
	"PANE chat:1.0",
	"PID 99",
	"CMD grok",
	"TITLE grok",
	"PATH /tmp",
	"CAPTURE",
	"hello from grok",
	"END",
	"PANE cl:1.1",
	"PID 100",
	"CMD node",
	"TITLE Claude",
	"PATH /tmp",
	"CAPTURE",
	"auto mode on",
	"ctrl+t to hide tasks",
	"END",
].join("\n");

const SSH_CFG = [
	"Host gateway",
	"  HostName gateway.example",
	"Host s11ln*",
	"Host jump?host",
	"Host foo bar",
	"Host *",
	"# Host commented",
	"HostName ignored",
].join("\n");

export default function (_pi: unknown) {
	check("REMOTE_DUMP prints HOST + NO_TMUX", REMOTE_DUMP.includes("hostname") && REMOTE_DUMP.includes("NO_TMUX"), true);
	check("REMOTE_DUMP tabbed list-panes + capture -S -40", REMOTE_DUMP.includes("tmux list-panes -a -F") && REMOTE_DUMP.includes("-S -40"), true);

	const none = parseDump("HOST login-node\nNO_TMUX\n");
	check("NO_TMUX host", none.host, "login-node");
	check("NO_TMUX flag", none.noTmux, true);
	check("NO_TMUX panes empty", none.panes, []);

	const d = parseDump(MIXED);
	check("mixed host", d.host, "login-node");
	check("mixed pane count", d.panes.length, 3);

	const piPane = d.panes[0];
	check("pi-in-srun agent", piPane.agent, "pi");
	check("pi-in-srun jobid", piPane.jobid, "7654321");
	check("pi-in-srun nodelist", piPane.nodelist, "s11n23");
	check("pi-in-srun ctx", piPane.ctx, "27.2%");
	check("srun + (pi) title still pi", classify({ cmd: "srun", title: "foo (pi)", capture: "" }), "pi");

	check("grok agent", d.panes[1].agent, "grok");
	check("claude via capture", d.panes[2].agent, "claude");
	check("claude via cmd", classify({ cmd: "claude", title: "x", capture: "" }), "claude");
	check("other", classify({ cmd: "bash", title: "shell", capture: "ls" }), "other");
	check("example-provider- capture is pi", classify({ cmd: "srun", title: "x", capture: "example-provider-eval" }), "pi");
	check("napkin distill is pi", classify({ cmd: "bash", title: "x", capture: "napkin distill" }), "pi");
	check("ponytail is pi", classify({ cmd: "srun", title: "x", capture: "ponytail" }), "pi");

	check("parseSrun equals", parseSrun("srun --jobid=12 --nodelist=s01n02"), { jobid: "12", nodelist: "s01n02" });
	check("parseSrun spaces + -w", parseSrun("srun --jobid 99 -w s02n08"), { jobid: "99", nodelist: "s02n08" });

	check("parseCtx last pct", parseCtx("10%\nctx 27.2%\n"), "27.2%");
	check("parseCtx none", parseCtx("no numbers"), undefined);

	const listed = formatList(d);
	check("formatList prints host", listed.startsWith("host login-node"), true);
	check("formatList default is pi only", listed.includes("train:2.0") && !listed.includes("chat:1.0") && !listed.includes("cl:1.1"), true);
	check("formatList --all keeps grok+claude", formatList(d, { all: true }).includes("chat:1.0") && formatList(d, { all: true }).includes("cl:1.1"), true);
	check("formatList job/node col", listed.includes("7654321/s11n23"), true);

	check("sshHosts skips wildcards, keeps aliases", sshHosts(SSH_CFG), ["gateway", "foo", "bar"]);
	check("paneId filesystem-safe", paneId("train:2.0"), "train-2.0");
	check("pi title with pi glyph", classify({ cmd: "bash", title: "π - 0821-review-prs", capture: "" }), "pi");
	check("isHerdrSpec", isHerdrSpec("w6:p1") && !isHerdrSpec("review:1.0"), true);

	const herdrJson = JSON.stringify({
		id: "cli:pane:list",
		result: {
			panes: [
				{
					pane_id: "w6:p1",
					agent: "pi",
					cwd: "/home/user/dev/example-project",
					terminal_title: "π - 0821-review-prs - ai-obiza-finger-task",
				},
			],
			type: "pane_list",
		},
	});
	const hp = parseHerdrPanes(herdrJson);
	check("herdr pane spec", hp[0]?.spec, "w6:p1");
	check("herdr pane agent", hp[0]?.agent, "pi");
	check("herdr pane via", hp[0]?.via, "herdr");
	const merged = mergeHerdr(d, herdrJson);
	check("merge adds herdr pane", merged.panes.some((p) => p.spec === "w6:p1"), true);
	check("parseHerdr NONE", parseHerdrPanes("HERDR_NONE"), []);

	const n = pass + fail;
	if (fail) {
		console.error(`\nSELFTEST FAIL ${pass}/${n}`);
		process.exit(1);
	}
	console.error(`\nSELFTEST PASS ${pass}/${n}`);
	process.exit(0);
}
