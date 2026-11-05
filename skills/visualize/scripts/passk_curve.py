# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "numpy", "pandas"]
# ///
"""pass@k over training (chart A). Does coverage (large k) peak before reliability (k=1)?

    uv run --no-project scripts/passk_curve.py --evals evals.csv --out figs/passk
    uv run --no-project scripts/passk_curve.py --evals evals.csv --vs-k --steps 200,800 --out figs/passk_vs_k

Input evals.csv, long format (references/schemas.md):
    run_id, seed, step, condition_id, n_trials, n_success [, task, method, ...]
One line per k, hollow marker at each line's argmax. Band = 95% bootstrap over
conditions for a single seed, else the seed aggregate (mean t-CI, or IQM for >= 5 seeds).
"""

from __future__ import annotations

import argparse

import matplotlib as mpl
import numpy as np
import pandas as pd

from vizcommon import (BASELINE, add_common_args, aggregate, common_grid, facets, finish, load_long,
                       panels, pass_at_k, subset, use_style)

EVALS = ["run_id", "seed", "step", "condition_id", "n_trials", "n_success"]
LINESTYLES = ["-", "--", ":", "-."]


def parse_ks(spec, k_max):
    ks = [k_max if tok.strip() == "max" else int(tok) for tok in spec.split(",")]
    return sorted({min(k, k_max) for k in ks})


def passk_per_seed(ev, k):
    """-> DataFrame run_id, seed, step, p: mean pass@k over conditions."""
    p = pass_at_k(ev["n_trials"].to_numpy(), ev["n_success"].to_numpy(), k)
    return ev.assign(p=p).groupby(["run_id", "seed", "step"], as_index=False)["p"].mean()


def condition_ci(ev, k, n_boot, rng):
    """Single-seed run: bootstrap over conditions at each step -> step, lo, hi."""
    out = []
    for step, g in ev.groupby("step"):
        p = pass_at_k(g["n_trials"].to_numpy(), g["n_success"].to_numpy(), k)
        boots = p[rng.integers(0, len(p), (n_boot, len(p)))].mean(axis=1)
        out.append((step, *np.percentile(boots, [2.5, 97.5])))
    return pd.DataFrame(out, columns=["step", "lo", "hi"]).sort_values("step")


def draw_passk(ax, ev, ks, color_by="run_id", n_boot=500, seed=0):
    """pass@k vs step for every `color_by` group in `ev`. Returns the uncertainty descriptions."""
    rng = np.random.default_rng(seed)
    groups = sorted(ev[color_by].unique())
    cmap = mpl.colormaps["viridis"]
    hows = set()
    for gi, gname in enumerate(groups):
        evg = ev[ev[color_by] == gname]
        for ki, k in enumerate(ks):
            per_seed = passk_per_seed(evg, k)
            curves = [(s["step"].to_numpy(), s["p"].to_numpy()) for _, s in per_seed.groupby("seed")]
            grid, runs = common_grid(curves)
            if runs.shape[0] == 1:
                ci = condition_ci(evg, k, n_boot, rng)
                center = runs[0]
                lo = np.interp(grid, ci["step"], ci["lo"])
                hi = np.interp(grid, ci["step"], ci["hi"])
                hows.add("single seed; band = 95% bootstrap over conditions")
            else:
                center, lo, hi, how = aggregate(runs)
                hows.add(how + " over seeds")
            if len(groups) == 1:
                color, ls, label = cmap(0.15 + 0.7 * ki / max(len(ks) - 1, 1)), "-", f"pass@{k}"
            else:
                color, ls, label = f"C{gi % 10}", LINESTYLES[ki % len(LINESTYLES)], f"{gname} pass@{k}"
            (line,) = ax.plot(grid, center, color=color, linestyle=ls, label=label)
            ax.fill_between(grid, lo, hi, color=line.get_color(), alpha=0.15, linewidth=0)
            j = int(np.argmax(center))
            ax.plot(grid[j], center[j], marker="o", markerfacecolor="white",
                    markeredgecolor=line.get_color(), markersize=4, linestyle="none")
    K, n_cond = int(ev["n_trials"].median()), ev["condition_id"].nunique()
    ax.annotate(f"K={K}, {n_cond} conditions", xy=(1, 0), xycoords="axes fraction",
                xytext=(-3, 3), textcoords="offset points", ha="right", va="bottom",
                fontsize=6, color=BASELINE)
    ax.set_ylim(0, 1.02)
    ax.set_xlabel("step")
    ax.set_ylabel("pass@k")
    return sorted(hows)


def draw_passk_vs_k(ax, ev, steps):
    """pass@k vs k (log2) at the checkpoints nearest `steps`; seeds and conditions pooled."""
    K = int(ev["n_trials"].min())
    ks = np.arange(1, K + 1)
    avail = np.sort(ev["step"].unique())
    for s in steps:
        step = avail[np.argmin(np.abs(avail - s))]
        g = ev[ev["step"] == step]
        p = [pass_at_k(g["n_trials"].to_numpy(), g["n_success"].to_numpy(), k).mean() for k in ks]
        ax.plot(ks, p, marker=".", markersize=3, label=f"step {step:g}")
    ax.set_xscale("log", base=2)
    ax.set_ylim(0, 1.02)
    ax.set_xlabel("k")
    ax.set_ylabel("pass@k")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--evals", required=True)
    p.add_argument("--ks", default="1,4,16,max", help="comma list; 'max' = K")
    p.add_argument("--color-by", default="run_id")
    p.add_argument("--vs-k", action="store_true", help="x = k at the checkpoints in --steps")
    p.add_argument("--steps", default=None, help="comma list of steps for --vs-k (default: last)")
    p.add_argument("--n-boot", type=int, default=500)
    add_common_args(p)
    args = p.parse_args(argv)

    use_style()
    ev = load_long(args.evals, EVALS)
    fcol, fvals = facets(ev, args.facet)
    fig, axes = panels(len(fvals), args.width)
    hows = set()
    for ax, v in zip(axes, fvals):
        sub = subset(ev, fcol, v)
        if args.vs_k:
            steps = [float(s) for s in args.steps.split(",")] if args.steps else [sub["step"].max()]
            draw_passk_vs_k(ax, sub, steps)
        else:
            ks = parse_ks(args.ks, int(sub["n_trials"].min()))
            hows |= set(draw_passk(ax, sub, ks, args.color_by, args.n_boot))
    axes[0].legend(fontsize=6, frameon=False, loc="best")
    paths = finish(fig, axes, args, [f"{fcol}={v}" for v in fvals] if fcol else None)
    print("\n".join(paths))
    if hows:
        print("uncertainty: " + "; ".join(sorted(hows)))
    return paths


if __name__ == "__main__":
    main()
