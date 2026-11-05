# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "numpy", "pandas"]
# ///
"""Quantile fan of a per-sample score over training (chart E).

Is the favorable tail (coverage) moving opposite to the typical case (reliability)?
Quantiles are taken within each item first, then averaged across items (not pooled).

    uv run --no-project scripts/quantile_fan.py --samples samples.csv --out figs/quantiles
    uv run --no-project scripts/quantile_fan.py --samples rewards.csv --higher-better --linear --out figs/reward_q

Input samples.csv (references/schemas.md): run_id, step, item_id, sample_id, score [, task]
score = per-sample error / NLL (lower better, log y by default) or reward (--higher-better).
Hollow marker at each quantile's best step.
"""

from __future__ import annotations

import argparse

import matplotlib as mpl
import numpy as np
import pandas as pd

from vizcommon import BASELINE, add_common_args, facets, finish, load_long, panels, subset, use_style

SAMPLES = ["run_id", "step", "item_id", "sample_id", "score"]


def quantile_table(sm, us):
    """-> DataFrame indexed by step, one column per u: mean over items of the per-item u-quantile."""
    g = sm.groupby(["step", "item_id"])["score"]
    return pd.DataFrame({u: g.quantile(u).groupby(level="step").mean() for u in us}).sort_index()


def draw_quantile_fan(ax, sm, us, higher_better=False, log=True):
    tab = quantile_table(sm, us)
    cmap = mpl.colormaps["viridis"]
    span = (us[-1] - us[0]) or 1.0
    x = tab.index.to_numpy()
    for u in us:
        color = cmap((u - us[0]) / span)
        y = tab[u].to_numpy()
        ax.plot(x, y, color=color, linewidth=0.9)
        j = int(np.argmax(y) if higher_better else np.argmin(y))
        ax.plot(x[j], y[j], marker="o", markerfacecolor="white", markeredgecolor=color,
                markersize=3.5, linestyle="none")
    if log:
        ax.set_yscale("log")
    mappable = mpl.cm.ScalarMappable(cmap=cmap, norm=mpl.colors.Normalize(us[0], us[-1]))
    mappable.set_array([])
    ax.figure.colorbar(mappable, ax=ax, label="quantile u", pad=0.02)
    n_items = sm["item_id"].nunique()
    m = int(sm.groupby(["step", "item_id"]).size().median())
    # Errors fall to the right (bottom-left stays empty); rewards rise (top-left stays empty).
    corner = (0, 1) if higher_better else (0, 0)
    ax.annotate(f"{n_items} items × {m} samples", xy=corner, xycoords="axes fraction",
                xytext=(3, -3 if higher_better else 3), textcoords="offset points",
                ha="left", va="top" if higher_better else "bottom", fontsize=6, color=BASELINE)
    ax.set_xlabel("step")
    ax.set_ylabel("u-quantile of score\n(mean over items)")


def parse_us(spec):
    return sorted(float(u) for u in spec.split(","))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--samples", required=True)
    p.add_argument("--us", default="0.05,0.1,0.25,0.5,0.75,0.9,0.95")
    p.add_argument("--higher-better", action="store_true", help="score is a reward; mark maxima")
    p.add_argument("--linear", action="store_true", help="linear y instead of log")
    add_common_args(p)
    args = p.parse_args(argv)

    use_style()
    sm = load_long(args.samples, SAMPLES)
    us = parse_us(args.us)
    fcol, fvals = facets(sm, args.facet)
    runs = sorted(sm["run_id"].unique())
    cells = [(v, r) for v in fvals for r in runs]
    fig, axes = panels(len(cells), args.width)
    for ax, (v, r) in zip(axes, cells):
        draw_quantile_fan(ax, subset(subset(sm, fcol, v), "run_id", r), us,
                          higher_better=args.higher_better, log=not args.linear)
    labels = None
    if fcol or len(runs) > 1:
        labels = [" ".join(s for s in ((f"{fcol}={v}" if fcol else ""), (r if len(runs) > 1 else "")) if s)
                  for v, r in cells]
    paths = finish(fig, axes, args, labels)
    print("\n".join(paths))
    return paths


if __name__ == "__main__":
    main()
