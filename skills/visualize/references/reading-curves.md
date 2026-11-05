# Reading training curves

Condensed from alphaXiv's `orx-figures` references (MIT) and the loss-interpretation notes in
`lewis-k-s/epiforecaster`, plus the pass@k caveats from arXiv 2611.01565.

## Choose the x-axis before anything else

| Comparing | Plot against |
|---|---|
| Same config, different seeds or a code change | optimizer / env steps |
| Different batch size or sequence length | tokens (or examples) seen |
| Different model sizes | FLOPs, or tokens with size stated per curve |
| A speed claim | wall-clock, and say on what hardware |

"Converges in half the steps" at twice the cost per step is not faster.

## Seeds

- ≥ 3 seeds, 5 if the effect is small. The band is the 95% interval of the estimate, not ±1 SD
  (SD answers "how spread are the seeds", not "how well is the mean resolved").
- If seeds disagree qualitatively (one diverges), show the individual runs as thin lines;
  that disagreement is the result.
- Seeds log on different step grids: interpolate onto a common grid before averaging, and
  only over the range every seed reached (`vizcommon.common_grid` does this).
- For ≥ 5 seeds prefer IQM with a bootstrap CI (rliable); it is robust to one outlier run.
  Cross-task claims need a stratified bootstrap over seeds within each task — not implemented
  here yet; say "per-task" until it is.

## Smoothing is a claim about the data

State it ("EMA, α=0.3"), draw the raw series faintly underneath, and never smooth a sparse
evaluation metric — that invents points between measurements.

## Triage a loss curve (epiforecaster heuristics)

- Use raw observations to locate spikes and discontinuities; use a rolling median for trend.
- Robust statistics first: window medians and MAD, because training loss is heavy-tailed.
- Report first / middle / recent behaviour, not just first-vs-last; report the best value and
  whether the recent curve kept it.
- Inspect the neighbourhood after each spike: recovered, stayed elevated, or a new regime?
- A plateau candidate needs low recent slope AND low rolling variation. Noisy and flat is
  instability, not convergence.
- Only discuss overfitting with held-out history in hand; a sampled training loss cannot show it.
- Discontinuities line up with epoch, curriculum or LR transitions more often than with bugs.

## pass@k caveats

- pass@k only means something for a fixed condition set and a stated K; always annotate both.
- pass@1 (reliability) and large-k pass@k (coverage) can move in opposite directions during
  pretraining — coverage can peak early and fall while pass@1 keeps rising. Report both, and
  prefer the checkpoint for post-training by coverage, not by pass@1 or validation loss.
- A checkpoint selector normalised over the checkpoints seen so far can drift as training
  extends; re-run it on prefixes of the run and plot the chosen checkpoint vs horizon
  (planned `selection_stability` chart).
- For GRPO, conditions with 0 or K successes contribute zero advantage; their fraction over
  training (`success_count_distribution`) is a direct learning-signal diagnostic.

## Traps

| Trap | Fix |
|---|---|
| Truncated y-axis makes a small gap decisive | include the range that matters, or declare the zoom |
| Log axis unlabelled | say so on the label; use log when the metric spans > 1 order of magnitude |
| Legend over the data | direct-label line ends, or move the legend out |
| > 4 curves per panel | keep the ones that carry the claim; table the rest |
| Baseline in a palette colour | baselines and chance level are grey |
| Curves cut at different x without comment | say why one stopped early |
| Two overlapping per-arm CIs read as "no difference" | plot the difference with its own CI (`orx_figstyle.diff_ci`) |
