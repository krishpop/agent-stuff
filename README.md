# agent-stuff

Personal coding-agent skills, prompts, and terminal extensions for macOS and
Linux. Clone this repository on each machine and run:

```sh
git clone <your-personal-repo-url> ~/dev/agent-stuff
cd ~/dev/agent-stuff
./install.sh
```

The default installs skill symlinks only. Python 3.10+ is required; pi is not.
Skills are linked into `~/.agents/skills` (shared discovery), `~/.claude/skills`,
`~/.cursor/skills`, and `~/.grok/skills`. Existing entries are preserved and
reported. Keep the checkout in place. On another machine, clone and install
again; do not copy the symlinks between machines.

```sh
git pull --ff-only
./install.sh --skills
```

Existing links follow edits automatically; reinstalling adds newly added skills.
If an existing skill belongs to a different checkout, the installer reports it
and leaves it untouched. Move that entry aside if you want to switch copies.

## Included skills

- **explain-diff**: interactive explanations of diffs, PRs, and config changes,
  with quizzes, exercises, HTML output, and optional Hunk integration.
- **visualize**: training and evaluation plots, pass@k, quantile fans, run
  comparisons, and run reports.
- **html-review**, **thorough-pr-review**: visual summaries and coordinated reviews.
- **research-brainstorm**, **prior-art-search**: shape ideas and find prior work.
- **distill**, **tend**, **notes-hygiene**: capture and maintain working knowledge.
- **debug-pi**, **workflow-gc**: inspect pi performance and workflow state.

`explain-diff` needs Node.js and Python; its config helper needs PyYAML.
`visualize` scripts declare their dependencies for `uv run --no-project`.
The note-vault skills require the napkin CLI. Other integrations are optional;
read each skill's prerequisites before using it.

## Optional pi setup

```sh
./install.sh --prompts    # link the prompt templates
./install.sh --packages   # install the third-party package pins
./install.sh --forks      # install/register local extensions
```

These modes require their respective tools: pi and npm for packages/extensions,
and Cargo for any Rust package pins. Use `PI=/path/to/pi` to select pi.
The package installer prints removal commands for conflicting upstream packages;
run those before enabling the corresponding local fork. Disabled extensions are
skipped, and cmux is macOS-only.

Model providers, credentials, SSH hosts, and storage locations are configured
locally. Debug profiling requires `PI_DEBUG_MODEL` to name an available model.

`herdr/` contains optional keybindings, public plugin references, and layout
helpers. `nvim/` contains an optional annotation mapping. Install these manually
if wanted; the default installer does not change terminal or editor settings.

## Verify

```sh
node --test skills/explain-diff/tests/test_lesson.mjs
python3 skills/explain-diff/tests/test_config_chain.py
uv run --no-project skills/visualize/tests/smoke.py
```

This repository starts with fresh history. Existing component licenses and
upstream attribution are retained; no new blanket license is assigned.
