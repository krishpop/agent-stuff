/**
 * thinking-box — wraps each run of thinking blocks in a rounded box with the
 * token count in the top-right corner (styled like pi-token-counter).
 *
 * Count is the provider's real `usage.reasoning` when the message has a single
 * thinking run and reports it; otherwise `~N` = visible chars / 4 (providers
 * that summarize reasoning make the estimate an undercount).
 *
 * Body is capped to ~1/3 of the terminal (tail shown). Ctrl+O (app.tools.expand)
 * expands/collapses it together with tool output: the box reads
 * ctx.ui.getToolsExpanded() on every render, and the toggle's status line already
 * requests one. No cached copy, so it cannot drift from the tool state.
 *
 * Works by patching AssistantMessageComponent.updateContent: run the original,
 * then wrap the thinking children it produced. Restored on shutdown.
 */
import { AssistantMessageComponent, type ExtensionAPI, keyText } from "@earendil-works/pi-coding-agent";
import { type BoxTheme, estimateTokens, stripThinkingLabel, ThinkingBox } from "./box.ts";

const ORIGINAL = Symbol.for("thinking-box.original-updateContent");

type Ui = { theme?: BoxTheme; getToolsExpanded?(): boolean };

// Never let a stale ctx (after /reload or session switch) throw inside render.
const safe = <T>(f: () => T, fallback: T): T => {
	try {
		return f() ?? fallback;
	} catch {
		return fallback;
	}
};

type Child = { render(w: number): string[]; setText?(t: string): void; text?: string; defaultTextStyle?: { italic?: boolean }; child?: Child };
type Msg = { content: { type: string; thinking?: string }[]; usage?: { reasoning?: number } };

/** Thinking text per run, in render order (mirrors updateContent's grouping). */
function thinkingRuns(message: Msg): string[] {
	const runs: string[] = [];
	let cur: string[] | undefined;
	for (const c of message.content) {
		if (c.type !== "thinking") {
			if (cur?.length) runs.push(cur.join("\n\n"));
			cur = undefined;
			continue;
		}
		cur ??= [];
		const t = c.thinking?.trim();
		if (t) cur.push(t);
	}
	if (cur?.length) runs.push(cur.join("\n\n"));
	return runs;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export default function thinkingBox(pi: ExtensionAPI) {
	const proto = AssistantMessageComponent.prototype as any;
	let ui: Ui | undefined;
	// Live theme: follows /settings theme switches without a reload.
	const plain: BoxTheme = { fg: (_c, s) => s };
	const theme: BoxTheme = { fg: (c, s) => safe(() => (ui?.theme ?? plain).fg(c, s), s) };
	// 1/3 of the screen minus the two border rows; unlimited while tools are expanded.
	const maxBody = () =>
		safe(() => ui?.getToolsExpanded?.(), false)
			? Infinity
			: Math.max(3, Math.floor((process.stdout.rows || 24) / 3) - 2);

	pi.on("session_start", async (_e, ctx) => {
		ui = ctx.ui as unknown as Ui;
		if (proto[ORIGINAL]) return;
		const hint = safe(() => keyText("app.tools.expand"), "") || "ctrl+o";
		const original = proto.updateContent;
		proto[ORIGINAL] = original;
		proto.updateContent = function (this: any, message: Msg, ...rest: unknown[]) {
			original.call(this, message, ...rest);
			if (!ui) return;
			const runs = thinkingRuns(message);
			if (!runs.length) return;
			const reasoning = message.usage?.reasoning;
			const exact = runs.length === 1 && !!reasoning;
			const label: string = this.hiddenThinkingLabel ?? "";
			const kids: Child[] = this.contentContainer?.children ?? [];
			let run = 0;
			for (let i = 0; i < kids.length && run < runs.length; i++) {
				// Newer pi wraps the thinking component in a click-to-toggle MouseRegion.
				const holder = kids[i].child ? kids[i] : undefined;
				const node = holder?.child ?? kids[i];
				const isThinking =
					node.defaultTextStyle?.italic === true ||
					(!!label && typeof node.text === "string" && strip(node.text) === label);
				if (!isThinking) continue;
				if (node.defaultTextStyle?.italic && node.text && node.setText) {
					const text = stripThinkingLabel(node.text);
					if (text !== node.text) node.setText(text);
				}
				const tokens = exact ? reasoning! : estimateTokens(stripThinkingLabel(runs[run]));
				const box = new ThinkingBox(node, theme, tokens, exact, maxBody, hint);
				if (holder) holder.child = box;
				else kids[i] = box;
				run++;
			}
		};
	});

	pi.on("session_shutdown", async () => {
		if (proto[ORIGINAL]) {
			proto.updateContent = proto[ORIGINAL];
			delete proto[ORIGINAL];
		}
		ui = undefined;
	});
}
