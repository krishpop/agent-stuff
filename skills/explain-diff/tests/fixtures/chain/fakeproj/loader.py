"""Stand-in for a project loader: generic merge defaults, plus one concatenating list rule."""
import yaml

CONCAT = {("data", "datasets")}


def _merge(base, over, path=()):
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = _merge(out.get(k), v, path + (k,))
        return out
    if path in CONCAT and isinstance(base, list) and isinstance(over, list):
        return base + over
    return over


def load(paths, apply_merge_hooks=True):
    cfg = {}
    for p in paths:
        with open(p) as f:
            cfg = _merge(cfg, yaml.safe_load(f) or {})
    if apply_merge_hooks:
        cfg["derived"] = {"n_datasets": len(cfg.get("data", {}).get("datasets", []))}
    return cfg
