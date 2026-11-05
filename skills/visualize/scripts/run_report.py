# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "numpy", "pandas"]
# ///
"""Composite diagnostic row per task: pass@k | success-count bins | quantile fan | post-training by init.

The whole coverage-vs-reliability argument in one row, with the selected and final
checkpoints marked across panels.

    uv run --no-project scripts/run_report.py --evals evals.csv --samples samples.csv \\
        --scalars scalars.csv --metric success --mark 400:selected --mark 1000:final --out figs/report

Every input is optional; the row holds the panels whose data were given. Rows come from the
`task` column (one row when absent). --run picks the pretraining run_id when the inputs hold
several; post-training rows are kept when parent_run_id matches it.
"""

from __future__ import annotations

import argparse

from passk_curve import EVALS, draw_passk, parse_ks
from posttrain_by_init import SCALARS, draw_posttrain
from quantile_fan import SAMPLES, draw_quantile_fan, parse_us
from success_count_distribution import draw_success_count
from vizcommon import WIDE, add_common_args, finish, load_long, use_style
from orx_figstyle import figure_grid


def pick_run(*dfs):
    runs = set()
    for d in dfs:
        if d is not None:
            runs |= set(d["run_id"].unique())
    if len(runs) != 1:
        raise SystemExit(f"--run is required: inputs hold run_ids {sorted(runs)}")
    return runs.pop()


def by_task(d, task):
    if d is None:
        return None
    if task is not None and "task" in d.columns:
        d = d[d["task"] == task]
    return None if d.empty else d


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--evals")
    p.add_argument("--samples")
    p.add_argument("--scalars")
    p.add_argument("--metric", help="metric name in --scalars")
    p.add_argument("--run", help="pretraining run_id")
    p.add_argument("--ks", default="1,4,16,max")
    p.add_argument("--us", default="0.05,0.25,0.5,0.75,0.95")
    p.add_argument("--higher-better", action="store_true")
    p.add_argument("--n-boot", type=int, default=300)
    add_common_args(p)
    p.set_defaults(width=WIDE)
    args = p.parse_args(argv)

    ev = load_long(args.evals, EVALS) if args.evals else None
    sm = load_long(args.samples, SAMPLES) if args.samples else None
    sc = load_long(args.scalars, SCALARS) if args.scalars else None
    if ev is None and sm is None and sc is None:
        raise SystemExit("give at least one of --evals --samples --scalars")
    if sc is not None and not args.metric:
        raise SystemExit("--metric is required with --scalars")

    run = args.run or pick_run(ev, sm)
    if ev is not None:
        ev = ev[ev["run_id"] == run]
    if sm is not None:
        sm = sm[sm["run_id"] == run]
    if sc is not None and "parent_run_id" in sc.columns:
        sc = sc[sc["parent_run_id"] == run]

    tasks = sorted(set().union(*[set(d["task"].unique()) for d in (ev, sm, sc)
                                 if d is not None and "task" in d.columns])) or [None]
    ncols = (2 if ev is not None else 0) + (sm is not None) + (sc is not None)
    use_style()
    fig, axes = figure_grid(len(tasks), ncols, width=args.width, ratio=0.26 * len(tasks), squeeze=False)
    hows, us = set(), parse_us(args.us)
    pretrain_axes = []  # --mark steps are pretraining steps; post-training panels have their own x
    for r, task in enumerate(tasks):
        e, s, c = by_task(ev, task), by_task(sm, task), by_task(sc, task)
        col = 0
        if ev is not None:
            if e is not None:
                hows |= set(draw_passk(axes[r, col], e, parse_ks(args.ks, int(e["n_trials"].min())), n_boot=args.n_boot))
                draw_success_count(axes[r, col + 1], e)
                pretrain_axes += [axes[r, col], axes[r, col + 1]]
                if r == len(tasks) - 1:  # legends under the bottom row; panels are too narrow to hold them
                    axes[r, col].legend(fontsize=5, frameon=False, ncol=2, loc="upper center",
                                        bbox_to_anchor=(0.5, -0.45))
                    axes[r, col + 1].legend(fontsize=5, frameon=False, ncol=3, loc="upper center",
                                            bbox_to_anchor=(0.5, -0.45), title="successes / K", title_fontsize=5)
            else:
                axes[r, col].set_visible(False)
                axes[r, col + 1].set_visible(False)
            col += 2
        if sm is not None:
            if s is not None:
                draw_quantile_fan(axes[r, col], s, us, higher_better=args.higher_better)
                pretrain_axes.append(axes[r, col])
            else:
                axes[r, col].set_visible(False)
            col += 1
        if sc is not None:
            if c is not None:
                hows |= set(draw_posttrain(axes[r, col], c, args.metric))
                if r == 0:
                    axes[r, col].legend(fontsize=5, frameon=False, loc="best")
            else:
                axes[r, col].set_visible(False)
            col += 1
    labels = [f"({chr(ord('a') + i)}) {tasks[i // ncols]}" if (i % ncols == 0 and tasks[0] is not None)
              else f"({chr(ord('a') + i)})" for i in range(len(tasks) * ncols)]
    paths = finish(fig, axes, args, labels, mark_axes=pretrain_axes)
    print("\n".join(paths))
    print("run: " + str(run) + ("; uncertainty: " + "; ".join(sorted(hows)) if hows else ""))
    return paths


if __name__ == "__main__":
    main()
