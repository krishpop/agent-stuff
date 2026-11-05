---
name: visualize
description: Charts and analysis for ML training runs — sim-RL, RL post-training (PPO/GRPO), and pre-training. Use before plotting any training metric: loss/reward/success curves over steps, pass@k over training, per-prompt or per-condition success distributions (GRPO dead groups), quantile fans of per-sample error/reward, post-training curves compared by init checkpoint, multi-seed aggregation (CI, IQM), run comparisons, checkpoint selection, and the per-task "run report" row. Triggers — "plot the training curves", "compare these runs", "pass@k over training", "is coverage collapsing", "which checkpoint should we post-train from", "aggregate over seeds", "make a figure for the paper", "visualize the rollouts/evals". Not for generic business charts or dashboards.
---

# visualize

Charts for training-run analysis that are honest about uncertainty and reusable across
sim-RL, LLM RL post-training and pre-training. Built on a vendored copy of alphaXiv's
`orx_figstyle.py` (MIT) for style, sizing and the figure audit.

## Workflow

1. **Get the data into long format.** Three CSV shapes cover every chart
   (`references/schemas.md`): `evals` (K trials per condition per checkpoint), `samples`
   (M scored samples per item per checkpoint), `scalars` (one metric value per run/seed/step).
   Pull them from W&B / trackio / TensorBoard / rollout logs; never type numbers in by hand.
2. **Pick the chart by the question**, not by the shape you have in mind:

   | Question | Script | Input |
   |---|---|---|
   | Does coverage (pass@K) peak before reliability (pass@1)? | `scripts/passk_curve.py` (`--vs-k` for the profile over k at chosen checkpoints) | evals |
   | Is success polarizing — more all-0 / all-K conditions (GRPO zero-advantage groups)? | `scripts/success_count_distribution.py` | evals |
   | Is the favorable tail of a per-sample score moving opposite to the median? | `scripts/quantile_fan.py` | samples |
   | Does the init checkpoint matter for RL / SFT post-training? | `scripts/posttrain_by_init.py --metric M` | scalars (+ `parent_step`) |
   | The whole argument in one row per task | `scripts/run_report.py` | any subset of the three |
   | Metric over training, is the gap bigger than seed noise? | `posttrain_by_init.py --metric M` with `run_id` as the color (no parent columns) | scalars |
   | Scaling law, ablation deltas, Pareto (reward vs KL) | not scripted yet — follow the orx recipes in `references/reading-curves.md` with `scripts/orx_figstyle.py` | — |

3. **Run with uv** (scripts carry inline dependency metadata; the system Python has no matplotlib):
   ```sh
   uv run --no-project scripts/passk_curve.py --evals evals.csv --out figs/passk --mark 400:selected
   ```
   Every script writes `<stem>.png` (chat/terminal), `.pdf` and `.svg` (paper), prints the paths,
   and prints an `uncertainty:` line — copy that line into the caption or report.
   `--facet COL` makes one panel per value (default: `task` when the column exists);
   `--width` uses orx print widths (3.25 column, 5.5 text, 6.75 wide); `--mark STEP[:LABEL]` repeats.
4. **Look at the PNG before handing it over** (Read the file). Then check:
   axes labelled with units, n stated, smoothing declared, baseline grey, y-range honest,
   and the orx audit line printed `clean` (a `FIGURE AUDIT` block lists what to fix).

## Statistics the scripts enforce

- **pass@k** uses the unbiased estimator `1 − C(K−c,k)/C(K,k)` over all K trials, never the
  first k. Charts annotate K and the condition count; without them pass@k is meaningless.
- **Seeds** are interpolated to a common step grid clipped to the range every seed reached,
  then aggregated: mean with a 95% t-interval for < 5 seeds, IQM with a percentile-bootstrap CI
  for ≥ 5 (rliable). One seed is drawn as a line and labelled "single seed" — for pass@k the
  band is then a bootstrap over conditions instead.
- **Quantile fans** take quantiles within each item first, then average across items.
- **Smoothing** (`--ema`) is applied to the aggregate, declared in the output, and the raw
  trace is drawn faintly underneath.
- **Stacked success bins** pool seeds and say so.

## Inputs and adapters

See `references/schemas.md` for the column contracts and how to fill them from
W&B (`run.history(keys=[...])`, or `wandb-primary`'s `wandb_run_ops.py diagnose-history`),
trackio's CLI, TensorBoard event files, and sim rollout logs (one `evals` row per
checkpoint × initial condition; one `samples` row per scored rollout).

## Reading the result

`references/reading-curves.md` — the x-axis choice (steps vs tokens vs FLOPs vs wall-clock),
why ±1 SD is the wrong band, how to triage loss curves (rolling median + MAD, spike
neighbourhoods, plateau = low slope AND low variation), and the pass@k caveats.

## Extending

Each chart script exposes `draw_<name>(ax, df, ...)` and a `main(argv)`; `run_report.py`
composes the draw functions. Add a chart as a new script with the same split, add it to the
table above, and add a case to `tests/smoke.py` (`uv run --no-project tests/smoke.py`).
Planned next: `best_of_k`, `minimax_selector` + `selection_stability`, `loss_by_bucket`,
generalization-gap ratio, paired checkpoint table (from arXiv 2611.01565).

## Do not

- Plot remembered or rounded numbers, or leave synthetic data in a shipped script (the smoke
  test's synthetic data stays in the test).
- Report pass@k from a subset of trials, or compare pass@k across different K or condition sets.
- Show a single seed as if it were a mean; show ±1 SD as if it were a confidence interval.
- Add `ax.set_title` to a paper figure; the caption is the title (panel letters name parts).
