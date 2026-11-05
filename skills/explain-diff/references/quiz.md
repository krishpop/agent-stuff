# Questions and "try it"

Adapted from explain-diff-html's `quiz-design.md` (MIT). Three question shapes
and the rule that difficulty belongs in the stem come from Cat Hicks'
learning-opportunities skill, used under CC-BY-4.0:
<https://github.com/DrCatHicks/learning-opportunities>

## Questions

Write three to five medium-difficulty questions that test judgment and
transfer, not recall. With tracks, give each track at most three, three to eight in total,
and put each question in the track whose understanding it tests. Use at most two of any one shape:

| `shape` | Ask |
|---|---|
| `why` | Why the change is shaped this way. Distractors are the alternatives a competent engineer would weigh. |
| `trace` | Given a concrete input, what the changed code produces or which branch it takes. |
| `change-one` | How the behaviour differs if one flag, input, or precondition changes. |
| `spot-break` | What fails if a specific line were removed or reversed. |
| `other-choice` | When the rejected alternative would have been right. |
| `connect` | A question neither of two mechanisms answers alone. |
| `apply` | How the idea lands at another site the page already named. |
| `principle` | What general principle the change is an instance of; distractors are neighbouring principles. |
| `predict-value` | Experiments: which value a key takes at runtime, or what happens to it if one layer or flag is dropped. |

Rules (the checker enforces the first four):

- Use 3 or 4 options, with exactly one marked `"correct": true` and feedback on
  every option that explains the reasoning.
- No option may name another by position ("all of the above", "the first
  answer"). Options shuffle on every load.
- Keep options within about a quarter of each other's length. The correct
  answer attracts length because it carries its own justification. Move that
  reasoning into the feedback, so each option is a bare claim. If the correct
  option is the longest in more than two questions, a reader can answer by word
  count.
- Vary where the correct option sits in the JSON. Write it first, then move it.
- Ground each distractor in a plausible misunderstanding, not a throwaway.
- No question the diff answers by pattern matching, and no question the page
  already answered in a callout.
- Make a question harder by giving less setup, never by making the options more
  alike.

## "Try it"

Each exercise is predict, then run, then compare:

- `predict` asks for a specific, checkable prediction ("how many calls, and
  what prints?"), never "what do you think happens?".
- `command` runs in seconds, locally, and changes nothing: a unit test, a
  one-line script against the changed function, a `grep` of the effective
  config, or `config_chain.py resolve`. Use dry runs, never launches. A command
  that submits a job is allowed only with `"launches": true`, and the pi
  extension refuses to run it.
- `lookFor` says where in the output to look. `expect` states the result
  exactly enough to check (a value, a line, a count).
- Set `cwd` when the command must run somewhere other than the repo root.
- One to three exercises. Prefer the one that would have caught a wrong mental
  model of the change. A `blast-radius` proof makes a good exercise.

The page stores the reader's prediction in the browser before it reveals the
expected result. In pi, the tour runs the command after the reader types a
prediction and confirms, then shows the output next to the prediction.
