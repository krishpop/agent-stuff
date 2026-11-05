/**
 * Curvy Greek pi in braille. Downsampled 4x from the source art (pi.txt,
 * 65x33 cells) by decoding to a 130x132 dot bitmap, box-filtering 4x4 with a
 * 5/16 ink threshold, and re-encoding. Braille is width 1, so centring holds.
 */

export const ART = [
	"⠀⡴⢾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
	"⢼⠏⠉⠀⢽⡇⠀⠀⢸⣿⠏",
	"⠁⠀⠀⠀⣿⡇⠀⠀⢸⣿⡇",
	"⠀⠀⠀⢰⣿⡇⠀⠀⢾⣿⡇",
	"⠀⠀⢠⣿⣿⠁⠀⠀⣿⣿⡇⠀⠀⢀",
	"⠀⡰⣿⣿⣿⠀⠀⠀⣿⣿⣧⡀⢠⣿",
	"⠀⡻⣿⣿⠃⠀⠀⠀⠙⣿⣿⣿⠟⠁",
];

/** Braille blank renders as whitespace -- no point colouring it. */
const BLANK = new Set([" ", "\u2800"]);

export const ART_WIDTH = Math.max(...ART.map((l) => [...l].length));

/** Deep -> ice. Index 0..5. */
const RGB: Array<[number, number, number]> = [
	[23, 55, 121],
	[30, 78, 168],
	[37, 99, 235],
	[59, 130, 246],
	[125, 185, 255],
	[205, 230, 255],
];
const XTERM = [17, 25, 26, 33, 75, 153];

const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const RESET = "\x1b[0m";
export const BAND = 7;
/** Park the highlight off-canvas to settle on the base gradient. */
export const STATIC_PHASE = -9999;

export function esc(i: number): string {
	if (!TRUECOLOR) return `\x1b[38;5;${XTERM[i]}m`;
	const [r, g, b] = RGB[i];
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Base blue per row, brightened by a travelling highlight centred on `phase`. */
export function shade(x: number, row: number, phase: number): number {
	const base = row <= 1 ? 3 : 2; // bar reads brighter than the legs
	const dist = Math.abs(x - phase);
	const pulse = dist >= BAND ? 0 : 1 - dist / BAND;
	return Math.max(0, Math.min(RGB.length - 1, base + Math.round(pulse * 2)));
}

/** Colour one art row, emitting an escape only when the shade changes. */
export function paint(line: string, row: number, phase: number): string {
	let out = "";
	let cur = -1;
	const chars = [...line];
	for (let x = 0; x < chars.length; x++) {
		const ch = chars[x];
		if (BLANK.has(ch)) {
			out += ch;
			continue;
		}
		const s = shade(x, row, phase);
		if (s !== cur) {
			out += esc(s);
			cur = s;
		}
		out += ch;
	}
	return cur >= 0 ? out + RESET : out;
}

/** Which sides each glyph joins: u/d/l/r. Every glyph joins exactly two. */
const LINKS: Record<string, string> = { "─": "lr", "│": "ud", "╭": "rd", "╮": "ld", "╰": "ur", "╯": "ul" };
const OPP: Record<string, string> = { u: "d", d: "u", l: "r", r: "l" };
const STEP: Record<string, [number, number]> = { u: [-1, 0], d: [1, 0], l: [0, -1], r: [0, 1] };

/**
 * Every stroke end must meet a neighbour that joins back, so the outline is
 * closed. Catches dangling stubs and legs accidentally welded together.
 */
export function outlineDefects(art: string[] = ART): string[] {
	const grid = art.map((l) => [...l]);
	const at = (r: number, c: number) => grid[r]?.[c] ?? " ";
	const bad: string[] = [];
	for (let r = 0; r < grid.length; r++) {
		for (let c = 0; c < grid[r].length; c++) {
			const links = LINKS[at(r, c)];
			if (!links) continue;
			for (const dir of links) {
				const [dr, dc] = STEP[dir];
				const back = LINKS[at(r + dr, c + dc)];
				if (!back?.includes(OPP[dir])) bad.push(`${r},${c} '${at(r, c)}' dangles ${dir}`);
			}
		}
	}
	return bad;
}

export function pad(width: number): string {
	return " ".repeat(Math.max(0, Math.floor((width - ART_WIDTH) / 2)));
}

export function renderBanner(width: number, subtitle: string, phase: number): string[] {
	const left = pad(width);
	const lines = ART.map((line, row) => left + paint(line, row, phase));
	return ["", ...lines, "", left + subtitle, ""];
}
