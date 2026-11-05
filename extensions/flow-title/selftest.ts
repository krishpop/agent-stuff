import { ART, ART_WIDTH, STATIC_PHASE, paint, pad, renderBanner, shade } from "./art.ts";

const isBraille = (c: string) => c >= "\u2800" && c <= "\u28ff";

export default function (_pi: unknown) {
	let pass = 0;
	let fail = 0;
	const check = (name: string, got: unknown, want: unknown) => {
		if (JSON.stringify(got) === JSON.stringify(want)) pass++;
		else {
			fail++;
			console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
		}
	};

	// Braille is width 1. Anything else (blocks, emoji) would break centring.
	const wide = ART.flatMap((l) => [...l]).filter((c) => c !== " " && !isBraille(c));
	check("only braille glyphs", wide, []);
	check("art width", ART_WIDTH, 14);
	check("art rows", ART.length, 7);

	// Centering.
	check("centred in 80", pad(80).length, 33);
	check("no negative pad when narrow", pad(10).length, 0);

	// Shimmer: highlight is brighter at the head than far away.
	check("pulse brightens", shade(10, 3, 10) > shade(10, 3, 40), true);
	check("settled phase is base", shade(10, 3, STATIC_PHASE), shade(10, 3, 9999));
	check("bar is brighter than legs", shade(5, 0, STATIC_PHASE) > shade(5, 4, STATIC_PHASE), true);

	// Painting emits colour and always resets.
	const line = paint(ART[0], 0, 5);
	check("emits an SGR", line.includes("\x1b[38;"), true);
	check("resets at end", line.endsWith("\x1b[0m"), true);
	// Braille blank is background: never coloured, so no stray escapes.
	check("braille blank uncoloured", paint("\u2800\u2800", 3, 0), "\u2800\u2800");
	check("spaces stay uncoloured", paint("   ", 3, 0), "   ");

	check("banner rows", renderBanner(80, "sub", 0).length, ART.length + 4);

	console.error(`SELFTEST ${fail === 0 ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
	if (fail) throw new Error("flow-title selftest failed");
}
