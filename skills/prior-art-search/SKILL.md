---
name: prior-art-search
description: Use this skill when the user (or an upstream skill like pos-sprint) needs to investigate prior art before designing or implementing a feature — "is this already in [library/paper/tool]?", "what's the state of the art for X?", "did anyone solve this already?", "/prior-art". Searches implementation registries (crates.io, GitHub, docs.rs), research sources (arxiv, alphaxiv, huggingface-papers), and architectural sources (exa, deepwiki, notebooklm), then writes a structured RAG-friendly entry to `~/dev/notebook/prior-art/<slug>.md`. Do NOT use for trivial one-line fixes or for documentation lookups about a tool already chosen.
---

# prior-art-search: structured investigation of what already exists

You answer "did someone already do this?" with a structured, persistent
record. The output of every run is a markdown file at
`~/dev/notebook/prior-art/<slug>.md` (committed to the `notebook` git
repo, symlinked from `~/current_feature_notes/prior-art/`) plus a
one-line verdict surfaced back to the caller.

The point of persistence: the next time anyone asks "did we look at X?",
they `grep ~/dev/notebook/prior-art/` instead of re-running the search.
When `pos-memory` MCP lands (POS v1.0 #12), these files become
RAG-queryable via `memory.recall` with `tags: ["prior-art", ...]`.

---

## Prerequisites

- `~/dev/notebook/prior-art/` exists and the `notebook` repo is
  reachable (`git -C ~/dev/notebook status` works). Symlink
  `~/current_feature_notes/prior-art` → `~/dev/notebook/prior-art` is
  the convenience path.
- `~/dev/notebook/prior-art/README.md` exists and documents the
  frontmatter schema + file layout. If it's missing, halt and tell the
  user to set up the directory first.
- At minimum, `WebFetch` and `WebSearch` available. MCP-based sources
  are nice-to-have; degrade gracefully when missing.

---

## Skill invocation contract (for upstream skills)

**Inputs** (when called by another skill, e.g. pos-sprint step 2.5):
- `trigger` — string. The reason for the search (e.g., `"pos v1.0 #N — registry scanner"`).
- `query` — string. One-paragraph semantic description of what's being looked for.
- `hint_sources` — optional list. Source names to prefer if the caller already knows the question shape (e.g., `["arxiv", "huggingface-papers"]`).

**Returns** (single message, parseable shape — upstream skills grep for these line prefixes):

```
ENTRY: ~/dev/notebook/prior-art/<slug>.md
VERDICT: <verbatim verdict string from the entry's frontmatter>
OPEN_QUESTIONS: <bullet list, or "none">
```

Upstream skills (pos-sprint, pos-plan) parse the `ENTRY:` and
`VERDICT:` prefixes to embed the entry path + verdict into downstream
prompts. Keep the line prefixes stable.

When invoked by a human, the same three lines surface plus any
free-form discussion is fine.

---

## Process

### 1. Articulate the query semantically

Take the caller's question and rephrase it in one paragraph that
*describes the property you're looking for*, not just the keyword.
RAG-friendly phrasing wins on recall later.

- Bad: "git fixture library"
- Good: "race-free git repo fixtures for parallel cargo test threads
  that support mutate-during-test for remote-ahead simulation"

If the caller's question is ambiguous, ask ONE clarifying question via
`AskUserQuestion` to lock the query before searching. Don't search
twice because the first pass was vague.

### 2. Check for existing entries (grep first, search second)

Before any external search:

```bash
grep -lri "<key terms>" ~/dev/notebook/prior-art/ | head -10
```

For each hit, read the file. If a closely-related entry exists:
- **Sufficient as-is** → cite it; skip to step 6 (surface verdict to caller).
- **Stale (>6 months old or technology has moved)** → set the existing
  entry's frontmatter `status: superseded`, create a new entry that
  references the old one, proceed.
- **Tangential** → note it in the new entry's Findings; proceed.

If `pos-memory` MCP is loaded, also try
`mcp__pos-memory__memory_recall` with the query + `tags: ["prior-art"]`
for semantic match the grep misses.

### 3. Pick the source set by question shape

Don't run every source every time. Match the question's shape:

| Question shape | Sources |
|---|---|
| Implementation-specific (Rust lib? CLI tool? framework?) | crates.io, docs.rs, github, lib.rs (rust) |
| Research-question-shaped (algorithm, technique, paper) | arxiv (preprints), alphaxiv (discussion overlay on arxiv), huggingface-papers skill, emergent-mind |
| Architectural / design pattern | exa, deepwiki, notebooklm research-pipeline |
| Domain-specific (e.g., "how do MCP servers do auth") | github code-search, deepwiki, WebFetch on known projects |
| Anything left over | WebSearch (Anthropic built-in) |

Mark in the entry's `sources_searched` frontmatter what you actually
hit. Mark `sources_unavailable` for any MCP/skill the question shape
called for but isn't installed in this session — that's useful signal
for the user to know what coverage they're missing.

**Detect MCP availability** by inspecting the available tool list at
session start (e.g., presence of `mcp__alphaxiv__*` or
`mcp__exa__*` entries). Don't try to call and catch failures —
that wastes a call and pollutes telemetry.

### 4. Run the searches

For each source in the chosen set:

- **crates.io / docs.rs / lib.rs**: `WebFetch https://crates.io/crates/<name>`,
  `https://docs.rs/<name>/latest/<name>/`. Note version, last release date,
  star count if reachable, dependency tree, doc coverage percentage.
- **github**: `WebFetch https://github.com/<org>/<repo>` for README and
  activity. Use `gh search repos "<query>" --limit 10` if `gh` is
  available for broader discovery.
- **arxiv** (`WebFetch https://arxiv.org/abs/<id>` or `https://arxiv.org/list/<cat>/recent`): the canonical preprint server; cite arxiv IDs (e.g., `2406.12345`).
- **alphaxiv** (`mcp__alphaxiv__*` if available, else `WebFetch https://www.alphaxiv.org/abs/<arxiv-id>`): discussion + community-annotation overlay on top of arxiv. Use when you want commentary, not just the paper.
- **huggingface-papers**: if available as a skill (`Skill huggingface-papers`) or an MCP (`mcp__huggingface-papers__*`), use it for recent ML papers curated by the HF community; cite paper IDs. Else fall back to `WebFetch https://huggingface.co/papers`.
- **emergent-mind** (`mcp__emergent-mind__*`): recent ML/AI threads
  and news.
- **exa** (`mcp__exa__*`): semantic web search; good for "find me
  pages discussing [concept]".
- **deepwiki** (`mcp__deepwiki__*`): structured repo wiki content;
  good for "how does project X organize their Y subsystem".
- **notebooklm** (`mcp__notebooklm__*`): when you have 3+ source URLs
  and want a multi-source synthesis, use
  `mcp__notebooklm__nlm_research_pipeline` — ingests sources, runs
  questions, returns formatted findings.
- **WebSearch**: fallback for anything not covered above.

**Stop when sufficient.** If 3 sources agree the answer is "no
relevant prior art", that's enough — don't waste cycles searching
exhaustively. If 1 source returns a strong candidate, dig into THAT
candidate (its source code, its docs, related projects in the same
namespace) instead of opening more sources.

### 5. Write the entry

File path: `~/dev/notebook/prior-art/<slug>.md` where `<slug>` is
lowercase-kebab `<topic>-<aspect>` (e.g., `gitfixture-test-isolation.md`,
`mcp-resumable-sessions.md`, `rust-actor-frameworks.md`). No dates in
the filename — dates live in frontmatter.

Frontmatter (all fields load-bearing for future RAG ingestion):

```yaml
---
slug: <matches filename>
date: <YYYY-MM-DD of the search>
trigger: <what prompted this — pos task #, user question, etc.>
status: completed                  # | superseded | revisit
sources_searched:                  # actually hit
  - crates.io
  - github
  - <etc.>
sources_unavailable:               # would have used but MCP/skill missing
  - alphaxiv
  - <etc.>
tags:                              # for RAG retrieval; pick freely
  - <domain>                       # rust, python, mcp, agents, ml, ...
  - <topic>                        # testing, memory, planning, ...
  - <pattern>                      # parallel-test-isolation, ...
related_pos_tasks: [<numbers>]     # if applicable, else omit
verdict: <one-line summary>        # "not a fit" / "use as dep" / "borrow concept X" / "needs follow-up"
---
```

Body sections (in this order, all required):

1. **Query** — semantic paragraph from step 1.
2. **Sources checked** — bulleted list with exact URLs and one-line
   summaries of each hit.
3. **Findings** — synthesis. Per candidate: what it is, what it
   solves, what it doesn't, fitness for the trigger.
4. **Decision** — what we ended up doing, and why. If the decision is
   "kick down to user for choice", list the options.
5. **Links** — flat URL list for click-through.

Match the README's schema verbatim. If the README's schema and these
instructions diverge, the README wins (it's the canonical source).

### 6. Surface the verdict

Return to the caller:
- The path to the entry: `~/dev/notebook/prior-art/<slug>.md`
- The verdict string verbatim
- Any open questions the caller needs to resolve

Format the surface as a single message — caller may be an autonomous
upstream skill (e.g., pos-sprint) or a human. Either way, the entry
file is the durable artifact; your message is a pointer.

If `notebook` repo has uncommitted prior-art changes accumulated from
prior runs, mention it: "Reminder: ~/dev/notebook/prior-art/ has N
uncommitted entries; consider `git -C ~/dev/notebook commit` soon."
Don't commit automatically — that's the user's choice.

---

## When to use vs not

**Use** when:
- A feature design or implementation task wants to know if prior art
  exists before investing in custom work.
- Upstream pos-sprint dispatched a task that hit the full-brief
  threshold (EST > 1h, files > 3, new abstraction, or touches the
  spec doc).
- User asks "is there a library / paper / project for X?"

**Skip** when:
- The task is a trivial fix (one-line change, obvious bug).
- A recent entry for the same query already exists (use grep first).
- The question is "how do I use [thing I already chose]?" — that's
  documentation, not prior art.
- Cost > value: a 30-second `pos commit fix` doesn't need an entry.

---

## Known issues / gotchas

- **crates.io is JS-rendered**: `WebFetch https://crates.io/crates/<name>`
  returns mostly an empty page title. Fall back to `https://docs.rs/<name>/`
  for actual content, or `https://lib.rs/crates/<name>`.
- **GitHub README rendering**: `WebFetch https://github.com/<org>/<repo>`
  often returns the page chrome without the README body. Use the raw
  URL: `WebFetch https://raw.githubusercontent.com/<org>/<repo>/main/README.md`.
- **MCP availability is session-dependent**: alphaxiv, emergent-mind,
  exa, deepwiki MCPs may not be loaded in every session. Check via the
  tool list at session start; record gaps in `sources_unavailable`.
- **Notebook repo conflicts**: if `~/dev/notebook` is in a detached or
  diverged state, your new entry may not commit cleanly. Halt and tell
  the user; don't try to fix the repo state.

---

## What NOT to do

- **Don't search before grepping.** Every external search burns tokens
  and adds latency. Grep is free.
- **Don't write entries for searches that returned nothing.** Either
  the question was wrong (refine and retry) or there genuinely is no
  prior art (note it in the calling task's Decisions, not as a
  standalone entry).
- **Don't duplicate entries.** If grep found a recent matching entry,
  cite it; don't write a new one for the same query.
- **Don't commit the entry automatically.** Write the file; surface
  the path to the user; let them decide when to commit/push.
- **Don't run all sources every time.** Pick by question shape.
  Three sources that agree is enough.
- **Don't extend the frontmatter schema unilaterally.** It's
  load-bearing for future RAG ingestion (pos-memory MCP). If a new
  field seems necessary, propose it in the calling conversation and
  update the README first.
- **Don't search behind paywalls.** If a source requires login, note
  it as a gap and move on. The user can revisit manually.

---

## Worked example

User: "Is there a Rust crate for parallel-safe git test fixtures?"

You:
1. Rephrase: "race-free git repo fixtures for parallel cargo test
   threads, with mutate-during-test for remote-ahead simulation."
2. Grep: `grep -lri "git.*fixture" ~/dev/notebook/prior-art/` — finds
   `gitfixture-test-isolation.md` from 2026-05-26. Read it.
3. Decide: entry is recent (today) and answers the same question.
   No new search needed.
4. Surface: "Prior art entry already exists at
   ~/dev/notebook/prior-art/gitfixture-test-isolation.md. Verdict:
   `git-fixture` not a fit (declarative-only, CLI tool, heavy deps);
   build focused crate, optionally borrow declarative-spec concept."

Operator interactions: zero (cache hit). Tokens spent: minimal.

---

## Notes for future skill consumers

- `pos-sprint` step 2.5 invokes this skill before dispatching any
  full-brief task. The surfaced verdict is included in the dispatch
  prompt's Decisions section.
- `pos-plan` step 2 grep-checks the prior-art directory as part of
  reading context. Found entries get cited in the plan's Prior Art
  section.
- Direct human invocation (`/prior-art` or "search prior art on X") is
  equally valid — the skill is standalone.
