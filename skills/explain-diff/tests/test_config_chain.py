#!/usr/bin/env python3
"""Tests for config_chain.py against the fixtures/chain mini project. Run: python3 tests/test_config_chain.py"""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import config_chain as cc  # noqa: E402

FIX = os.path.join(HERE, "fixtures", "chain")
BASE = "slurm.py --num-xpus 64 -sH 10 -- python scripts/train.py --config configs/base.yaml --config configs/overlay.yaml -j exp_base --max-iters 300"
PROP = "slurm.py --num-xpus 256 -sH 10 -- python scripts/train.py --config configs/base.yaml --config configs/exp_warmup.yaml --config configs/overlay.yaml -j exp_warm --max-iters 400"


class ParseCmd(unittest.TestCase):
    def test_train_style_repeated_config(self):
        p = cc.parse_cmd(PROP)
        self.assertEqual(p["launcher"]["argv0"], "slurm.py")
        self.assertIn(("num-xpus", ["256"]), p["launcher"]["flags"])
        self.assertIn(("sH", ["10"]), p["launcher"]["flags"])
        self.assertEqual(p["script"], "scripts/train.py")
        self.assertEqual(p["layers"], ["configs/base.yaml", "configs/exp_warmup.yaml", "configs/overlay.yaml"])
        self.assertIn(("job-name", ["exp_warm"]), p["flags"])
        self.assertIn(("max-iters", ["400"]), p["flags"])

    def test_train_style_one_flag_many_paths_and_history_prefix(self):
        line = "2026-07-22T10:00:00|slurm.py -sP batch -sN 256 --preemptable -- python scripts/train.py --config a.yaml b.yaml --weights-from /w/example-checkpoint --async-eval 0 -j run1"
        p = cc.parse_cmd(line)
        self.assertEqual(p["layers"], ["a.yaml", "b.yaml"])
        self.assertIn(("preemptable", []), p["launcher"]["flags"])
        self.assertEqual(dict(p["flags"])["weights-from"], ["/w/example-checkpoint"])
        self.assertEqual(dict(p["flags"])["async-eval"], ["0"])

    def test_hydra_overrides_and_env(self):
        p = cc.parse_cmd("CUDA_VISIBLE_DEVICES=0 python train.py experiment=foo +trainer.lr=3e-4 ~model.head --fast")
        self.assertEqual(p["env"], {"CUDA_VISIBLE_DEVICES": "0"})
        self.assertEqual(p["overrides"], ["experiment=foo", "+trainer.lr=3e-4", "~model.head"])
        self.assertIn(("fast", []), p["flags"])

    def test_launcher_flags_do_not_leak_into_program(self):
        c = cc.chain_from_cmd("slurm.py --project example-project -- python scripts/train.py --config a.yaml", "x")
        self.assertNotIn("project", c["flags"])
        self.assertEqual(c["forwarded"], [])
        c2 = cc.chain_from_cmd("slurm.py --project example-project -- bash run.sh", "x")
        self.assertNotIn("project", c2["flags"])

    def test_config_override_json(self):
        p = cc.parse_cmd("""python scripts/train.py --config a.yaml --config-override '{"train_args": {"x": 1}}'""")
        self.assertEqual(p["config_overrides"], [{"train_args": {"x": 1}}])


class Compare(unittest.TestCase):
    def run_compare(self, loader):
        out = tempfile.mkdtemp()
        cwd = os.getcwd()
        os.chdir(FIX)  # yaml line lookups resolve relative layer paths against the repo
        try:
            return cc.compare(BASE, PROP, cc.Merger(loader, FIX), out), out
        finally:
            os.chdir(cwd)

    def test_exact_loader(self):
        r, out = self.run_compare("fakeproj.loader:load")
        self.assertTrue(r["loader"]["exact"])
        self.assertEqual([x["status"] for x in r["layers"]], ["same", "added", "same"])
        self.assertEqual(r["launcherChanges"], [{"flag": "num-xpus", "before": "64", "after": "256"}])
        d = {x["key"]: x for x in r["deltas"]}
        self.assertEqual((d["optimizer.lr"]["before"], d["optimizer.lr"]["after"]), (0.001, 0.002))
        self.assertTrue(d["optimizer.lr"]["setBy"].startswith("[2] exp_warmup.yaml:"), d["optimizer.lr"]["setBy"])
        self.assertEqual(d["train_args.max-iters"]["after"], 400)  # coerced to the config's int type
        self.assertEqual(d["train_args.max-iters"]["setBy"], "--max-iters")
        self.assertEqual(d["data.datasets"]["after"], ["a", "b", "c"])  # the loader's concat rule
        # a hook-derived key is credited to the layer whose prefix changed it (exp_warmup adds dataset "c")
        self.assertEqual(d["derived.n_datasets"]["setBy"], "[2] exp_warmup.yaml")
        self.assertNotIn("trainer.batch", d)  # overlay wins in both chains
        sh = {s["key"]: s for s in r["shadowed"]}
        self.assertEqual(set(sh), {"trainer.batch", "train_args.max-iters"})
        self.assertEqual((sh["trainer.batch"]["layerValue"], sh["trainer.batch"]["final"]), (64, 16))
        self.assertIn("overlay.yaml", sh["trainer.batch"]["winner"])
        self.assertEqual(sh["trainer.batch"]["line"], 6)  # "batch: 64" in exp_warmup.yaml
        self.assertEqual(sh["train_args.max-iters"]["winner"], "--max-iters")
        patch = open(os.path.join(out, "experiment.patch")).read()
        self.assertIn("diff --git a/run/command.txt b/run/command.txt", patch)
        self.assertIn("+  [2] configs/exp_warmup.yaml", patch)
        self.assertIn("-optimizer.lr: 0.001", patch)
        self.assertIn("+optimizer.lr: 0.002", patch)

    def test_builtin_merge_is_marked_approximate(self):
        r, _ = self.run_compare(None)
        self.assertFalse(r["loader"]["exact"])
        d = {x["key"]: x for x in r["deltas"]}
        self.assertEqual(d["data.datasets"]["after"], ["c"])  # no concat rule without the project's loader

    def test_patch_parses_for_lesson(self):
        _, out = self.run_compare("fakeproj.loader:load")
        import subprocess
        js = subprocess.run(["node", "-e", f"""
          import('{os.path.join(HERE, '..', 'scripts', 'lesson.mjs')}').then(m => {{
            const cs = m.collectFromPatch('{os.path.join(out, 'experiment.patch')}', {{ synthetic: true }});
            console.log(JSON.stringify(cs.files.map(f => [f.path, f.synthetic, f.hunks.length])));
          }})"""], capture_output=True, text=True, check=True).stdout
        files = json.loads(js)
        self.assertEqual([f[0] for f in files], ["run/command.txt", "run/effective-config.yaml"])
        self.assertTrue(all(f[1] and f[2] >= 1 for f in files))


class Cli(unittest.TestCase):
    def test_resolve_cli_with_cmd(self):  # regression: the subcommand dest and --cmd shared args.cmd
        import subprocess
        out = os.path.join(tempfile.mkdtemp(), "r.json")
        r = subprocess.run([sys.executable, os.path.join(HERE, "..", "scripts", "config_chain.py"), "resolve", "--cmd", PROP,
                            "--loader", "fakeproj.loader:load", "--repo", FIX, "--out", out], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(out) as f:
            cfg = json.load(f)
        self.assertEqual(cfg["optimizer"]["warmup"], 2000)
        self.assertEqual(cfg["train_args"]["max-iters"], 400)


class RunDir(unittest.TestCase):
    def test_chain_from_run_reads_args_json(self):
        d = tempfile.mkdtemp(prefix="1234-")
        run = os.path.join(d, "1234-exp_base")
        os.makedirs(run)
        with open(os.path.join(run, "args.json"), "w") as f:
            json.dump({"config": ["configs/base.yaml"], "max-iters": 300, "job-name": "exp_base"}, f)
        c = cc.chain_from_run(run + ":300", "baseline")
        self.assertEqual(c["layers"], ["configs/base.yaml"])
        self.assertEqual(c["run"]["id"], "1234")
        self.assertEqual(c["flags"]["max-iters"], 300)


if __name__ == "__main__":
    unittest.main(verbosity=1)
