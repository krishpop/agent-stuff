# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "numpy", "pandas"]
# ///
"""Post-training curves colored by the checkpoint they started from (chart C).

Does the init checkpoint matter for RL / SFT / filtered-BC post-training?

    uv run --no-project scripts/posttrain_by_init.py --scalars scalars.csv --metric success --out figs/posttrain
    uv run --no-project scripts/posttrain_by_init.py --scalars scalars.csv --metric reward --ema 0.3 --out figs/rl

Input scalars.csv (references/schemas.md):
    run_id, seed, step, metric, value [, parent_run_id, parent_step, task]
Color = parent_run_id@parent_step (falls back to run_id). Seeds are interpolated to a common
step grid and aggregated (mean t-CI, or IQM bootstrap for >= 5 seeds); n is in the legend.
--ema smooths the aggregate and draws the raw trace faintly underneath.
"""

from __future__ import annotations

import argparse

import numpy as np

from vizcommon import add_common_args, aggregate, common_grid, ema, facets, finish, load_long, panels, subset, use_style

SCALARS = ["run_id", "seed", "step", "metric", "value"]


def init_key(df):
    if "parent_run_id" in df.columns and "parent_step" in df.columns:
        return df["parent_run_id"].astype(str) + "@" + df["parent_step"].astype(str)
    if "parent_step" in df.columns:
        return "init@" + df["parent_step"].astype(str)
    return df["run_id"].astype(str)


def init_order(sc):
    if "parent_step" in sc.columns:
        return list(sc.groupby("init")["parent_step"].first().sort_values().index)
    return sorted(sc["init"].unique())


def draw_posttrain(ax, sc, metric, ema_alpha=None):
    """Returns the uncertainty descriptions used."""
    sc = sc[sc["metric"] == metric]
    if sc.empty:
        raise SystemExit(f"no rows with metric={metric!r}")
    sc = sc.assign(init=init_key(sc))
    hows = set()
    for i, key in enumerate(init_order(sc)):
        g = sc[sc["init"] == key]
        curves = [(s["step"].to_numpy(), s["value"].to_numpy()) for _, s in g.groupby("seed")]
        grid, runs = common_grid(curves)
        center, lo, hi, how = aggregate(runs)
        hows.add(how)
        color = f"C{i % 10}"
        if ema_alpha:
            ax.plot(grid, center, color=color, alpha=0.3, linewidth=0.6)
            center, lo, hi = (ema(a, ema_alpha) for a in (center, lo, hi))
        (line,) = ax.plot(grid, center, color=color, label=f"init {key} (n={runs.shape[0]})")
        ax.fill_between(grid, lo, hi, color=line.get_color(), alpha=0.15, linewidth=0)
    ax.set_xlabel("post-training step")
    ax.set_ylabel(metric)
    return sorted(hows)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--scalars", required=True)
    p.add_argument("--metric", required=True)
    p.add_argument("--ema", type=float, default=None, metavar="ALPHA", help="EMA smoothing; raw drawn faintly")
    add_common_args(p)
    args = p.parse_args(argv)

    use_style()
    sc = load_long(args.scalars, SCALARS)
    fcol, fvals = facets(sc, args.facet)
    fig, axes = panels(len(fvals), args.width)
    hows = set()
    for ax, v in zip(axes, fvals):
        hows |= set(draw_posttrain(ax, subset(sc, fcol, v), args.metric, args.ema))
    axes[0].legend(fontsize=6, frameon=False)
    paths = finish(fig, axes, args, [f"{fcol}={v}" for v in fvals] if fcol else None)
    print("\n".join(paths))
    note = "; ".join(sorted(hows))
    if args.ema:
        note += f"; EMA alpha={args.ema} on the aggregate, raw underneath"
    print("uncertainty: " + note)
    return paths


if __name__ == "__main__":
    main()
