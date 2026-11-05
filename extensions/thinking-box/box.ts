import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface BoxTheme {
	fg(color: string, text: string): string;
}

interface Renderable {
	render(width: number): string[];
	invalidate?(): void;
}

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

/** Drop pi-tool-display's per-block "Thinking: " prefix (the box title says it). */
export const stripThinkingLabel = (text: string) =>
	text.replace(/^(?:\x1b\[[0-9;]*m)*Thinking:(?:\x1b\[[0-9;]*m)*[ \t]*/gm, "");

/** Same heuristic as pi's estimator and pi-token-counter: chars / 4. */
export const estimateTokens = (text: string) => Math.ceil(text.replace(ANSI, "").length / 4);

/** pi-token-counter thresholds: <1k accent, <5k warning, else error. */
export function tokenLabel(theme: BoxTheme, tokens: number, exact: boolean): string {
	const color = tokens < 1000 ? "accent" : tokens < 5000 ? "warning" : "error";
	return theme.fg(color, `${exact ? "" : "~"}${tokens.toLocaleString("en-US")} tok`);
}

/**
 * Rounded border around a thinking component, title left, token count top-right.
 * `maxBody()` caps body rows; overflow keeps the tail (latest reasoning) and the
 * bottom border reports the hidden count plus `hint` (the expand key).
 */
export class ThinkingBox implements Renderable {
	constructor(
		readonly child: Renderable,
		private readonly theme: BoxTheme,
		private readonly tokens: number,
		private readonly exact: boolean,
		private readonly maxBody: () => number = () => Infinity,
		private readonly hint = "ctrl+o",
	) {}

	invalidate() {
		this.child.invalidate?.();
	}

	render(width: number): string[] {
		const t = this.theme;
		const b = (s: string) => t.fg("border", s);
		const inner = Math.max(1, width - 2);
		const title = t.fg("dim", " thinking ");
		const count = ` ${tokenLabel(t, this.tokens, this.exact)} `;
		const fill = Math.max(0, inner - 1 - visibleWidth(title) - visibleWidth(count));
		const top = b("╭─") + title + b("─".repeat(fill)) + count + b("╮");
		const all = this.child.render(inner);
		const max = Math.max(1, this.maxBody());
		const hidden = Math.max(0, all.length - max);
		const body = all.slice(hidden).map((line) => {
			const fit = truncateToWidth(line, inner, "");
			return b("│") + fit + " ".repeat(Math.max(0, inner - visibleWidth(fit))) + b("│");
		});
		let bottom = b(`╰${"─".repeat(inner)}╯`);
		if (hidden) {
			const note = t.fg("dim", ` ↑ ${hidden} earlier lines · ${this.hint} to expand `);
			const rest = Math.max(0, inner - 1 - visibleWidth(note));
			bottom = truncateToWidth(b("╰─") + note + b(`${"─".repeat(rest)}╯`), width, "");
		}
		return [truncateToWidth(top, width, ""), ...body, bottom];
	}
}
