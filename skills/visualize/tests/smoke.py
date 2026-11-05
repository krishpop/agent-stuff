# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8", "numpy", "pandas"]
# ///
"""Smoke test: SYNTHETIC data (test-only — never present these plots as results) through every chart.

    uv run --no-project tests/smoke.py

Checks the pass@k estimator against exact binomial coefficients, the IQM, and that every
script writes non-empty figures for a two-task dataset with the paper's qualitative shape
(pass@1 rising while pass@K collapses late).
"""

from __future__ import annotations

import math
import os
import sys
import tempfile

os.environ.setdefault("MPLBACKEND", "Agg")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import passk_curve, posttrain_by_init, quantile_fan, run_report, success_count_distribution, vizcommon  # noqa: E402,E401


def test_pass_at_k():
    for n, c, k in [(32, 0, 1), (32, 32, 5), (32, 5, 1), (32, 5, 16), (10, 3, 10), (10, 3, 7), (10, 3, 8)]:
        exact = 1 - math.comb(n - c, k) / math.comb(n, k) if n - c >= k else 1.0
        got = float(vizcommon.pass_at_k(n, c, k))
        assert abs(got - exact) < 1e-12, (n, c, k, got, exact)
    assert np.allclose(vizcommon.pass_at_k([32, 32], [1, 32], 32), [1.0, 1.0])
    assert np.allclose(vizcommon.pass_at_k([32, 32], [0, 16], 1), [0.0, 0.5])


def test_iqm_and_grid():
    assert vizcommon.iqm(np.array([0, 1, 2, 3, 100.0])) == 2.0
    grid, runs = vizcommon.common_grid([([0, 10, 20], [0, 1, 2]), ([0, 5, 15], [0, 1, 3])])
    assert grid.tolist() == [0, 5, 10, 15] and runs.shape == (2, 4)   # 20 is beyond the shorter seed
    center, lo, hi, how = vizcommon.aggregate(np.random.default_rng(0).normal(size=(6, 4)))
    assert how.startswith("IQM") and (lo <= center).all() and (center <= hi).all()


def synthetic(d, rng):
    steps = np.arange(0, 1001, 100)
    tasks = ["lift", "stack"]
    K, n_cond = 32, 40
    ev = []
    for task in tasks:
        base = rng.normal(0, 1, n_cond)
        for step in steps:
            x = step / 1000
            p = 1 / (1 + np.exp(-(base + 3 * x - 1)))
            collapse = np.where(base < -0.3, np.clip(1 - 2.5 * (x - 0.4), 0, 1), 1.0)
            succ = rng.binomial(K, p * collapse)
            ev += [dict(task=task, run_id="pretrain", seed=0, step=int(step), condition_id=f"c{i}",
                        n_trials=K, n_success=int(s)) for i, s in enumerate(succ)]
    sm = []
    for task in tasks:
        for step in steps:
            x = step / 1000
            for item in range(20):
                med = np.exp(-1.5 * x) * (1 + 0.3 * item / 20)
                vals = np.exp(rng.normal(np.log(med), 0.3 + 0.9 * x, 16))
                sm += [dict(task=task, run_id="pretrain", step=int(step), item_id=f"i{item}",
                            sample_id=j, score=float(v)) for j, v in enumerate(vals)]
    sc = []
    for task in tasks:
        for parent_step, plateau in [(400, 0.9), (1000, 0.6)]:
            for seed in range(3):
                for s in np.arange(0, 20001, 1000):
                    val = plateau * (1 - np.exp(-s / 6000)) + rng.normal(0, 0.03)
                    sc.append(dict(task=task, run_id=f"rl_from_{parent_step}_s{seed}", parent_run_id="pretrain",
                                   parent_step=parent_step, seed=seed, step=int(s), metric="success",
                                   value=float(np.clip(val, 0, 1))))
    paths = {}
    for name, rows in (("evals", ev), ("samples", sm), ("scalars", sc)):
        paths[name] = os.path.join(d, f"{name}.csv")
        pd.DataFrame(rows).to_csv(paths[name], index=False)
    return paths


def run(mod, argv):
    paths = mod.main(argv)
    for p in paths:
        assert os.path.getsize(p) > 0, p
    return paths


def main():
    test_pass_at_k()
    test_iqm_and_grid()
    d = tempfile.mkdtemp(prefix="visualize-smoke-")
    f = synthetic(d, np.random.default_rng(0))
    out = os.path.join(d, "figs")
    run(passk_curve, ["--evals", f["evals"], "--out", f"{out}/passk", "--mark", "400:selected"])
    run(passk_curve, ["--evals", f["evals"], "--vs-k", "--steps", "300,1000", "--out", f"{out}/passk_vs_k"])
    run(success_count_distribution, ["--evals", f["evals"], "--out", f"{out}/bins"])
    run(quantile_fan, ["--samples", f["samples"], "--out", f"{out}/quantiles"])
    run(posttrain_by_init, ["--scalars", f["scalars"], "--metric", "success", "--ema", "0.3", "--out", f"{out}/posttrain"])
    run(run_report, ["--evals", f["evals"], "--samples", f["samples"], "--scalars", f["scalars"],
                     "--metric", "success", "--mark", "400:selected", "--mark", "1000:final", "--out", f"{out}/report"])
    print(f"\nsmoke OK — synthetic figures in {out} (test data, not results)")


if __name__ == "__main__":
    main()
