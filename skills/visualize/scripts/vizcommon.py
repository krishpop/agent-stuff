"""Shared loading, seed aggregation, statistics and layout for the visualize charts.

Every chart script imports this; this imports the vendored orx_figstyle.
"""

from __future__ import annotations

import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from orx_figstyle import BASELINE, TEXT, WIDE, figure_grid, mean_ci, panel_labels, save, use_style  # noqa: E402

__all__ = [
    "BASELINE", "TEXT", "WIDE", "use_style",
    "add_common_args", "load_long", "facets", "subset", "panels", "finish", "draw_marks",
    "common_grid", "iqm", "bootstrap_ci", "aggregate", "ema", "pass_at_k",
]


# ---------------------------------------------------------------- CLI + layout

def add_common_args(parser):
    parser.add_argument("--out", required=True, help="output stem; writes <stem>.png/.pdf/.svg")
    parser.add_argument("--facet", default=None,
                        help="column giving one panel per value (default: 'task' when present)")
    parser.add_argument("--formats", default="png,pdf,svg")
    parser.add_argument("--width", type=float, default=TEXT,
                        help="figure width in inches (orx COLUMN=3.25, TEXT=5.5, WIDE=6.75)")
    parser.add_argument("--mark", action="append", default=[], metavar="STEP[:LABEL]",
                        help="dashed vertical at STEP, repeatable (e.g. --mark 400:selected)")
    parser.add_argument("--title", default=None)


def load_long(path, required):
    df = pd.read_csv(path)
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise SystemExit(f"{path}: missing columns {missing} (see references/schemas.md)")
    return df


def facets(df, facet):
    """-> (column or None, list of values). Default facet is 'task' when present."""
    if facet is None and "task" in df.columns:
        facet = "task"
    if facet is None or facet not in df.columns:
        return None, [None]
    return facet, sorted(df[facet].unique())


def subset(df, col, value):
    return df if col is None else df[df[col] == value]


def panels(n, width, panel_ratio=0.72, ncols=3):
    """n small-multiple axes at a final printed width, at most `ncols` per row."""
    ncols = min(n, ncols)
    nrows = math.ceil(n / ncols)
    fig, axes = figure_grid(nrows, ncols, width=width, ratio=panel_ratio * nrows / ncols, squeeze=False)
    axes = axes.ravel()
    for ax in axes[n:]:
        ax.set_visible(False)
    return fig, axes[:n]


def draw_marks(ax, marks):
    for m in marks:
        step, _, label = str(m).partition(":")
        ax.axvline(float(step), color=BASELINE, linestyle="--", linewidth=0.8, zorder=0)
        if label:  # vertical, along the line, so neighbouring marks do not collide
            ax.annotate(label, xy=(float(step), 1), xycoords=("data", "axes fraction"),
                        xytext=(-2, -2), textcoords="offset points", ha="right", va="top",
                        rotation=90, fontsize=6, color=BASELINE)


def finish(fig, axes, args, labels=None, mark_axes=None):
    """Panel letters, title, markers (on `mark_axes`, default all), then save. Returns the paths."""
    axes = list(np.ravel(axes))
    if labels:
        panel_labels(axes, labels)
    if args.title:
        fig.suptitle(args.title)
    for ax in (axes if mark_axes is None else mark_axes):
        draw_marks(ax, args.mark)
    return save(fig, args.out, formats=tuple(f.strip() for f in args.formats.split(",")))


# ---------------------------------------------------------------- statistics

def common_grid(curves):
    """curves: list of (x, y) arrays, one per seed -> (grid, runs[n_seeds, n_grid]).

    Interpolates onto the union of x values inside the range every seed reached, so a
    seed that stopped early narrows the range instead of being extrapolated flat.
    """
    curves = [(np.asarray(x, float), np.asarray(y, float)) for x, y in curves]
    curves = [(x[np.argsort(x)], y[np.argsort(x)]) for x, y in curves]
    first = max(x[0] for x, _ in curves)
    last = min(x[-1] for x, _ in curves)
    if first > last:
        raise ValueError("seeds cover no common range of steps")
    grid = np.unique(np.concatenate([x for x, _ in curves]))
    grid = grid[(grid >= first) & (grid <= last)]
    runs = np.stack([np.interp(grid, x, y) for x, y in curves])
    return grid, runs


def iqm(a, axis=0):
    """Interquartile mean along `axis` (rliable's robust point estimate)."""
    a = np.sort(np.asarray(a, float), axis=axis)
    n = a.shape[axis]
    lo, hi = int(np.floor(0.25 * n)), int(np.ceil(0.75 * n))
    return np.take(a, range(lo, hi), axis=axis).mean(axis=axis)


def bootstrap_ci(rows, stat, n_boot=1000, seed=0):
    """Percentile 95% CI of `stat(rows)` under resampling of axis 0."""
    rows = np.asarray(rows, float)
    rng = np.random.default_rng(seed)
    n = rows.shape[0]
    boots = np.stack([stat(rows[rng.integers(0, n, n)]) for _ in range(n_boot)])
    return np.percentile(boots, 2.5, axis=0), np.percentile(boots, 97.5, axis=0)


def aggregate(runs, method="auto", n_boot=1000):
    """runs[n_seeds, n_points] -> (center, lo, hi, how).

    auto: IQM with a percentile-bootstrap CI when there are >= 5 seeds (rliable),
    otherwise the mean with its 95% t-interval (orx mean_ci; a line, not a band, for one seed).
    """
    runs = np.asarray(runs, float)
    n = runs.shape[0]
    if method == "auto":
        method = "iqm" if n >= 5 else "mean"
    if method == "mean":
        center, lo, hi = mean_ci(runs)
        how = f"mean, 95% t-CI, n={n}" if n > 1 else "single seed, no interval"
    else:
        center = iqm(runs)
        lo, hi = bootstrap_ci(runs, iqm, n_boot=n_boot)
        how = f"IQM, 95% bootstrap CI, n={n}"
    return center, lo, hi, how


def ema(y, alpha):
    """Exponential moving average; declare it in the caption and keep the raw trace visible."""
    y = np.asarray(y, float)
    out = np.empty_like(y)
    acc = y[0]
    for i, v in enumerate(y):
        acc = alpha * v + (1 - alpha) * acc
        out[i] = acc
    return out


def pass_at_k(n_trials, n_success, k):
    """Unbiased pass@k = 1 - C(n-c, k)/C(n, k), elementwise; k is clipped to n.

    Never estimate pass@k from the first k trials — use all n and this estimator.
    """
    n = np.asarray(n_trials, float)
    c = np.asarray(n_success, float)
    k = np.minimum(np.asarray(k, float), n)
    ratio = np.ones(np.broadcast(n, k).shape)
    for i in range(int(k.max())):
        term = np.clip(n - c - i, 0, None) / (n - i)
        ratio = np.where(i < k, ratio * term, ratio)
    return 1.0 - ratio
