---
description: Finish a stalled git rebase in the notebook vault, keeping both sides of every conflict
argument-hint: ""
---

A git rebase in the current repository has stopped on merge conflicts. Finish it.

## Context

These files are append-only research notes, written by several concurrent agent
sessions and by cron on three machines. Losing text is far worse than keeping too
much: a duplicated paragraph is noise a human fixes in seconds, whereas a dropped
result is unrecoverable and nobody notices until they act on the gap.

## What to do

1. For every conflicted file, KEEP BOTH SIDES' content. Concatenate the two
   versions rather than choosing between them.
2. Remove every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`).
3. `git add` each resolved file.
4. Run `git rebase --continue`.
5. Repeat until the rebase reports it is finished.

## Never do any of these

- `git push`, in any form
- `git reset --hard`
- `git commit --amend`
- any force operation
- deleting a file, or emptying one, to make a conflict go away

## If you get stuck

Stop and say so. Leaving the rebase in progress is fine — the caller checks for
that and aborts cleanly. Guessing at which side to keep is not fine.
