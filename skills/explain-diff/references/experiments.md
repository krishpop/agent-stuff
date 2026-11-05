# Experiments: config chains and launch commands

Explain whether the effective config and launch command implement the proposed
experiment. Inspect the target project's loader and argument parser before
claiming precedence rules: projects differ in how they merge lists, resolve
imports and templates, and apply command-line overrides.

## Compare two commands

```sh
python3 $S/config_chain.py compare \
  --baseline 'python train.py --config configs/base.yaml' \
  --proposed 'python train.py --config configs/base.yaml --config configs/experiment.yaml' \
  --repo /path/to/project --out /tmp/experiment-comparison
```

Without `--loader`, maps merge recursively and lists/scalars replace earlier
values. This is approximate: imports, templates, and project-specific merge
rules require the real loader. Set `approximate: true` on the lesson card.
Use `--loader package.module:load_config` only after checking that its interface
matches the helper. The bundled `tests/fixtures/chain/fakeproj/loader.py` shows
the expected interface. Loader execution runs project code.

The helper assumes program flags apply under `train_args`. Check that this
matches the project before using its effective-config output. Launcher flags
are kept separate; no implicit forwarding into program flags is inferred.
Legacy run-directory discovery supports `args.json`, saved config files,
`~/train_logs`, and timestamped launch history. Prefer explicit commands and
`--baseline-repo` / `--proposed-repo` when those conventions do not apply.

The output includes `compare.json`, changed layers, effective-value deltas,
shadowed values, and `experiment.patch`. Collect the patch with `--synthetic`
so lesson steps can reference `run/command.txt` and `run/effective-config.yaml`.

## Write the experiment card

State the hypothesis in the user's words. Explain changed command tokens from
the actual parser. Label config layers by their purpose. Classify deltas as
`intended`, `unexplained`, `shadowed`, or `missing`; identify which layer sets
each value. Treat unexplained changes as possible confounders.

Add prediction questions about effective values and exercises that resolve
configs without launching training. Link verified experiment-tracker URLs,
project notes, and documentation supplied by the project. Do not invent links.

Compare against the code snapshot that produced the baseline. Saved outputs
and current source can disagree; report drift instead of assuming a replay is
exact. A config diff alone does not cover launcher or command-line changes.
