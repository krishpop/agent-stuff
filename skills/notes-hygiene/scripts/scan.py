#!/usr/bin/env python3
"""Cheap health scan for a feature-notes workspace.

Answers "do these notes need cleaning yet?" without reading every doc into context.
Read-only: measures, never modifies. Exit 1 if any check FAILs.

Usage: scan.py [NOTES_DIR]   (default: cwd)
"""
import os
import re
import sys
import time
from collections import Counter

DOC_EXT = {".md", ".txt", ".rst"}
# Files that are working notes vs. byproducts of doing the work.
SCRATCH_HINT = re.compile(r"(^_|\.ipynb$|\.html$|\.json$|\.py$|\.csv$|\.png$|checkpoint)", re.I)
STATUS_HINT = re.compile(r"status", re.I)
TASK_SECTION = re.compile(r"^#+\s.*(next step|todo|task|open item|action)", re.I)
BULLET = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+\S")
# A task is checkable if it says how you'd know it's finished.
DONE_SIGNAL = re.compile(
    r"(done when|until|pass(es|ing)? if|criteri|verify|confirm|assert|"
    r"expect|threshold|>=|<=|[<>≥≤]\s*\d|\bN\b|success rate)", re.I)
# High-signal repeated facts: env vars, ids, paths, underscored identifiers.
FACT = re.compile(r"\b(?:[A-Z][A-Z0-9_]{5,}|[\w./-]*(?:_[\w./-]+){1,}|\w*\d{3,}\w*)\b")
STOP = {"the", "and", "for", "with", "this", "that", "from", "have", "into"}


def humanize(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024


def main(root):
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        sys.exit(f"not a directory: {root}")

    docs, scratch = {}, {}
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isfile(path) or name.startswith("."):
            continue
        ext = os.path.splitext(name)[1].lower()
        (docs if (ext in DOC_EXT and not SCRATCH_HINT.search(name)) else scratch)[path] = os.path.getsize(path)

    if not docs:
        sys.exit(f"no note documents found in {root}")

    findings, now = [], time.time()
    doc_bytes, scratch_bytes = sum(docs.values()), sum(scratch.values())

    # 1. Scratch crowding out the notes.
    total = doc_bytes + scratch_bytes
    ratio = scratch_bytes / total if total else 0
    findings.append((
        ratio > 0.50,
        f"scratch bytes {humanize(scratch_bytes)} vs notes {humanize(doc_bytes)} "
        f"({ratio:.1%} scratch, {len(scratch)} files)",
        "evict/archive scratch — notes should dominate the dir"))

    # 2. Status doc lagging behind the work.
    status = [p for p in docs if STATUS_HINT.search(os.path.basename(p))]
    newest = max(os.path.getmtime(p) for p in list(docs) + list(scratch))
    if status:
        s = status[0]
        lag_d = (newest - os.path.getmtime(s)) / 86400
        age_d = (now - os.path.getmtime(s)) / 86400
        findings.append((
            lag_d > 2,
            f"{os.path.basename(s)} is {age_d:.1f}d old; {lag_d:.1f}d behind newest file in dir",
            "work continued after the status doc stopped — re-verify its claims against live state"))
    else:
        findings.append((True, "no status-like doc found", "add one canonical current-state doc"))

    # 3. Same fact restated across many docs.
    seen, bodies = Counter(), {}
    for p in docs:
        try:
            bodies[p] = open(p, errors="ignore").read()
        except OSError:
            continue
        for tok in {t for t in FACT.findall(bodies[p]) if len(t) > 7 and t.lower() not in STOP}:
            seen[tok] += 1
    spread = [(t, c) for t, c in seen.most_common() if c >= 3][:8]
    findings.append((
        len(spread) >= 5,
        f"{len([1 for _, c in seen.items() if c >= 3])} facts appear in 3+ docs"
        + (f" (e.g. {', '.join(t for t, _ in spread[:4])})" if spread else ""),
        "give each fact ONE canonical home; others link to it"))

    # 4. Tasks with no checkable done-criterion.
    vague = []
    for p, body in bodies.items():
        in_tasks = False
        for line in body.splitlines():
            if line.startswith("#"):
                in_tasks = bool(TASK_SECTION.match(line))
            elif in_tasks and BULLET.match(line) and not DONE_SIGNAL.search(line):
                vague.append((os.path.basename(p), line.strip()))
    findings.append((
        len(vague) > 2,
        f"{len(vague)} task bullets lack a done-criterion"
        + (f" (e.g. \"{vague[0][1][:70]}\")" if vague else ""),  # truncate at print only
        "each open task needs a condition you can check"))

    # 5. Vestigial docs.
    vestigial = [os.path.basename(p) for p, b in bodies.items() if len(b.splitlines()) < 5]
    findings.append((
        bool(vestigial),
        f"{len(vestigial)} near-empty docs" + (f": {', '.join(vestigial)}" if vestigial else ""),
        "fold into a real doc or delete"))

    # 6. Filenames that no longer describe their contents.
    liars = []
    for p, body in bodies.items():
        stem = os.path.splitext(os.path.basename(p))[0]
        for tok in re.split(r"[^A-Za-z0-9]+", stem):
            if len(tok) > 2 and not tok.isdigit() and tok.lower() not in body.lower():
                liars.append(f"{os.path.basename(p)} (name says '{tok}', body never does)")
                break
    findings.append((
        bool(liars),
        f"{len(liars)} filename/content mismatches" + (f": {liars[0]}" if liars else ""),
        "rename so the filename matches what's inside"))

    print(f"notes-hygiene scan: {root}\n" + "=" * 60)
    failed = 0
    for bad, msg, fix in findings:
        print(f"  [{'FAIL' if bad else 'ok  '}] {msg}")
        if bad:
            failed += 1
            print(f"         -> {fix}")
    print("=" * 60)
    print(f"{failed}/{len(findings)} checks failed — "
          + ("run the notes-hygiene workflow" if failed else "notes are healthy"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
