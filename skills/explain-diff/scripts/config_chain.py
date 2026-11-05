#!/usr/bin/env python3
"""config_chain.py: explain how a launch command becomes a runtime config, for explain-diff.

  parse-cmd "<command>"
      Structured parts: env, launcher flags, program, config layers, program flags, overrides.
  resolve (--cmd "<command>" | --run DIR | --layers A.yaml B.yaml ...) [--loader MOD:FN --repo DIR] --out FILE
      Merge the chain and write the effective config (JSON).
  compare --baseline (DIR | "<command>") --proposed (DIR | "<command>") [--loader MOD:FN --repo DIR] --out DIR
      Write compare.json (layer, flag, and key deltas with setters; shadowed writes; baseline drift)
      and experiment.patch (synthetic run/command.txt and run/effective-config.yaml), and print a summary.

The merge uses the project's own loader when --loader is given (exact). Without it, a built-in merge
copies a generic merge (maps merge, lists and scalars replace) and the result is marked approximate.
A run directory (train_logs/<id>-<job>/) supplies the exact config list and flags the run used, from its
args.json. Python 3 with PyYAML.
"""
from __future__ import annotations

import argparse
import difflib
import glob
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile

import yaml

NUMERIC = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")
OVERRIDE = re.compile(r"^(~|\+{1,2})?[A-Za-z_][\w.@/-]*(=.*)?$")
LIST_FLAGS = {"config", "config-override"}  # flags that take several values (argparse nargs="+")
SHORT = {"j": "job-name"}  # short program flags with a known long name
CLI_PREFIX = "train_args"  # CLI flags overwrite config["train_args"][<flag>]
VALUE_CHARS = 300  # longer values are cut in the synthetic patch (with a digest, so changes still show)


# ------------------------------------------------------------------ command parsing

HISTORY_TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\S*\|")


def tokenize(cmd: str) -> list[str]:
    cmd = re.sub(r"^\S+\|", "", cmd.strip())  # ~/.slurm_history lines start with "<timestamp>|"
    return shlex.split(cmd.replace("\\\n", " "))


def _is_flag(tok: str) -> bool:
    return tok.startswith("-") and len(tok) > 1 and not NUMERIC.match(tok)


def parse_flags(argv: list[str]) -> tuple[list[tuple[str, list[str]]], list[str]]:
    """Ordered (name, values) pairs plus leftover positionals. Only LIST_FLAGS take several values."""
    flags, pos, i = [], [], 0
    while i < len(argv):
        tok = argv[i]
        if _is_flag(tok):
            name = tok.lstrip("-")
            if tok.startswith("--") and "=" in name:
                name, val = name.split("=", 1)
                flags.append((name, [val]))
            else:
                vals = []
                while i + 1 < len(argv) and not _is_flag(argv[i + 1]) and (name in LIST_FLAGS or not vals):
                    if name not in LIST_FLAGS and OVERRIDE.match(argv[i + 1]) and "=" in argv[i + 1]:
                        break  # "k=v" after a boolean flag is a Hydra override, not this flag's value
                    vals.append(argv[i + 1])
                    i += 1
                flags.append((name, vals))
        else:
            pos.append(tok)
        i += 1
    return flags, pos


def parse_cmd(cmd: str) -> dict:
    toks = tokenize(cmd)
    env = {}
    while toks and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]):
        k, v = toks.pop(0).split("=", 1)
        env[k] = v
    launcher, program = ([], toks)
    if "--" in toks:
        i = toks.index("--")
        launcher, program = toks[:i], toks[i + 1:]
    interp, script, rest = [], None, list(program)
    if rest and re.search(r"(^|/)(python[0-9.]*|torchrun|accelerate|bash|sh|uv)$", rest[0]):
        interp.append(rest.pop(0))
        while rest and rest[0] in ("-u", "-O", "run"):
            interp.append(rest.pop(0))
        if rest and rest[0] == "-m" and len(rest) > 1:
            interp.append(rest.pop(0))
    if rest and not _is_flag(rest[0]):
        script = rest.pop(0)
    flags, pos = parse_flags(rest)
    layers, inline, prog_flags = [], [], []
    for name, vals in flags:
        if name in ("config", "c"):
            layers.extend(vals)
        elif name == "config-override":
            for v in vals:
                try:
                    inline.append(json.loads(v))
                except ValueError:
                    layers.append(v)  # a path given as an override file
        else:
            prog_flags.append((SHORT.get(name, name), vals))
    l_flags, l_pos = parse_flags(launcher[1:]) if launcher else ([], [])
    return {
        "env": env,
        "launcher": {"argv0": launcher[0] if launcher else None, "flags": l_flags, "positional": l_pos},
        "interpreter": interp,
        "script": script,
        "layers": layers,
        "config_overrides": inline,
        "flags": prog_flags,
        "overrides": [p for p in pos if OVERRIDE.match(p) and ("=" in p or p.startswith("~"))],
        "positional": [p for p in pos if not (OVERRIDE.match(p) and ("=" in p or p.startswith("~")))],
    }


# ------------------------------------------------------------------ YAML helpers

class _Loader(yaml.SafeLoader):
    """SafeLoader that keeps unknown tags (e.g. !include) as plain values instead of failing."""


def _unknown(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)


_Loader.add_multi_constructor("!", _unknown)


def load_yaml(path: str):
    with open(path) as f:
        if path.endswith(".json"):
            return json.load(f)
        return yaml.load(f, Loader=_Loader)


def yaml_lines(path: str) -> dict[str, int]:
    """Dotted key -> 1-based line where that key is written in this file."""
    out = {}
    try:
        with open(path) as f:
            root = yaml.compose(f, Loader=_Loader)
    except Exception:
        return out

    def walk(node, prefix):
        if isinstance(node, yaml.MappingNode):
            for k, v in node.value:
                key = f"{prefix}.{k.value}" if prefix else str(k.value)
                out[key] = k.start_mark.line + 1
                walk(v, key)

    walk(root, "")
    return out


def flatten(obj, prefix: str = "") -> dict:
    """Leaves only: scalars, lists, and empty maps. Keys starting with "$" are loader directives."""
    if isinstance(obj, dict) and obj:
        out = {}
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else str(k)))
        return out
    return {prefix: obj} if prefix else {}


def directives(obj) -> set[str]:
    found = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str) and k.startswith("$"):
                found.add(k)
            found |= directives(v)
    elif isinstance(obj, list):
        for v in obj:
            found |= directives(v)
    elif isinstance(obj, str) and "{{" in obj:
        found.add("{{ jinja }}")
    return found


# ------------------------------------------------------------------ merging

def generic_merge(base, over):
    """Default merge rule: maps merge key by key; lists and scalars replace."""
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            if isinstance(k, str) and k.startswith("$"):
                continue
            out[k] = generic_merge(out.get(k), v)
        return out
    return over


LOADER_SNIPPET = r"""
import importlib, json, os, sys
spec = json.load(sys.stdin)
sys.path.insert(0, spec["repo"]); os.chdir(spec["repo"])
mod, fn = spec["loader"].split(":")
load = getattr(importlib.import_module(mod), fn)
out = {}
def attempt(layers, hooks):
    # Full load first: a prefix that starts with a complete base config passes the loader's hooks and checks.
    try:
        return load(layers)
    except Exception:
        if hooks:
            raise
    try:
        return load(layers, apply_merge_hooks=False, run_sanity_checks=False)
    except TypeError:
        return load(layers, apply_merge_hooks=False)
for name, layers, hooks in spec["jobs"]:
    try:
        out[name] = {"ok": True, "config": attempt(layers, hooks)}
    except Exception as e:
        out[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
with open(spec["out"], "w") as f:
    json.dump(out, f, default=str)
"""


class Merger:
    def __init__(self, loader: str | None, repo: str | None, python: str | None = None):
        self.loader, self.repo = loader, os.path.abspath(os.path.expanduser(repo or "."))
        self.python = python or sys.executable

    @property
    def exact(self) -> bool:
        return bool(self.loader)

    def path(self, p: str) -> str:
        return p if os.path.isabs(p) else os.path.join(self.repo, p)

    def run(self, jobs: list[tuple[str, list[str], bool]]) -> dict:
        """jobs: (name, layers, apply_merge_hooks). Returns name -> {"ok", "config"|"error"}."""
        if not self.loader:
            res = {}
            for name, layers, _ in jobs:
                try:
                    cfg = {}
                    for p in layers:
                        cfg = generic_merge(cfg, load_yaml(self.path(p)) or {})
                    res[name] = {"ok": True, "config": cfg}
                except Exception as e:  # noqa: BLE001 - report, do not crash the comparison
                    res[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            return res
        with tempfile.NamedTemporaryFile("r", suffix=".json", delete=False) as out:
            spec = {"repo": self.repo, "loader": self.loader, "jobs": jobs, "out": out.name}
            proc = subprocess.run([self.python, "-c", LOADER_SNIPPET], input=json.dumps(spec), text=True,
                                  capture_output=True, timeout=1800)
            if proc.returncode != 0:
                raise RuntimeError(f"loader {self.loader} failed in {self.repo}:\n{proc.stderr[-3000:]}")
            with open(out.name) as f:
                res = json.load(f)
        os.unlink(out.name)
        return res


# ------------------------------------------------------------------ chains

def _coerce(raw: list[str], like):
    """CLI strings -> the type the merged config already holds (the parser's defaults come from it)."""
    def one(s):
        if isinstance(like, bool) or (isinstance(like, list) and like and isinstance(like[0], bool)):
            return s.lower() in ("1", "true", "yes", "on")
        for t in (int, float):
            try:
                return t(s)
            except ValueError:
                pass
        return s
    if not raw:
        return True
    if isinstance(like, list):
        return [one(s) for s in raw]
    return one(raw[0]) if len(raw) == 1 else [one(s) for s in raw]


def chain_from_cmd(cmd: str, label: str) -> dict:
    p = parse_cmd(cmd)
    m = HISTORY_TS.match(cmd.strip())
    flags = {k: v for k, v in p["flags"]}
    forwarded = {}
    return {"label": label, "command": re.sub(r"^\S+\|", "", cmd.strip()), "parts": p, "layers": p["layers"],
            "inline": p["config_overrides"], "flags": {**flags, **forwarded}, "forwarded": sorted(forwarded), "explicit": True,
            "minute": re.sub(r"[-T:]", "", m.group(1)) if m else None}


def history_line(job_name: str, history: str = "~/.slurm_history") -> str | None:
    """The last ~/.slurm_history line that launched this exact job name (it starts with "<timestamp>|")."""
    path = os.path.expanduser(history)
    if not os.path.exists(path):
        return None
    hit = None
    with open(path, errors="replace") as f:
        for line in f:
            if not HISTORY_TS.match(line):
                continue
            toks = line.split()
            if any(t in ("-j", "--job-name") and toks[i + 1] == job_name for i, t in enumerate(toks[:-1])):
                hit = line.strip()
    return hit


def launch_minute(job_name: str, history: str = "~/.slurm_history") -> str | None:
    """YYYYMMDDHHMM of the last history line that launched this exact job name."""
    line = history_line(job_name, history)
    m = HISTORY_TS.match(line) if line else None
    return re.sub(r"[-T:]", "", m.group(1)) if m else None


def find_snapshot(minute: str | None, layers: list[str], runs: str = "~/runs") -> str | None:
    """The code snapshot slurm.py made at launch (~/runs/<YYYYMMDDHHMM>-<id>) that holds every relative layer."""
    if not minute:
        return None
    rel = [p for p in layers if not os.path.isabs(p)]
    for d in sorted(glob.glob(os.path.expanduser(f"{runs}/{minute}-*")), reverse=True):
        if all(os.path.exists(os.path.join(d, p)) for p in rel):
            return d
    return None


def find_run_dir(job_name: str) -> str | None:
    hits = sorted(glob.glob(os.path.expanduser(f"~/train_logs/*-{job_name}")), key=os.path.getmtime)
    return hits[-1] if hits else None


def chain_from_run(run_dir: str, label: str) -> dict:
    run_dir = os.path.abspath(os.path.expanduser(run_dir.split(":")[0]))  # tolerate "<dir>:<step>"
    with open(os.path.join(run_dir, "args.json")) as f:
        args = json.load(f)
    layers = list(args.get("config") or [])
    flags = {k: v for k, v in args.items() if k not in ("config", "config-override")}
    saved = next((os.path.join(run_dir, n) for n in ("submitted_config.json", "config.json")
                  if os.path.exists(os.path.join(run_dir, n))), None)
    m = re.match(r"^(\d+)-(.+)$", os.path.basename(run_dir))
    cmd = "python <script> " + " ".join(f"--config {shlex.quote(c)}" for c in layers)
    # args.json has no launcher flags; the launch line in ~/.slurm_history does. Layers and flags stay from args.json.
    line = history_line(m.group(2)) if m else None
    parts = parse_cmd(line) if line else None
    if line:
        cmd = re.sub(r"^\S+\|", "", line)
    return {"label": label, "command": cmd, "parts": parts, "layers": layers, "inline": [],
            "flags": flags, "explicit": False, "run": {"dir": run_dir, "id": m.group(1) if m else None,
                                                      "job": m.group(2) if m else None, "saved": saved}}


def resolve_chain(chain: dict, merger: Merger, provenance: bool = False) -> dict:
    """Effective config, plus (optionally) the layer that last set each key."""
    layers = chain["layers"]
    jobs = [("final", layers, True)]
    if provenance:
        jobs += [(f"prefix{k}", layers[:k], False) for k in range(1, len(layers) + 1)]
    res = merger.run(jobs)
    if not res["final"]["ok"]:
        raise RuntimeError(f"{chain['label']}: merge failed: {res['final']['error']}")
    cfg = res["final"]["config"]
    for doc in chain["inline"]:  # --config-override documents merge after all layers
        cfg = generic_merge(cfg, doc)
    cli = {}
    ta = cfg.setdefault(CLI_PREFIX, {}) if isinstance(cfg, dict) else {}
    for name, raw in chain["flags"].items():
        key = name.replace("_", "-")
        val = raw if not chain["explicit"] else _coerce(raw, ta.get(key))
        if ta.get(key) != val:
            cli[f"{CLI_PREFIX}.{key}"] = f"--{name}" if chain["explicit"] else f"args.json {name}"
        ta[key] = val
    out = {"config": cfg, "flat": flatten(cfg), "cli": cli, "setters": {}, "warnings": []}
    if provenance:
        prev = {}
        for k in range(1, len(layers) + 1):
            r = res[f"prefix{k}"]
            if not r["ok"]:
                out["warnings"].append(f"prefix of {k} layers failed to merge: {r['error']}")
                continue
            cur = flatten(r["config"])
            for key, v in cur.items():
                if key not in prev or prev[key] != v:
                    out["setters"][key] = k - 1  # index into layers
            prev = cur
    return out


_LINES: dict[str, dict] = {}


def setter_of(key: str, chain: dict, resolved: dict, merger: "Merger") -> dict:
    if key in resolved["cli"]:
        return {"kind": "cli", "label": resolved["cli"][key]}
    i = resolved["setters"].get(key)
    if i is None:
        return {"kind": "hook", "label": "post-merge hook or --config-override"}
    path = chain["layers"][i]
    full = merger.path(path)
    lines = _LINES.setdefault(full, yaml_lines(full))
    return {"kind": "layer", "index": i, "path": path, "line": lines.get(key), "label": f"[{i + 1}] {os.path.basename(path)}" + (f":{lines[key]}" if key in lines else "")}


# ------------------------------------------------------------------ comparison

def _short(v) -> str:
    s = v if isinstance(v, str) else json.dumps(v, sort_keys=True, default=str)
    if len(s) > VALUE_CHARS:
        s = f"{s[:VALUE_CHARS]}… ({len(s)} chars, sha1 {hashlib.sha1(s.encode()).hexdigest()[:8]})"
    return s


def _groups(deltas: list[dict], depth: int = 3) -> list[list]:
    counts = {}
    for d in deltas:
        g = ".".join(d["key"].split(".")[:depth])
        counts[g] = counts.get(g, 0) + 1
    return sorted(([g, n] for g, n in counts.items()), key=lambda x: -x[1])[:15]


def layer_status(base: list[str], prop: list[str], mb: Merger, merger: Merger) -> tuple[list[dict], list[dict]]:
    """Annotate the proposed chain; pair a removed and an added layer that share a file name."""
    out, removed = [], [p for p in base if p not in prop]
    added = [p for p in prop if p not in base]
    pairs = {}
    for a in added:
        twin = next((r for r in removed if os.path.basename(r) == os.path.basename(a) and r not in pairs.values()), None)
        if twin:
            pairs[a] = twin
    common = [p for p in prop if p in base]
    common_base_order = [p for p in base if p in prop]
    for i, p in enumerate(prop):
        if p in base:
            # "moved" means the order among shared layers changed, which changes who wins a conflict.
            st = "same" if common.index(p) == common_base_order.index(p) else "moved"
            out.append({"path": p, "status": st, "index": i})
        elif p in pairs:
            q = pairs[p]
            try:
                fa, fb = flatten(load_yaml(mb.path(q)) or {}), flatten(load_yaml(merger.path(p)) or {})
                changed = sorted(k for k in set(fa) | set(fb) if fa.get(k) != fb.get(k))
            except Exception as e:  # noqa: BLE001
                changed = [f"(could not compare: {e})"]
            out.append({"path": p, "status": "edited" if changed else "copied", "index": i, "was": q,
                        "keysChanged": changed[:50], "nKeysChanged": len(changed)})
        else:
            out.append({"path": p, "status": "added", "index": i})
    gone = [{"path": r, "status": "removed"} for r in removed if r not in pairs.values()]
    return out, gone


def shadowed_writes(chain: dict, resolved: dict, layer_rows: list[dict], merger: Merger, only_changed: bool) -> list[dict]:
    """Keys a layer's own file sets whose runtime value comes from a later layer or a CLI flag."""
    out = []
    for row in layer_rows:
        if only_changed and row["status"] == "same":
            continue
        i, path = row["index"], row["path"]
        try:
            own = flatten(load_yaml(merger.path(path)) or {})
        except Exception:  # noqa: BLE001
            continue
        lines = yaml_lines(merger.path(path))
        for key, val in own.items():
            if any(part.startswith("$") for part in key.split(".")) or (isinstance(val, str) and "{{" in val):
                continue
            final = resolved["flat"].get(key, "<deleted>")
            if final == val:
                continue
            if isinstance(val, list) and isinstance(final, list) and all(x in final for x in val):
                continue  # a concatenating merge rule kept this layer's items
            winner = resolved["cli"].get(key)
            if not winner:
                j = resolved["setters"].get(key)
                if j is None or j <= i:
                    continue  # nothing later overrode it (a hook or template changed it)
                winner = f"[{j + 1}] {chain['layers'][j]}"
            out.append({"key": key, "layer": path, "line": lines.get(key), "layerValue": val, "final": final, "winner": winner})
    return out


def baseline_drift(chain: dict, resolved: dict) -> dict | None:
    saved = (chain.get("run") or {}).get("saved")
    if not saved:
        return None
    with open(saved) as f:
        ran = flatten(json.load(f))
    def norm(v):
        # The trainer resolves symlinks in paths after merging (_finalize_config), so compare resolved paths.
        if isinstance(v, str) and v.startswith("/"):
            return os.path.realpath(v)
        if isinstance(v, list):
            return [norm(x) for x in v]
        return v
    skip = {"_config_checksum"}
    diff = [k for k in set(ran) | set(resolved["flat"])
            if k not in skip and not k.startswith(f"{CLI_PREFIX}.") and str(norm(ran.get(k))) != str(norm(resolved["flat"].get(k)))]
    return {"saved": saved, "differs": len(diff),
            "examples": [{"key": k, "ran": _short(ran.get(k)), "recomputed": _short(resolved["flat"].get(k))} for k in sorted(diff)[:10]],
            "note": "Keys whose recomputed value differs from what the run saved, outside train_args. "
                    "Nonzero means a layer file or the loader changed since the run."}


def command_text(chain: dict, keep: set[str] | None = None) -> str:
    """One item per line, so a unified diff shows exactly which part changed. keep: flags to list (None = all)."""
    lines = []
    p = chain.get("parts")
    if p:
        if p["env"]:
            lines += ["# env"] + [f"  {k}={v}" for k, v in p["env"].items()]
        if p["launcher"]["argv0"]:
            lines += ["# launcher", p["launcher"]["argv0"]] + [f"  -{'-' if len(n) > 2 else ''}{n} {' '.join(v)}".rstrip() for n, v in p["launcher"]["flags"]]
        lines += ["# program", " ".join(p["interpreter"] + [p["script"] or ""]).strip()]
    else:
        lines += ["# run", f"  {chain['run']['dir']}"]
    lines += ["# config layers (later layers win)"] + [f"  [{i + 1}] {c}" for i, c in enumerate(chain["layers"])]
    for doc in chain["inline"]:
        lines.append(f"  [override] {json.dumps(doc, sort_keys=True)}")
    lines.append("# flags")
    for k in sorted(chain["flags"]):
        if keep is not None and k not in keep:
            continue
        v = chain["flags"][k]
        lines.append(f"  --{k} {' '.join(map(str, v)) if isinstance(v, list) else v}".rstrip())
    for o in (p or {}).get("overrides", []):
        lines.append(f"  {o}")
    return "\n".join(lines) + "\n"


def config_text(flat: dict) -> str:
    return "".join(f"{k}: {_short(flat[k])}\n" for k in sorted(flat))


def unified(path: str, a: str, b: str) -> str:
    body = list(difflib.unified_diff(a.splitlines(True), b.splitlines(True), f"a/{path}", f"b/{path}", n=3))
    return f"diff --git a/{path} b/{path}\n" + "".join(body) if body else ""


def load_chain(spec: str, label: str) -> dict:
    s = os.path.expanduser(spec)
    if os.path.isdir(s.split(":")[0]):
        return chain_from_run(s, label)
    chain = chain_from_cmd(spec, label)
    job = chain["flags"].get("job-name")
    if job and (d := find_run_dir(job[0] if isinstance(job, list) else job)):
        chain["runDirGuess"] = d  # a past run with this job name exists; the user may want it as baseline
    return chain


def pick_repo(chain: dict, choice: str | None, fallback: Merger) -> tuple[Merger, str]:
    """choice: a directory, "auto" (the launch snapshot, else the fallback repo), or None (fallback)."""
    if choice and choice != "auto":
        return Merger(fallback.loader, choice, fallback.python), "given"
    if choice == "auto":
        job = (chain.get("run") or {}).get("job") or chain["flags"].get("job-name")
        job = job[0] if isinstance(job, list) else job
        minute = chain.get("minute") or (launch_minute(job) if job else None)
        snap = find_snapshot(minute, chain["layers"])
        if snap:
            return Merger(fallback.loader, snap, fallback.python), f"launch snapshot ({minute})"
    return fallback, "default repo"


def compare(base_spec: str, prop_spec: str, merger: Merger, out_dir: str,
            base_repo: str | None = "auto", prop_repo: str | None = "auto") -> dict:
    base, prop = load_chain(base_spec, "baseline"), load_chain(prop_spec, "proposed")
    mb, why_b = pick_repo(base, base_repo, merger)
    mp, why_p = pick_repo(prop, prop_repo, merger)
    rb, rp = resolve_chain(base, mb, provenance=True), resolve_chain(prop, mp, provenance=True)
    keys = sorted(k for k in set(rb["flat"]) | set(rp["flat"]) if rb["flat"].get(k, "<unset>") != rp["flat"].get(k, "<unset>"))
    deltas = []
    for k in keys:
        deltas.append({"key": k, "before": rb["flat"].get(k, "(unset)"), "after": rp["flat"].get(k, "(unset)"),
                       "setBy": setter_of(k, prop, rp, mp)["label"] if k in rp["flat"] else "removed",
                       "baselineSetBy": setter_of(k, base, rb, mb)["label"] if k in rb["flat"] else "(unset)",
                       "status": "unexplained"})
    # A run's args.json holds every argparse default; a command holds only its explicit flags. Do not
    # report train_args keys that exist only on the args.json side: they are parser defaults, not changes.
    if base["explicit"] != prop["explicit"]:
        cmd_side = rp if prop["explicit"] else rb
        noise = [d for d in deltas if d["key"].startswith(f"{CLI_PREFIX}.") and d["key"] not in cmd_side["flat"]]
        deltas = [d for d in deltas if d not in noise]
        argparse_defaults = len(noise)
    else:
        noise = []
        argparse_defaults = 0
    noise_keys = {d["key"] for d in noise}
    # A key whose change repeats another delta under a different top-level prefix is a mirror, e.g.
    # GLOBAL_EXPORT_actor_config.env_config.x copies example_actor.env_config.x. Two keys mirror when they
    # agree after stripping "GLOBAL_EXPORT_" from the first part, or after dropping the first part (when at
    # least two parts remain), and their before/after values are equal.
    def forms(key):
        parts = key.split(".")
        out = {".".join([parts[0].removeprefix("GLOBAL_EXPORT_")] + parts[1:])}
        if len(parts) >= 3:
            out.add(".".join(parts[1:]))
        return out
    primaries = {}
    for d in sorted(deltas, key=lambda d: (d["key"].startswith("GLOBAL_EXPORT"), len(d["key"]))):
        vals = (json.dumps(d["before"], sort_keys=True, default=str), json.dumps(d["after"], sort_keys=True, default=str))
        hit = next((primaries[(vals, f)] for f in forms(d["key"]) if (vals, f) in primaries), None)
        if hit:
            d["mirrorOf"] = hit
            continue
        for f in forms(d["key"]):
            primaries[(vals, f)] = d["key"]
    rows, gone = layer_status(base["layers"], prop["layers"], mb, mp)
    launcher = []
    if prop.get("parts") and base.get("parts"):
        lb, lp = dict(base["parts"]["launcher"]["flags"]), dict(prop["parts"]["launcher"]["flags"])
        launcher = [{"flag": f, "before": " ".join(lb.get(f, ["(unset)"])) or "(on)", "after": " ".join(lp.get(f, ["(unset)"])) or "(on)"}
                    for f in sorted(set(lb) | set(lp)) if lb.get(f) != lp.get(f)]
    warn = rb["warnings"] + rp["warnings"]
    if not merger.exact:
        used = set()
        for c, m in ((base, mb), (prop, mp)):
            for p in c["layers"]:
                try:
                    used |= directives(load_yaml(m.path(p)))
                except Exception:  # noqa: BLE001
                    pass
        if used:
            warn.append(f"layers use {sorted(used)}, which the built-in merge ignores; pass --loader for exact values")
    result = {
        "loader": {"exact": merger.exact, "loader": merger.loader,
                   "baselineRepo": mb.repo, "baselineRepoWhy": why_b, "proposedRepo": mp.repo, "proposedRepoWhy": why_p},
        "baseline": {k: base.get(k) for k in ("label", "command", "layers", "flags", "run", "runDirGuess") if k in base},
        "proposed": {k: prop.get(k) for k in ("label", "command", "layers", "flags", "run", "runDirGuess") if k in prop},
        "layers": rows, "removedLayers": gone, "launcherChanges": launcher,
        "deltas": deltas, "nDeltas": len([d for d in deltas if "mirrorOf" not in d]),
        "nMirrors": len([d for d in deltas if "mirrorOf" in d]), "argparseDefaultsSkipped": argparse_defaults,
        "deltaGroups": _groups([d for d in deltas if "mirrorOf" not in d]),
        "shadowed": shadowed_writes(prop, rp, rows, mp, only_changed=True),
        "drift": baseline_drift(base, rb), "warnings": warn,
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "compare.json"), "w") as f:
        json.dump(result, f, indent=1, default=str)
    # A run's args.json lists every parser flag. Show only the flags the other side sets or that really differ.
    def flag_keep(run_side, other_side, r_run, r_other):
        if run_side["explicit"]:
            return None
        ta_run, ta_other = r_run["config"].get(CLI_PREFIX, {}), r_other["config"].get(CLI_PREFIX, {})
        return {k for k in run_side["flags"] if k in other_side["flags"] or ta_run.get(k.replace("_", "-")) != ta_other.get(k.replace("_", "-"), ta_run.get(k.replace("_", "-")))}
    patch = unified("run/command.txt", command_text(base, flag_keep(base, prop, rb, rp)), command_text(prop, flag_keep(prop, base, rp, rb)))
    patch += unified("run/effective-config.yaml",
                     config_text({k: v for k, v in rb["flat"].items() if k not in noise_keys}),
                     config_text({k: v for k, v in rp["flat"].items() if k not in noise_keys}))
    with open(os.path.join(out_dir, "experiment.patch"), "w") as f:
        f.write(patch)
    return result


# ------------------------------------------------------------------ CLI

def summary(r: dict) -> str:
    lo = r["loader"]
    lines = [f"loader: {'exact ' + lo['loader'] if lo['exact'] else 'built-in (approximate)'}",
             f"  baseline repo: {lo['baselineRepo']} ({lo['baselineRepoWhy']})",
             f"  proposed repo: {lo['proposedRepo']} ({lo['proposedRepoWhy']})"]
    lines.append("layers: " + ", ".join(f"[{x['index'] + 1}] {x['status']}" for x in r["layers"]) + (f"; removed {len(r['removedLayers'])}" if r["removedLayers"] else ""))
    for x in r["layers"]:
        if x["status"] == "edited":
            lines.append(f"  [{x['index'] + 1}] {os.path.basename(x['path'])}: {x['nKeysChanged']} keys differ from {x['was']}")
    if r["launcherChanges"]:
        lines.append("launcher: " + "; ".join(f"{c['flag']} {c['before']} -> {c['after']}" for c in r["launcherChanges"]))
    lines.append(f"deltas: {r['nDeltas']} keys (+{r['nMirrors']} mirrored copies; {r['argparseDefaultsSkipped']} argparse defaults not compared)")
    lines.append("  groups: " + ", ".join(f"{g} ({n})" for g, n in r["deltaGroups"][:8]))
    shown = [d for d in r["deltas"] if "mirrorOf" not in d]
    for d in shown[:25]:
        lines.append(f"  {d['key']}: {_short(d['before'])[:60]} -> {_short(d['after'])[:60]}   ({d['setBy']})")
    if len(shown) > 25:
        lines.append(f"  … {r['nDeltas'] - 25} more in compare.json")
    lines.append(f"shadowed writes in changed layers: {len(r['shadowed'])}")
    for s in r["shadowed"][:10]:
        lines.append(f"  {s['key']} set in {os.path.basename(s['layer'])}:{s['line']} = {_short(s['layerValue'])[:40]}, but {s['winner']} wins with {_short(s['final'])[:40]}")
    if r["drift"]:
        lines.append(f"baseline drift: {r['drift']['differs']} keys differ from {r['drift']['saved']}")
    for w in r["warnings"]:
        lines.append(f"warning: {w}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="action", required=True)
    p1 = sub.add_parser("parse-cmd")
    p1.add_argument("command")
    for name in ("resolve", "compare"):
        p = sub.add_parser(name)
        p.add_argument("--loader", help="MOD:FN of the project's config loader, e.g. util.io:load_config")
        p.add_argument("--repo", default=".", help="repo root: relative config paths and the loader resolve here")
        p.add_argument("--python", help="interpreter for the loader (default: this one)")
        p.add_argument("--out", required=True)
        if name == "resolve":
            g = p.add_mutually_exclusive_group(required=True)
            g.add_argument("--cmd")
            g.add_argument("--run")
            g.add_argument("--layers", nargs="+")
        else:
            p.add_argument("--baseline", required=True, help="train_logs run dir, or a launch command")
            p.add_argument("--proposed", required=True, help="launch command, or a train_logs run dir")
            p.add_argument("--baseline-repo", default="auto", help='"auto" (launch snapshot under ~/runs, else --repo) or a dir')
            p.add_argument("--proposed-repo", default="auto", help='"auto" (launch snapshot under ~/runs, else --repo) or a dir')
    a = ap.parse_args(argv)
    if a.action == "parse-cmd":
        print(json.dumps(parse_cmd(a.command), indent=1))
        return 0
    merger = Merger(a.loader, a.repo, a.python)
    if a.action == "resolve":
        chain = (chain_from_cmd(a.cmd, "chain") if a.cmd else chain_from_run(a.run, "chain") if a.run
                 else {"label": "chain", "command": "", "parts": None, "layers": a.layers, "inline": [], "flags": {}, "explicit": True})
        r = resolve_chain(chain, merger)
        with open(a.out, "w") as f:
            json.dump(r["config"], f, indent=1, default=str)
        print(json.dumps({"out": a.out, "keys": len(r["flat"]), "layers": len(chain["layers"]), "cliOverrides": r["cli"], "exact": merger.exact, "warnings": r["warnings"]}, indent=1))
        return 0
    r = compare(a.baseline, a.proposed, merger, a.out, a.baseline_repo, a.proposed_repo)
    print(summary(r))
    print(f"wrote {os.path.join(a.out, 'compare.json')} and {os.path.join(a.out, 'experiment.patch')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
