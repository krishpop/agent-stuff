# Writing the lesson

The reader is about to own code they did not write. Every sentence either
builds their model of the change or gets cut.

Sources: explain-diff-html's writing rules (MIT, github.com/malav2110/explain-diff-html),
pstack's `teach` skill, and html-review's diagram rules.

## Three rules that bind every field

1. **Mark every inference as yours.** The record rarely says why code has its
   shape, so explaining the shape is most of the value. When you work out a
   reason the record does not give, say so: "that appears to be why the check
   sits first, though nothing in the code says so". Never write "this is a
   deliberate extension point", "this looked harmless for years", or "the
   reason it changed was" without a quote. Invented numbers and durations count
   too. One invented motive costs the reader's trust in the whole page. Use
   `"inferred": true` on a step, and `"source": "inferred"` on an intent.
2. **Introduce every name before the walkthrough uses it.** List the
   identifiers the steps mention. Each one appears in Background or Intuition
   with a one-line definition first. Naming the chain a value travels through,
   in order, before walking it, is usually enough.
3. **State the value a mechanism turns on.** When the change hinges on a
   number, flag, threshold, or timeout, put the value on the page:
   `attempts=3`, `episode_length: 45 → 67`, not "a longer horizon".

## Tracks and focus

A reader loses the thread long before the page runs out of facts. Design for the first pass:

- **Split by question, not by file.** Ask what a reviewer would ask ("what does it pay
  for?", "why will gradients grow?", "will the job start?"). Each question with its own
  reasoning is a track. Launch plumbing, config layering, and tests are usually `context`
  tracks; the behavior the session cares about is `focus`.
- **Rank the tracks.** Put first what the reader must understand to trust the change.
- **Lead with the point.** A track's `summary` and each step's first sentence carry the
  claim. The derivation, the second copy of a setting, the import alias, and the test list
  go into `detail` steps.
- **Budgets** (the checker warns past them): `tldr` 400 characters, a track `summary` 450,
  4 core steps per track, 900 characters per core step body, 3 questions per track.

## Sections

- **tldr**: the whole change in one or two sentences. Lead with the effect.
- **intents**: one per user request. Quote the request verbatim in `quote`.
  `partial` and `missing` are the most useful statuses on the page; do not
  round them up to `done`. Changes that serve no request go in `unasked`, in
  plain words, with targets.
- **background.deep**: the general idea for someone new to it, starting from a
  plain definition (what a retry is, what a config layer is). **narrow**:
  exactly the code the change touches, as it was before.
- **intuition**: the core idea with toy data, before any code. A reader who
  stops here should still be able to predict the change's behaviour.
- **steps**: three to eight. One logical change per step, even when it spans
  files. Order by flow: where the change is entered (a request, a CLI flag, a
  config layer, an event), through each layer, to where the effect lands.
  Open each body with what the step does, then why, then what it connects to.
  Use the project's own layer names. Tests go in a `verification` step near the
  end. Renames and formatting go in a `mechanical` step.
- **unknowns**: the honest bucket. List what nobody ran or checked, and what
  would settle it.

## Diagrams

- Depict the mechanism, not its name: the path a value actually takes, not a
  box labelled "cache".
- Label every arrow with example data (`user_id=42`, `episode_length=67`).
- One figure makes one claim, and its caption states that claim.
- For three or more moving parts, use a frame series: each frame redraws the
  last and adds one part (pstack `teach`). One all-at-once picture is a
  reference, not teaching.
- Use Mermaid only for state machines, sequences with real waits or replies,
  and containment. Keep it under about 12 nodes. Use `<br/>` inside quoted
  labels.

## Prose

Plain spoken English, as you would explain it to a colleague. One idea per
sentence. Active voice, with the actor named. Give each concept one name and
keep it; on a page about test files, a boolean condition is a "check", not a
"test". Vary sentence length.

Cut these tells: inflated significance (pivotal, crucial), promotional words
(seamless, robust, powerful), AI vocabulary (delve, leverage, utilize,
underscore, at its core), trailing "-ing" significance clauses, vague
attribution ("many developers"), "not only X but also Y", reflexive rule of
three, em dashes, decorative bold, filler ("it is important to note"), stacked
hedges, signposting ("in this section we will"), a closing paragraph that
praises the change, systems metaphors used as decoration (orchestration,
under the hood), and invented capitalised terms.

Density failures matter more than word choice:

- shorthand used before its definition;
- an identifier cited only as `file:line`, never named;
- a back-reference that points past several examples;
- noun stacks ("the flag-rendering match arms" → "the match arms that render
  each flag");
- narrating your search instead of stating the result;
- a count or diffstat with no consequence for the reader.

## The verify pass

The subagent in step 7 reads the lesson cold and answers:

- Which sentences assert a motive, intent, history, or duration the record does
  not show? Quote the record or cut the sentence.
- Where did you lose the thread? Which terms appear before they are introduced?
- Does Intuition give the core idea before the walkthrough, or ask the reader
  to wait for it?
- Does every intent marked `done` have a step that implements it?
