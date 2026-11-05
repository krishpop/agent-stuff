# lesson.json, version 1

One JSON object. The model writes content and anchors. `lesson.mjs` renders
every code excerpt from the changeset, so code never appears in the JSON.

**Prose fields** accept a small Markdown subset: paragraphs, `-` and `1.`
lists, fenced code blocks, inline code, `**bold**`, `*italic*`, and
`[text](https://…)` links. `[[path:12-18]]` is a checked code reference.
`[[path:12]]` refers to one line, and `[[path:5-9|old]]` refers to the old
side. A reference inside a hunk shows the diff lines; elsewhere it shows the
file at the head.

**Targets** point at changed lines:
`{"path", "side": "new"|"old", "start", "end", "highlight"?, "note"?}`.
`start`–`end` (1-based, inclusive) must sit inside one changed hunk on that
side. Copy the numbers from `annotated.txt`. Use `"old"` for deleted files and
for code as it was before the change. `highlight` is an exact substring of a
target line; the page marks it, and the tour lights it up in Hunk.

## Top level

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | Required. |
| `stance` | `"lesson"` \| `"memo"` | Default `lesson`. `memo` is html-review's stance. |
| `title` | string | Required. What the change does, in plain words. |
| `tldr` | prose | Required. One or two sentences: the whole change. |
| `date` | `YYYY-MM-DD` | Optional; defaults to today. |
| `provenance` | string | Optional; default is built from the changeset. |
| `intents` | intent[] | What the session asked for. |
| `unasked` | `{text, targets?}`[] | Changes that serve no intent. |
| `background` | `{deep?, narrow?}` | `deep` is folded ("new to this code?"). `narrow` covers exactly the code the change touches. |
| `intuition` | prose | The core idea, with a toy example. |
| `diagrams` | diagram[] | The first one is "the change in one picture". |
| `tracks` | track[] | Parallel walkthroughs, one question each, ranked. Use them past 6 steps or 12 code targets, or whenever the change has independent concerns. With tracks, `steps`, `quiz`, `tryIt`, and `experiment` live inside tracks. |
| `steps` | step[] | The walkthrough, in flow order, when the lesson has no tracks. |
| `experiment` | experiment | When configs or a launch command are involved. |
| `quiz` | question[] | 3 to 5 for `lesson`; optional for `memo`. |
| `tryIt` | exercise[] | 1 to 3. |
| `unknowns` | prose[] | Claims nobody verified. An empty list on a hard change is suspicious. |
| `decisions` | decision[] | Open choices for the human (e.g. "launch as proposed?"). |
| `connections` | link[] | Related runs, evals, dashboards, wiki pages, notes. |
| `skipped` | `{path, reason}`[] | Files left out on purpose (generated, vendored, lockfiles). |
| `findings`, `status` | see memo | html-review's stance. |

## Objects

**track**: `{id, title, priority, question, why?, summary, intents?, steps, quiz?, tryIt?, unknowns?, experiment?}`

- One question per track, answered by its own short walkthrough. A track reads on its own;
  if it needs another track first, say so in `why`.
- `priority`: `focus` (what the reader must understand) or `context` (background they can
  open when needed). Order the array by importance, with focus tracks first.
- `summary`: the point of the track in two or three sentences, shown before any code.
- Ids share one namespace with steps, intents, and questions; do not reuse a step id.
- The page opens on an Overview tab (the whole change, the ranked tracks, the intent map),
  with one tab per track. Lesson-level `unknowns`, `decisions`, and `connections` show on the
  Overview.

**intent**: `{id, text, quote?, source, status, evidence?}`

- `source`: `user` (quote the words), `pr`, `commit`, `notes`, `decision-log`,
  or `inferred`.
- `status`: `done`, `partial`, or `missing`. `missing` means no change
  implements it, and the page says so.

**step**: `{id, title, kind?, intents?, body, targets, inferred?, detail?}`

- `kind`: `change` (default), `verification` (tests), `supporting`, or
  `mechanical` (folded on the page). hunk-guide hides `supporting` and
  `mechanical` by default, so an experiment's config steps are `change`.
- `intents`: ids of the intents this step serves.
- `inferred: true` when the step's "why" is your reasoning, not the record's.
- `detail: true` folds the step away in Essentials mode (the default) and makes it
  `supporting` in hunk-guide. Use it for the arithmetic, the plumbing, and the second copy
  of a setting: anything a reader skips on first pass.
- The first two targets show; the rest fold under "more code excerpts".

**diagram**:
`{id, kind: "flow"|"mermaid", caption, frames?, nodes?, edges?, source?, section?}`

- `caption` states the one claim the figure makes.
- `flow`: `nodes: [{id, label, tone?}]`, `edges: [{from, to, label}]`. Tones:
  `touch` (what the change touches), `ok`, `bad`, `unk`. Label every edge with
  example data.
- `frames`: a series of `{nodes, edges, caption}`, each adding one part. The
  page steps through them ("add the next part"). Prefer a series over one big
  picture.
- `mermaid`: `source` holds Mermaid text. Use it only for state, sequence, or
  containment diagrams. The page loads Mermaid from a CDN and shows the source
  when offline.
- `section: "intuition"` places a diagram in Intuition. Other diagrams after
  the first go to "More pictures".

**question**: `{id, shape, stem, options: [{text, correct?, feedback}]}`. Read
`quiz.md`.

**exercise** (`tryIt`):
`{id, title, predict, command, cwd?, lookFor?, expect, launches?, timeoutSec?}`.
Read `quiz.md`.

**experiment**:

```json
{
  "hypothesis": "prose: what the session expects to change, and how it will tell",
  "approximate": false,
  "baseline": {"label": "c000", "command": "…", "run": {"id": "example-run", "url": "https://example.com/runs/example-run"}},
  "proposed": {"label": "c003", "command": "…"},
  "tokens": [{"text": "--max-iters 400", "role": "flag", "explain": "prose", "changed": "changed"}],
  "layers": [{"path": "…/horizon15.yaml", "status": "added", "role": "prose"}],
  "deltas": [{"key": "training.episode_length", "before": 45, "after": 67,
              "setBy": "[3] horizon15.yaml:13", "status": "intended", "intent": "longer-horizon", "note": "prose"}],
  "notes": "prose"
}
```

- `deltas[].status`: `intended` (serves a stated hypothesis; give `intent`),
  `unexplained` (no intent asked for it), `shadowed` (a layer sets it but a
  later layer or a CLI flag wins, so the edit does nothing), or `missing` (an
  intent with no delta).
- `layers[].status`: `same`, `edited`, `copied`, `added`, `removed`, or
  `moved`. Copy these from `compare.json`.
- `tokens[].role`: `env`, `launcher`, `program`, `layer`, `flag`, or
  `override`. `changed`: `added`, `removed`, or `changed`.

**decision**:
`{question, options: [{label, meaning, cost?}], recommend?: {option, why}}`,
with 2 to 4 options.

**link** (`connections`):
`{kind: "run"|"eval"|"dashboard"|"wiki"|"note"|"pr"|"issue"|"other", label, url, why?}`.
Only http(s) URLs, and only links you have confirmed.

## Memo stance (html-review)

`{"stance": "memo", "findings": [{claim, evidence?}], "status": {works: [], broken: [], unknown: []}, "decisions": [...]}`.
`findings[].evidence` uses `[[path:a-b]]` references. Steps are optional. When
the investigation produced a fix, two to four steps render as "The proposed
change".
