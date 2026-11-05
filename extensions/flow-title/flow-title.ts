/**
 * flow-title — replaces the pi startup header with a curvy blue Greek pi
 * that shimmers on load. Animation is a fixed intro (a few sweeps) rather
 * than a forever-timer: the header scrolls away once you start talking.
 *
 * /flow-title        replay the shimmer
 * /flow-title off    restore the built-in header
 */
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { ART_WIDTH, BAND, STATIC_PHASE, renderBanner } from "./art.ts";

const STEP_MS = 45;
const SWEEPS = 3;

export default function flowTitle(pi: ExtensionAPI) {
	function install(ctx: ExtensionContext) {
		ctx.ui.setHeader((tui, theme) => {
			let phase = -BAND;
			let sweeps = 0;
			let timer: ReturnType<typeof setInterval> | undefined;

			const stop = () => {
				if (timer) clearInterval(timer);
				timer = undefined;
			};
			timer = setInterval(() => {
				phase += 1;
				if (phase > ART_WIDTH + BAND) {
					phase = -BAND;
					if (++sweeps >= SWEEPS) {
						phase = STATIC_PHASE;
						stop();
					}
				}
				tui.requestRender();
			}, STEP_MS);
			timer.unref?.();

			return {
				render(width: number): string[] {
					const subtitle =
						theme.fg("muted", `π  pi v${VERSION}`) + theme.fg("dim", `  ·  ${basename(process.cwd())}`);
					return renderBanner(width, subtitle, phase);
				},
				invalidate() {},
				dispose() {
					stop();
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") install(ctx);
	});

	pi.registerCommand("flow-title", {
		description: "Replay the pi banner shimmer (/flow-title off restores the built-in header)",
		handler: async (args, ctx) => {
			if ((args ?? "").trim() === "off") {
				ctx.ui.setHeader(undefined);
				ctx.ui.notify("Built-in header restored", "info");
				return;
			}
			install(ctx);
		},
	});
}
