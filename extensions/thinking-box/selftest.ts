/** Run: pi -e extensions/thinking-box/selftest.ts -p x */
import { visibleWidth } from "@earendil-works/pi-tui";
import { estimateTokens, stripThinkingLabel, ThinkingBox } from "./box.ts";

const theme = { fg: (_c: string, s: string) => s };
const child = { render: (w: number) => ["hello world", "x".repeat(w + 10)] };

const lines = new ThinkingBox(child, theme, 1240, false).render(40);
console.assert(lines.length === 4, "top + 2 body + bottom");
console.assert(lines.every((l) => visibleWidth(l) === 40), `every line is 40 wide: ${lines.map(visibleWidth)}`);
console.assert(lines[0].startsWith("╭─ thinking ") && lines[0].endsWith(" ~1,240 tok ╮"), lines[0]);
console.assert(lines[3] === `╰${"─".repeat(38)}╯`, "bottom");
console.assert(new ThinkingBox(child, theme, 512, true).render(40)[0].includes(" 512 tok "), "exact has no ~");
console.assert(estimateTokens("\x1b[31mabcdefgh\x1b[0m") === 2, "ansi stripped before /4");
const tall = { render: () => Array.from({ length: 20 }, (_, i) => `line ${i}`) };
const capped = new ThinkingBox(tall, theme, 10, true, () => 5, "ctrl+o").render(50);
console.assert(capped.length === 7, `top + 5 + bottom, got ${capped.length}`);
console.assert(capped[1].startsWith("│line 15") && capped[5].startsWith("│line 19"), "keeps the tail");
console.assert(capped[6].includes("↑ 15 earlier lines · ctrl+o to expand"), capped[6]);
console.assert(capped.every((l) => visibleWidth(l) === 50), `capped widths: ${capped.map(visibleWidth)}`);
console.assert(new ThinkingBox(tall, theme, 10, true).render(50).length === 22, "uncapped by default");
console.log(capped.join("\n"));
const A = "\x1b[36m", Z = "\x1b[39m";
console.assert(
	stripThinkingLabel(`${A}Thinking:${Z} ${A}one${Z}\n\n${A}Thinking:${Z} two`) === `${A}one${Z}\n\ntwo`,
	"strips colored prefix from each joined block",
);
console.assert(stripThinkingLabel("I keep Thinking: here") === "I keep Thinking: here", "mid-line kept");
console.log(lines.join("\n"));
console.log("thinking-box selftest done");
export default function () {}
