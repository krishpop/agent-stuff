# Tour mode: an agent-in-the-loop walk through the Hunk window

The user watches their own Hunk window. You steer it with `hunk session`
commands and teach in chat, one step at a time. In pi with the
`pi-explain-diff` extension, `/explain --mode tour` does this with a TUI
instead; prefer it there.

Never launch the Hunk TUI yourself. If no session is open, ask the user to run
`hunk diff <args>` in their terminal, then continue.

## Setup

1. Collect, write, and check the lesson as for a page (SKILL.md steps 1 to 6).
   The tour uses the same `lesson.json`.
2. Load the story into the open window. Copy `sidecar.json` to
   `<repo>/.git/explain-diff/sidecar.json`, then:
   `hunk session reload --repo . -- diff <same args> --agent-context <repo>/.git/explain-diff/sidecar.json`.
   Files now appear in story order with one note per step. When the review is
   not a reloadable `diff` (a patch, a stash), push the notes instead:
   `hunk session comment apply --repo . --stdin < comments.json`.
3. Tell the user to press `a` if agent notes are hidden. A `--focus` on the
   first navigation also turns them on.

## Tracks

When the lesson has tracks, list them with their questions and ask which to start
with; suggest the first focus track. Walk one track at a time, and skip `detail`
steps unless the user asks for them.

## Each step

1. Navigate: `hunk session navigate --repo . --file <path> --new-line <start>`.
2. Light up the expression the step turns on:
   `hunk session highlight add --repo . --file <path> --new-line <line> --start <col> --end <col> --tone current --focus`.
   Columns are 0-based UTF-16 offsets into the line text, with the end
   exclusive. Compute them from the `highlight` substring.
3. Explain in chat: the smallest complete account first, in two or three
   sentences. Name the value it turns on. Offer to go deeper; do not lecture.
4. Ask one question from the lesson's quiz that fits this step, then stop and
   wait for the answer. Reply with the option's feedback, right or wrong.
5. `hunk session highlight clear --repo .` before moving on.

## The user's notes

The user can press `c` on any line to ask a question. Read the notes with
`hunk session comment list --repo . --type user --json`. Answer in chat, then
reply under the note:
`hunk session comment add --repo . --reply-to <noteId> --summary "<one-line answer>"`.

## Finish

Summarise what the user got right and what they missed. Offer the page, so
they keep a copy: render it from the same `lesson.json`. Offer the "try it"
exercises: the user runs them, or you run the safe ones after they predict.
