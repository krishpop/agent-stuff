# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "numpy", "pandas"]
# ///
"""Per-condition success-count distribution over training (chart B).

Is success polarizing — more conditions with 0 of K successes — even while the mean rises?
For GRPO this is the fraction of all-0 and all-K groups, i.e. zero-advantage prompts.

    uv run --no-project scripts/success_count_distribution.py --evals evals.csv --out figs/success_bins

Input evals.csv (references/schemas.md): run_id, seed, step, condition_id, n_trials, n_success [, task]
Stacked area of the fraction of (seed, condition) rows per success bin; one panel per run.
"""

from __future__ import annotations

import argparse

import matplotlib as mpl
import numpy as np
import pandas as pd

from vizcommon import BASELINE, add_common_args, facets, finish, load_long, panels, subset, use_style

EVALS = ["run_id", "seed", "step", "condition_id", "n_trials", "n_success"]
LABELS = ["0", "(0,¼]", "(¼,½]", "(½,¾]", "(¾,1)", "K/K"]


def bin_fractions(ev):
    """-> steps, matrix[6, n_steps]: fraction of rows per success-rate bin at each step."""
    frac = (ev["n_success"] / ev["n_trials"]).to_numpy()
    idx = np.select([frac <= 0, frac <= 0.25, frac <= 0.5, frac <= 0.75, frac < 1], [0, 1, 2, 3, 4], default=5)
    tab = (pd.crosstab(ev["step"], idx, normalize="index")
           .reindex(columns=range(6), fill_value=0.0).sort_index())
    return tab.index.to_numpy(), tab.to_numpy().T


def draw_success_count(ax, ev):
    steps, mat = bin_fractions(ev)
    colors = mpl.colormaps["RdBu"](np.linspace(0.08, 0.92, 6))
    ax.stackplot(steps, mat, labels=LABELS, colors=colors, linewidth=0)
    ax.set_xlim(steps[0], steps[-1])
    ax.set_ylim(0, 1)
    ax.set_xlabel("step")
    ax.set_ylabel("fraction of conditions")
    K, n_cond, n_seed = int(ev["n_trials"].median()), ev["condition_id"].nunique(), ev["seed"].nunique()
    ax.annotate(f"K={K}, {n_cond} conditions, {n_seed} seed(s) pooled", xy=(0, 0),
                xycoords="axes fraction", xytext=(3, 3), textcoords="offset points",
                ha="left", va="bottom", fontsize=6, color="black")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--evals", required=True)
    add_common_args(p)
    args = p.parse_args(argv)

    use_style()
    ev = load_long(args.evals, EVALS)
    fcol, fvals = facets(ev, args.facet)
    runs = sorted(ev["run_id"].unique())
    cells = [(v, r) for v in fvals for r in runs]
    fig, axes = panels(len(cells), args.width)
    for ax, (v, r) in zip(axes, cells):
        draw_success_count(ax, subset(subset(ev, fcol, v), "run_id", r))
    # The area fills the axes, so the legend lives outside the last panel.
    axes[-1].legend(fontsize=6, frameon=False, title="successes / K", title_fontsize=6,
                    loc="upper left", bbox_to_anchor=(1.02, 1))
    labels = None
    if fcol or len(runs) > 1:
        labels = [" ".join(s for s in ((f"{fcol}={v}" if fcol else ""), (r if len(runs) > 1 else "")) if s)
                  for v, r in cells]
    paths = finish(fig, axes, args, labels)
    print("\n".join(paths))
    return paths


if __name__ == "__main__":
    main()
