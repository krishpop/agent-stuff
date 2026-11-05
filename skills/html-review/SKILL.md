---
name: html-review
description: Write up an investigation as a single self-contained HTML page a human can read and act on — plain-language findings, an honest works/doesn't-work status, and a short list of decisions the user must make. Use when the user says "/html-review", "write this up as html", "make a review page", "summarize findings in a page I can read", or at the end of a debugging or research session that ends in choices rather than a fix.
---

# html-review

Turn what you just figured out into one HTML file the user can open, read once,
and decide from.

## When

End of an investigation whose output is *understanding plus choices*, not a
committed fix. If the answer is one line, say the one line — don't build a page.

## Steps

1. **Gather from the session**, not from a fresh investigation. Everything on
   the page must already be established. No new claims, no guesses dressed as
   findings. If something is unverified, it goes under "Unknown".
2. **Draw the mechanism** as one Mermaid diagram (see *Diagrams* below). Print it
   in the chat turn as a ```mermaid fence — pi renders it in the TUI — and embed
   the same source in the page.
3. **Pick an output path.** Default `./html-review-<slug>-<YYYYMMDD>.html` in the
   cwd. If the user names a path, use it. Never overwrite without asking.
4. **Copy `template.html`** (next to this file) and fill the sections.
5. **Check it**: `python3 -c "import html.parser,sys;p=html.parser.HTMLParser();p.feed(open(sys.argv[1]).read())" <file>`
   then print the absolute path. Do not call cmux (it does not run on
   cluster login nodes). If `HERDR_ENV=1`, open a sibling pane at the
   file's directory and leave the HTML for the human to open:

   ```bash
   herdr pane split --current --direction right --cwd "$(dirname FILE)" --no-focus
   herdr pane rename <pane_id> "html-review"
   ```

   Print `pane_id` and the absolute path. Do not `pane run` a browser —
   login nodes have none. If not inside Herdr, print the path only.

## Diagrams

One diagram per claim, one to three per page. Draw them before writing prose —
if you can't draw the mechanism you haven't understood it yet.

Rules borrowed from the visual-explainer skill (`.../plugins/visual-explainer/SKILL.md`,
"Mermaid invariants"), condensed:

- Depict the **mechanism**, not its name: the path a request actually takes,
  not a box labelled "cache".
- **Label every arrow** (`writes`, `invalidates`, `polls every 30s`). An
  unlabelled arrow only says "related somehow".
- One figure, one claim; the `<figcaption>` states that claim in words.
- To compare options, draw only the **difference** — the edge each adds or removes.
- `flowchart TD` by default; `LR` only for 3–4 node linear flows; `sequenceDiagram`
  for who-calls-whom-when; `stateDiagram-v2` for lifecycle bugs.
- `<br/>` inside quoted labels, never `\n`. Keep it under ~12 nodes — split
  rather than cram.
- Mark the broken path: `classDef bad` / `classDef unk` are predefined in the
  template's Mermaid theme, matching the works/doesn't-work/unknown colours.

Good default: one flowchart of the system with the failing edge highlighted,
placed right after the Findings section.

## Relationship to visual-explainer

This skill stays a two-screen decision memo. Borrow from visual-explainer only:
the Mermaid invariants above, and its "Design judgment" section if you deviate
from `template.html`'s palette. Do **not** pull in slides, quick mode, themes
pickers, generated images, zoom/pan diagram shells, or the `visual_explainer`
render tool — a review page must stay printable and greppable.

If the user wants the full treatment ("make it pretty", a deck, a recap), stop
and use visual-explainer instead.

## The three sections

**a) Findings — minimal jargon.** What is actually going on. Each finding is a
claim plus its evidence (file:line, command output, log excerpt). Expand every
acronym on first use. If a sentence needs domain knowledge the user may lack,
rewrite it. No narrative of your debugging process — the conclusion only.

**b) Status — works / doesn't work / unknown.** Three explicit buckets. Be
blunt in "doesn't work"; a hedge here costs the user a day. "Unknown" is not a
failure, it is the honest bucket, and an empty "Unknown" on a hard problem is a
lie.

**c) Decisions.** Each is a question only the user can answer, with:
- the options (2–4, no more),
- the cost / consequence of each,
- your recommendation and one line of why.

If a "decision" has an obvious right answer, it isn't a decision — do it or put
it in Findings.

## Rules

- One file. Inline CSS, no fonts. The only permitted script/CDN is the Mermaid
  bundle in `template.html`; offline it degrades to the readable diagram source,
  so the page still works. Nothing else gets JS.
- Diagrams live in `<figure>` with a `<figcaption>` stating the claim.
- Fits on roughly two screens. Anything longer means the findings aren't
  distilled yet.
- Nothing on the page that the user cannot act on or verify.
- Link evidence as plain text paths, not as claims to trust.
