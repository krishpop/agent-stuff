# Input schemas

All charts read long-format CSV. Extra columns are allowed and ignored except the optional
ones named below. A `task` column anywhere becomes the default facet (one panel or report row
per task). Steps may be optimizer steps, tokens, env steps or epochs — label the axis accordingly
and keep one meaning per file.

## `evals` — K trials per condition per checkpoint

| column | type | meaning |
|---|---|---|
| `run_id` | str | the (pre)training run that produced the checkpoints |
| `seed` | int | training seed; use 0 when there is one run |
| `step` | number | checkpoint position |
| `condition_id` | str | sim: initial state / scene seed; LLM RL: prompt id; coding: problem id |
| `n_trials` | int | K rollouts / samples drawn for that condition at that checkpoint |
| `n_success` | int | how many of the K succeeded |
| `task` | str, optional | facet |

One row per checkpoint × condition. Keep K and the condition set fixed across checkpoints
you compare — pass@k is only comparable at equal K over the same conditions. The paper this
comes from used 500 conditions × K=32 (MimicGen) and 50 per task (RoboCasa).

## `samples` — M scored samples per item per checkpoint

| column | type | meaning |
|---|---|---|
| `run_id`, `step` | | as above |
| `item_id` | str | held-out input: observation, prompt, sequence |
| `sample_id` | int | 0..M−1 |
| `score` | float | per-sample error / NLL (lower better) or reward / verifier score (`--higher-better`) |
| `task` | str, optional | facet |

Scores must be comparable across steps (same held-out set, same noise seeds when the model
is stochastic). Pre-training: per-token or per-sequence NLL on a fixed held-out shard.
RL: per-sample reward on a fixed prompt set.

## `scalars` — one value per run, seed, step, metric

| column | type | meaning |
|---|---|---|
| `run_id` | str | the run being plotted (a post-training run, or a pretraining run) |
| `seed` | int | |
| `step` | number | |
| `metric` | str | e.g. `success`, `reward`, `val_loss`, `kl` |
| `value` | float | |
| `parent_run_id` | str, optional | the run the init checkpoint came from |
| `parent_step` | number, optional | which checkpoint; `posttrain_by_init` colors by `parent_run_id@parent_step` |
| `task` | str, optional | facet |

Windowed metrics (e.g. success over the last 100 episodes) should say so in the metric
name or the caption.

## Filling them

- **W&B**: `run.history(keys=[metric], samples=N)` per run (always pass `keys=`; large runs
  502 otherwise), or `wandb-primary`'s `python wandb_run_ops.py diagnose-history --metric M`
  / `scan_history(keys=[...])` for exact reads. Map `run.config` to `seed`, `parent_step`, `task`.
- **trackio**: `trackio` CLI with JSON output (see the `huggingface-trackio` skill), then rename
  columns.
- **TensorBoard**: `tensorboard.backend.event_processing.event_accumulator.EventAccumulator`
  → `Scalars(tag)` gives (wall_time, step, value); one file per run/seed.
- **Sim rollouts**: for each checkpoint, roll out each initial condition K times with the
  same condition seeds; write one `evals` row with the success count, and one `samples` row
  per rollout if you have a per-rollout score (return, tracking error, …).
- **GRPO / RLVR logs**: a group of G samples for a prompt is an `evals` row with
  `n_trials=G`, `n_success=` number of correct completions; the per-sample rewards are
  `samples` rows.
