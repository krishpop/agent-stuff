---
name: thorough-pr-review
description: "Run all the relevant review skills over a PR/diff in parallel. Fans out to /review-code, /review-design, /review-tests, /review-skill, and /document (mode=review)."
metadata:
  version: 0.1.0
argument-hint: "[PR number or branch] (optional — defaults to current PR/branch)"
---

# Thorough PR Review

One command that runs every relevant dimension reviewer and returns **one**
consolidated review — instead of invoking each by hand and getting N separate,
overlapping GitHub reviews.

## Agent review discipline (local overlay — mandatory)

Apply the review discipline below before fan-out and again at consolidation.

Each sub-agent prompt MUST also say: apply agent-review-discipline; Critical/bug = only merge blockers; max 5 nits total preferred per dimension; evidence `file:line` or omit; do not invent findings.

## 1. Pick the reviewers the diff needs

Get the **true PR diff** once, from GitHub — not a local branch comparison:

```bash
PR=$(gh pr view --json number -q .number)          # current branch's PR
HEAD_OID=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
gh pr diff "$PR" --name-only                        # files the PR actually changes
gh pr diff "$PR"                                    # the full unified diff
```

`gh pr diff` (≡ `gh api repos/{o}/{r}/pulls/$PR/files`) is the server-computed diff
— it matches the web UI and inline-comment line numbers exactly. Do NOT use
`git diff <base>`.

Default reviewers — drop any not in the session's skill list (omit, never simulate):

| Reviewer | Run when the diff has… |
|---|---|
| `/review-code` | any code |
| `/review-design` | any code (esp. refactors / ≥4 files) |
| `/review-tests` | `test/**` or new prod code without tests |
| `/review-skill` | any `**/SKILL.md` |
| `/document` (mode=review) | any code or doc change |

## 2. Fan out — one sub-agent per reviewer, findings only

Spawn one Agent per selected reviewer, **all in a single message** (concurrent),
passing the PR number + `$HEAD_OID` (sub-agents don't inherit git context). Each
prompt MUST say: **"Run `/<reviewer>` on the PR diff. Anchor every citation on the
diff / `git show $HEAD_OID:<file>`, not the working tree. Do NOT post to GitHub —
return findings only; the orchestrator posts once."** (Each reviewer's own
SKILL.md tells it to post, so the prompt must override that.)

Then the main agent **dedupes** across reviewers on `(file, line ±3, root cause)`
— same bug from two reviewers = one finding (corroboration raises confidence, not
severity).

### 2b. Cross-reviewer triage (before post) — local overlay

1. Normalize findings to Critical / Major / Minor (or bug / suggestion / nit).
2. Drop: no `file:line`, pure CI-style, invent/low-confidence nits.
3. Cap **total Minors across all dimensions at 5**; excess → body summary only or drop.
4. Label each remaining finding CONFIRMED | NEEDS-INFO | REJECT; post only CONFIRMED (and high-confidence Major).
5. `REQUEST_CHANGES` **only** if any Critical/BLOCKER remains; else `COMMENT`.

## 3. Post the findings with /comments

Hand the **triaged** deduped findings to **`/comments`** to post — it owns posting inline
reviews: one inline comment per finding pinned to its line, dedupe against the
PR's *existing* comments (so you never repeat another reviewer/an earlier run/a human),
off-diff findings → the review body, and the batch-reviews-API gotchas. Tag each
comment with its finding id + dimension, e.g. `**[C1 · review-code]**`; use event
`REQUEST_CHANGES` if any **Critical/BLOCKER** survives triage, else `COMMENT`.

**Posting is the deliverable — do it automatically. Do NOT stop and ask "want me
to post?" or offer a menu of options.** (If `/comments` finds every finding is
already on the PR, nothing is posted — that's the one no-post case.)

## Related

`/comments` (posts the inline review + replies to existing PR feedback) ·
`/pre-push` (today fans these out itself — this skill is the consolidating
replacement) · `/multi-phase-analysis`.
