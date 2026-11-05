---
name: notes-hygiene
description: Audit and clean a feature-notes workspace (STATUS/PLAN/RESEARCH/HANDOFF docs plus scratch) that has grown cluttered, stale, redundant, or incoherent. Use when orienting to an in-flight feature, before handing notes to another agent or person, after a phase completes, or when notes contradict reality.
---

# Notes Hygiene

Working notes decay in a predictable direction: they grow, they go stale, and they
start lying. Nobody deletes anything, so obsolete plans stay at the top, the same
fact gets restated in five files, and scratch output buries the actual notes. The
failure that costs real time is a *confidently wrong* note — an agent or teammate
reads it, trusts it, and works off a blocker that was resolved days ago.

This skill restores a notes workspace to a state where a stranger could read it and
act correctly.

## When to Use

- **Orienting** to an in-flight feature (before trusting what the notes claim).
- **Before a handoff** — to another agent, a fresh session, or a person.
- **After a phase completes** — the moment plans go obsolete and scratch piles up.
- When notes **contradict reality**, or you can't tell which file is authoritative.

## Discipline

These are the invariants a healthy workspace satisfies. Everything below serves them.

1. **One canonical home per fact.** Each fact-class (data locations, current state,
   gotchas, task list) lives in exactly one file. Everywhere else links to it. A fact
   in five files has five chances to go stale and no way to tell which copy is right.
2. **Verify before writing.** Re-check load-bearing claims — job states, file
   existence, metrics, "this is blocked on X" — against live state before asserting
   them. A stale confident note is worse than no note.
3. **Demote, don't append.** When a plan is superseded, archive or collapse it. Do
   not prepend a "current plan" header above obsolete content and call it updated.
4. **Evict scratch.** Notes are for reading; byproducts (dumps, generated HTML/JSON,
   one-off helper scripts) belong elsewhere or in an archive dir.
5. **Every open task has a checkable done-criterion.** "Monitor the run" is not a
   task. "Stop when held-out loss rises for 3 consecutive evals" is.
6. **Filenames must match contents.** A name that describes a scope the file no
   longer has will mislead every future reader.

## Workflow

### 1. Measure

```bash
python3 scripts/scan.py <NOTES_DIR>   # relative to this skill's directory
```

Read-only. Reports scratch ratio, status-doc lag, facts duplicated across 3+ docs,
tasks lacking done-criteria, near-empty docs, and filename/content mismatches.
Exits non-zero if any check fails.

The scan is a **prefilter, not a verdict** — it measures shape, not truth. It cannot
tell you a claim is wrong, only that a file looks neglected. Two things it reliably
misses: a filename whose scope is subtly wrong (the token still appears in the body),
and a note that is well-formatted and current-looking but factually false. Those need
steps 2–3.

### 2. Classify every file

| Class | Test | Action |
|---|---|---|
| **Canonical** | Someone acting today needs it | Keep; make it the single home for its fact-class |
| **Historical** | Was true, superseded, worth keeping for provenance | Collapse to a summary or move to `archive/` |
| **Scratch** | A byproduct of doing the work | Move out of the notes dir |
| **Vestigial** | Near-empty, or untouched since day 1 with no readers | Fold into a canonical doc, or delete |

When two files claim the same role, pick one and make the other point to it.

### 3. Verify load-bearing claims

For each claim a reader would *act* on — the current blocker, "job X is running",
a chosen artifact, a metric — check it against live state. Prefer the cheapest
evidence that settles it (an existing log or dump beats re-running anything).

Correct what's wrong, and say what changed. If a stated task points at a metric or
assumption the evidence has since refuted, that task is not stale — it's wrong.
Rewrite it rather than re-dating it.

### 4. Apply fixes

Dedupe to canonical homes · demote obsolete plans · evict scratch · rename
files whose names mislead · sharpen every open task until it names the decision it
resolves and the condition that ends it.

Prefer the smallest edit that restores the invariant. Rewriting a doc wholesale
loses provenance that a targeted edit keeps.

### 5. Report

Show before/after: what moved, what was deleted or archived, which claims were
corrected, and re-run the scan so the improvement is measured rather than asserted.

## Safety

- **Never delete without showing what and why.** Print the list first.
- **Prefer archiving to deleting** — move scratch to `archive/` or out of the notes
  tree. Deletion is for genuinely worthless files (empty, duplicates).
- **Never delete something you didn't create** without explicit confirmation — an
  unfamiliar file is more likely misunderstood than worthless.
- Notes dirs are often git-backed; check before removing anything with history.

## Notes

Related: `/reflect` (fix the system that produced a bad output), `/document`
(documentation conventions). This skill is about the *workspace*; those are about
individual artifacts.
