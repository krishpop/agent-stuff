#!/usr/bin/env node
// lesson.mjs: the explain-diff page kit.
//
//   collect   changeset.json + annotated.txt from a live Hunk session, a git diff, or a patch
//   check     validate lesson.json against the changeset (anchors, coverage, quiz rules, safety)
//   render    lesson.json -> HTML page, Hunk sidecar, hunk-guide guide, live comment batch
//
// Zero dependencies, Node >= 18. The pi extension imports the exported functions.
// The model writes content and anchors only; everything shown as code comes from the diff.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LESSON_VERSION = 1;
export const STEP_KINDS = ["change", "verification", "supporting", "mechanical"];
export const INTENT_SOURCES = ["user", "pr", "commit", "notes", "decision-log", "inferred"];
export const INTENT_STATUS = ["done", "partial", "missing"];
export const DELTA_STATUS = ["intended", "unexplained", "shadowed", "missing"];
export const QUIZ_SHAPES = [
  "why", "trace", "change-one", "spot-break", "other-choice", "connect", "apply", "principle", "predict-value",
];

export const TRACK_PRIORITY = ["focus", "context"];
// Focus budgets (warnings): past these, the reader loses the thread.
export const BUDGET = { tldr: 400, summary: 450, coreSteps: 4, coreBody: 900, targetsShown: 2, stepsBeforeTracks: 6, targetsBeforeTracks: 12 };

/**
 * Tracks in reading order. Each track answers one question with its own walkthrough, questions, and "try it".
 * A lesson without tracks is one implicit track, so older lessons render exactly as before.
 */
export function tracksOf(lesson) {
  if (Array.isArray(lesson.tracks) && lesson.tracks.length) return lesson.tracks;
  return [{ id: "walkthrough", title: "Walkthrough", implicit: true, priority: "focus",
    steps: lesson.steps ?? [], quiz: lesson.quiz ?? [], tryIt: lesson.tryIt ?? [], unknowns: lesson.unknowns ?? [], experiment: lesson.experiment }];
}
/** Every item of one kind across tracks, each with its track and the JSON path prefix used in messages. */
export function across(lesson, key) {
  return tracksOf(lesson).flatMap((t, ti) => (t[key] ?? []).map((x, i) => ({ x, track: t, path: `${t.implicit ? "" : `tracks[${ti}].`}${key}[${i}]` })));
}
const allSteps = (lesson) => across(lesson, "steps").map((e) => e.x);

// A command that submits work to a cluster. "try it" must never run one silently.
export const LAUNCH_RE =
  /(^|[\s;&|(`])(sbatch|srun|salloc|slurm\.py|sarray|qsub|bsub|kubectl\s+(apply|create)|mlp\s+(run|launch|submit|recipe))(\s|$)/;
// Commands that destroy work or publish it. Never acceptable as "try it".
export const DESTRUCTIVE_RE =
  /(^|[\s;&|(])(rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|git\s+push|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+checkout\s+--\s|mkfs|dd\s+if=|scancel|kill\s+-9)/;

// ---------------------------------------------------------------- unified diff

function unquotePath(p) {
  if (p == null) return null;
  p = p.replace(/\t.*$/, "").trim(); // plain diffs append a timestamp after a tab
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parse unified diff text (git or plain) into files with numbered hunk lines. */
export function parsePatch(text, { synthetic = false } = {}) {
  const files = [];
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let file = null;
  const start = () => {
    file = { path: null, oldPath: null, status: "modified", binary: false, synthetic, hunks: [] };
    files.push(file);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      start();
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      if (m) [file.oldPath, file.path] = [m[1], m[2]];
      continue;
    }
    if (line.startsWith("--- ") && (!file || file.hunks.length)) start(); // plain diff, no "diff --git"
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) [file.oldPath, file.status] = [line.slice(12), "renamed"];
    else if (line.startsWith("rename to ")) file.path = line.slice(10);
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
    else if (line.startsWith("--- ")) {
      const p = unquotePath(line.slice(4));
      if (p == null) file.status = "added";
      file.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = unquotePath(line.slice(4));
      if (p == null) file.status = "deleted";
      else file.path = p;
    } else if (HUNK_RE.test(line)) {
      const m = HUNK_RE.exec(line);
      const h = {
        index: file.hunks.length,
        header: `@@ -${m[1]}${m[2] === undefined ? "" : `,${m[2]}`} +${m[3]}${m[4] === undefined ? "" : `,${m[4]}`} @@`,
        oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4],
        section: m[5] || "",
        lines: [],
      };
      file.hunks.push(h);
      // Consume exactly the counted lines, so content that looks like "--- x" stays content.
      let o = h.oldStart, n = h.newStart, oldLeft = h.oldLines, newLeft = h.newLines;
      while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
        const l = lines[++i];
        const t = l[0];
        if (t === "\\") continue; // "\ No newline at end of file"
        if (t === "+") { h.lines.push({ t, n: n++, s: l.slice(1) }); newLeft--; }
        else if (t === "-") { h.lines.push({ t, o: o++, s: l.slice(1) }); oldLeft--; }
        else { h.lines.push({ t: " ", o: o++, n: n++, s: l.slice(1) }); oldLeft--; newLeft--; }
      }
      if (lines[i + 1]?.startsWith("\\")) i++;
    }
  }
  for (const f of files) {
    if (f.status === "deleted") f.path = f.oldPath;
    if (!f.oldPath && f.status !== "added") f.oldPath = f.path;
    if (f.status === "added") f.oldPath = null;
    f.additions = f.hunks.reduce((a, h) => a + h.lines.filter((l) => l.t === "+").length, 0);
    f.deletions = f.hunks.reduce((a, h) => a + h.lines.filter((l) => l.t === "-").length, 0);
  }
  return files.filter((f) => f.path);
}

// ---------------------------------------------------------------- collect

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"], ...opts });
  } catch (e) {
    if (opts.allowExit1 && e.status === 1 && typeof e.stdout === "string") return e.stdout;
    throw e;
  }
}
const git = (cwd, args, opts) => sh("git", ["-C", cwd, ...args], opts);
const tryGit = (cwd, args) => { try { return git(cwd, args).trim(); } catch { return ""; } };

// Neutralise user diff config (noprefix, mnemonic prefixes, external diff, color).
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

/** Build a changeset from `hunk session review --include-patch --json` output. */
export function collectFromHunkReview(json) {
  const r = json.review ?? json;
  const files = [];
  for (const f of r.files ?? []) {
    const parsed = f.patch ? parsePatch(f.patch) : [];
    if (parsed.length) {
      const pf = parsed[0];
      pf.path = f.path; // Hunk's path is what navigation and notes use
      files.push(pf);
    } else {
      files.push({ path: f.path, oldPath: f.path, status: "modified", binary: true, synthetic: false, hunks: [], additions: f.additions ?? 0, deletions: f.deletions ?? 0 });
    }
  }
  const source = {
    kind: "hunk-session", sessionId: r.sessionId, title: r.title, label: r.sourceLabel,
    inputKind: r.inputKind, repoRoot: r.repoRoot, cwd: r.cwd,
  };
  if (r.repoRoot && /working tree$/.test(r.title ?? "")) {
    source.base = tryGit(r.repoRoot, ["rev-parse", "HEAD"]);
    source.head = "WORKTREE";
  }
  return { version: 1, source, files };
}

/** Ask the live Hunk session for its exact review contents. */
export function readHunkReview({ repo, session } = {}) {
  const sel = session ? [session] : ["--repo", repo ?? "."];
  return JSON.parse(sh("hunk", ["session", "review", ...sel, "--include-patch", "--json"]));
}

function untrackedPatch(cwd) {
  const out = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean).map((p) =>
    git(cwd, ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", p], { allowExit1: true })).join("");
}

/** Build a changeset from git. args: [] = working tree + untracked; ["A...B"], ["A..B"], ["A", "B"], ["--commit", X], ["--staged"]. */
export function collectFromGit(cwd, args = []) {
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]) || resolve(cwd);
  let diffArgs, base = "", head = "", target = args.join(" ") || "working tree";
  if (args.length === 0 || args[0] === "WORKTREE") {
    const text = git(root, ["diff", ...DIFF_FLAGS, "HEAD"]) + untrackedPatch(root);
    base = tryGit(root, ["rev-parse", "HEAD"]);
    return { version: 1, source: { kind: "git", target, repoRoot: root, base, head: "WORKTREE" }, files: parsePatch(text) };
  }
  if (args[0] === "--commit") {
    const c = tryGit(root, ["rev-parse", `${args[1]}^{commit}`]);
    if (tryGit(root, ["rev-list", "--parents", "-n", "1", c]).split(" ").length > 2)
      throw new Error(`${args[1]} is a merge commit; pass one parent range instead (A..B)`);
    diffArgs = [`${c}^`, c]; base = tryGit(root, ["rev-parse", `${c}^`]); head = c;
  } else if (args[0] === "--staged" || args[0] === "--cached") {
    diffArgs = ["--cached"]; base = tryGit(root, ["rev-parse", "HEAD"]); head = "INDEX";
  } else if (args.length === 1 && args[0].includes("...")) {
    const [a, b] = args[0].split("...");
    diffArgs = [args[0]];
    head = tryGit(root, ["rev-parse", `${b || "HEAD"}^{commit}`]);
    base = tryGit(root, ["merge-base", tryGit(root, ["rev-parse", `${a}^{commit}`]), head]);
  } else if (args.length === 1 && args[0].includes("..")) {
    const [a, b] = args[0].split("..");
    diffArgs = [args[0]];
    base = tryGit(root, ["rev-parse", `${a}^{commit}`]); head = tryGit(root, ["rev-parse", `${b || "HEAD"}^{commit}`]);
  } else if (args.length === 2) {
    diffArgs = args; base = tryGit(root, ["rev-parse", `${args[0]}^{commit}`]); head = tryGit(root, ["rev-parse", `${args[1]}^{commit}`]);
  } else {
    diffArgs = args; base = tryGit(root, ["rev-parse", `${args[0]}^{commit}`]); head = "WORKTREE";
  }
  const files = parsePatch(git(root, ["diff", ...DIFF_FLAGS, ...diffArgs]));
  return { version: 1, source: { kind: "git", target, repoRoot: root, base, head }, files };
}

export function collectFromPatch(path, { synthetic = false } = {}) {
  return { version: 1, source: { kind: "patch", patch: resolve(path) }, files: parsePatch(readFileSync(path, "utf8"), { synthetic }) };
}

/** Append files from extra changesets (e.g. a synthetic experiment.patch) to a primary one. */
export function mergeChangesets(primary, ...extra) {
  const out = structuredClone(primary);
  for (const cs of extra) {
    for (const f of cs.files) {
      if (out.files.some((g) => g.path === f.path)) throw new Error(`duplicate path in merged changesets: ${f.path}`);
      out.files.push(f);
    }
    (out.source.extra ??= []).push(cs.source);
  }
  return out;
}

const pad5 = (v) => (v === undefined ? "" : String(v)).padStart(5);
const span = (s, len) => (len === 0 ? `${s} (empty)` : `${s}-${s + len - 1}`);

/** Line-numbered view for the model: copy exact ranges from it. */
export function annotate(cs) {
  const out = [];
  cs.files.forEach((f, fi) => {
    const from = f.oldPath && f.oldPath !== f.path ? ` (from ${f.oldPath})` : "";
    const tags = [f.status, f.binary && "binary", f.synthetic && "synthetic"].filter(Boolean).join(", ");
    out.push(`F${fi + 1} ${f.path}${from} [${tags}] +${f.additions} -${f.deletions}`);
    f.hunks.forEach((h, hi) => {
      out.push(`  F${fi + 1}H${hi + 1} ${h.header}${h.section ? `  ${h.section}` : ""}  new ${span(h.newStart, h.newLines)} | old ${span(h.oldStart, h.oldLines)}`);
      for (const l of h.lines) out.push(`${pad5(l.o)} ${pad5(l.n)} ${l.t}${l.s}`);
    });
  });
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- lookups

export function findFile(cs, path, side = "new") {
  return cs.files.find((f) => (side === "old" ? f.oldPath === path || f.path === path : f.path === path));
}

function hunkRange(h, side) {
  return side === "old" ? [h.oldStart, h.oldStart + h.oldLines - 1] : [h.newStart, h.newStart + h.newLines - 1];
}

/** The hunk that wholly contains [start, end] on one side, or null. */
export function containingHunk(file, side, start, end) {
  return file?.hunks.find((h) => { const [a, b] = hunkRange(h, side); return start >= a && end <= b && b >= a; }) ?? null;
}

/** Text of a file at the change's head (or base for the old side), for references outside the diff. */
function readAtRef(cs, path, side) {
  // Absolute paths (experiment layers under ~/tmp, shared storage) live outside any repo: read them as they are now.
  if (isAbsolute(path)) { try { return readFileSync(path, "utf8"); } catch { return null; } }
  const root = cs.source.repoRoot;
  if (!root) return null;
  const ref = side === "old" ? cs.source.base : cs.source.head;
  try {
    if (!ref || ref === "WORKTREE") return readFileSync(join(root, path), "utf8");
    if (ref === "INDEX") return git(root, ["show", `:${path}`]);
    return git(root, ["show", `${ref}:${path}`]);
  } catch { return null; }
}

// ---------------------------------------------------------------- markdown subset

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const REF_RE = /\[\[([^\]\n]+?):(\d+)(?:-(\d+))?(?:\|(old|new))?\]\]/g;

/** Strip the markdown subset to plain text (sidecar notes, length checks). */
// Emphasis follows CommonMark flanking: no whitespace just inside the asterisks, so "0.1 * 2" stays literal.
const BOLD_RE = /\*\*(?=\S)([^*]*?\S)\*\*/g;
const ITALIC_RE = /(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g;

export function plain(src) {
  return String(src ?? "")
    .replace(REF_RE, (_, p, a, b) => `${p}:${a}${b ? `-${b}` : ""}`)
    .replace(/```[a-z]*\n?/g, "")
    .split(/(`[^`\n]*`)/) // odd parts are code spans: unwrap them, never parse markdown inside
    .map((part, i) => (i % 2 ? part.slice(1, -1)
      : part.replace(BOLD_RE, "$1").replace(ITALIC_RE, "$1$2").replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, "$1")))
    .join("").replace(/[ \t]+/g, " ").trim();
}

function inline(src, ctx) {
  const parts = [];
  let rest = String(src);
  const TOKEN = /(`[^`\n]+`)|(\[\[[^\]\n]+?:\d+(?:-\d+)?(?:\|(?:old|new))?\]\])|(\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\))/;
  while (rest) {
    const m = TOKEN.exec(rest);
    if (!m) { parts.push(emph(esc(rest))); break; }
    parts.push(emph(esc(rest.slice(0, m.index))));
    const tok = m[0];
    if (m[1]) parts.push(`<code>${esc(tok.slice(1, -1))}</code>`);
    else if (m[2]) {
      REF_RE.lastIndex = 0;
      const r = REF_RE.exec(tok);
      parts.push(ctx?.ref ? ctx.ref(r[1], +r[2], r[3] ? +r[3] : +r[2], r[4] || "new") : `<code>${esc(tok.slice(2, -2))}</code>`);
    } else {
      const lm = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)$/.exec(tok);
      const url = lm[2];
      const safe = /^(https?:\/\/|mailto:|#|\.{0,2}\/)/.test(url);
      parts.push(safe ? `<a href="${esc(url)}">${emph(esc(lm[1]))}</a>` : emph(esc(lm[1])));
    }
    rest = rest.slice(m.index + tok.length);
  }
  return parts.join("");
}
const emph = (s) => s.replace(BOLD_RE, "<strong>$1</strong>").replace(ITALIC_RE, "$1<em>$2</em>");

/** Render the markdown subset: paragraphs, - and 1. lists, ``` fences, inline code/bold/italic/links/[[refs]]. */
export function md(src, ctx) {
  if (src == null || src === "") return "";
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "), ctx)}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, ctx)}</li>`).join("")}</${list.tag}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const body = [];
      while (++i < lines.length && !/^```/.test(lines[i])) body.push(lines[i]);
      out.push(`<pre class="code"><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const li = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const tag = li[1] ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(li[3]);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("\n");
}

function collectRefs(text) {
  const refs = [];
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(String(text ?? "")))) refs.push({ path: m[1], start: +m[2], end: m[3] ? +m[3] : +m[2], side: m[4] || "new" });
  return refs;
}

// ---------------------------------------------------------------- check

/** Every prose field, with its JSON path, so refs anywhere get checked. */
function proseFields(lesson) {
  const out = [];
  const add = (p, v) => { if (typeof v === "string") out.push([p, v]); };
  add("tldr", lesson.tldr);
  add("background.deep", lesson.background?.deep); add("background.narrow", lesson.background?.narrow);
  add("intuition", lesson.intuition);
  (lesson.intents ?? []).forEach((x, i) => { add(`intents[${i}].text`, x.text); add(`intents[${i}].evidence`, x.evidence); });
  (lesson.unasked ?? []).forEach((x, i) => add(`unasked[${i}].text`, x.text));
  (lesson.findings ?? []).forEach((x, i) => { add(`findings[${i}].claim`, x.claim); add(`findings[${i}].evidence`, x.evidence); });
  tracksOf(lesson).forEach((t, ti) => {
    const pre = t.implicit ? "" : `tracks[${ti}].`;
    if (!t.implicit) { add(`${pre}question`, t.question); add(`${pre}why`, t.why); add(`${pre}summary`, t.summary); }
    (t.steps ?? []).forEach((x, i) => add(`${pre}steps[${i}].body`, x.body));
    (t.quiz ?? []).forEach((q, i) => { add(`${pre}quiz[${i}].stem`, q.stem); (q.options ?? []).forEach((o, j) => add(`${pre}quiz[${i}].options[${j}].feedback`, o.feedback)); });
    (t.tryIt ?? []).forEach((x, i) => { add(`${pre}tryIt[${i}].predict`, x.predict); add(`${pre}tryIt[${i}].lookFor`, x.lookFor); add(`${pre}tryIt[${i}].expect`, x.expect); });
    (t.unknowns ?? []).forEach((u, i) => add(`${pre}unknowns[${i}]`, u));
    add(`${pre}experiment.hypothesis`, t.experiment?.hypothesis); add(`${pre}experiment.notes`, t.experiment?.notes);
    (t.experiment?.deltas ?? []).forEach((d, i) => add(`${pre}experiment.deltas[${i}].note`, d.note));
  });
  return out;
}

const lenOf = (s) => plain(s).length;

/** Validate a lesson against its changeset. Returns { errors, warnings } (strings with JSON paths). */
export function checkLesson(lesson, cs) {
  const errors = [], warnings = [];
  const E = (m) => errors.push(m), W = (m) => warnings.push(m);
  const stance = lesson.stance ?? "lesson";
  if (lesson.version !== LESSON_VERSION) E(`version: must be ${LESSON_VERSION}`);
  if (!["lesson", "memo"].includes(stance)) E(`stance: "${stance}" is not lesson or memo`);
  if (!lesson.title) E("title: missing");
  if (!lesson.tldr) E("tldr: missing");

  const ids = new Map();
  const claim = (id, where) => {
    if (!id) return E(`${where}.id: missing`);
    if (ids.has(id)) E(`${where}.id: "${id}" also used at ${ids.get(id)}`);
    ids.set(id, where);
  };
  const intents = lesson.intents ?? [];
  intents.forEach((x, i) => {
    claim(x.id, `intents[${i}]`);
    if (!x.text) E(`intents[${i}].text: missing`);
    if (!INTENT_SOURCES.includes(x.source)) E(`intents[${i}].source: "${x.source}" is not one of ${INTENT_SOURCES.join("|")}`);
    if (!INTENT_STATUS.includes(x.status)) E(`intents[${i}].status: "${x.status}" is not one of ${INTENT_STATUS.join("|")}`);
    if (x.source === "user" && !x.quote) W(`intents[${i}]: source "user" without a quote; quote the user's words`);
  });
  const intentIds = new Set(intents.map((x) => x.id));

  const explicitTracks = Array.isArray(lesson.tracks) && lesson.tracks.length > 0;
  if (explicitTracks) {
    for (const k of ["steps", "quiz", "tryIt", "experiment"])
      if (lesson[k] !== undefined) E(`${k}: with tracks, move top-level ${k} into a track`);
    lesson.tracks.forEach((t, ti) => {
      const w = `tracks[${ti}]`;
      claim(t.id, w);
      if (!t.title) E(`${w}.title: missing`);
      if (!t.question) E(`${w}.question: state the one question this track answers`);
      if (t.priority && !TRACK_PRIORITY.includes(t.priority)) E(`${w}.priority: "${t.priority}" is not one of ${TRACK_PRIORITY.join("|")}`);
      if (!t.summary) W(`${w}.summary: give the key point first, in two or three sentences`);
      else if (lenOf(t.summary) > BUDGET.summary) W(`${w}.summary: ${lenOf(t.summary)} chars; keep the key point under ${BUDGET.summary}`);
      if (!(t.steps ?? []).length) E(`${w}.steps: a track needs at least one step`);
      const core = (t.steps ?? []).filter((x) => !x.detail);
      if (core.length > BUDGET.coreSteps) W(`${w}: ${core.length} core steps; keep ${BUDGET.coreSteps} or fewer and mark the rest "detail": true`);
      for (const id of t.intents ?? []) if (!intents.some((x) => x.id === id)) E(`${w}.intents: unknown intent "${id}"`);
    });
    if (lesson.tracks[0]?.priority === "context") W("tracks[0]: the first track is \"context\"; put a focus track first");
  }
  const stepEntries = across(lesson, "steps");
  const steps = stepEntries.map((e) => e.x);
  if (stance === "lesson" && steps.length === 0) E("steps: a lesson needs at least one step");
  if (lenOf(lesson.tldr) > BUDGET.tldr) W(`tldr: ${lenOf(lesson.tldr)} chars; the whole change should fit in ${BUDGET.tldr}`);
  if (!explicitTracks && stance === "lesson") {
    const nTargets = steps.reduce((n, x) => n + (x.targets ?? []).length, 0);
    if (steps.length > BUDGET.stepsBeforeTracks || nTargets > BUDGET.targetsBeforeTracks)
      W(`lesson: ${steps.length} steps and ${nTargets} code targets in one walkthrough; split them into tracks (references/lesson-schema.md)`);
  }
  const checkTarget = (t, where) => {
    const side = t.side ?? "new";
    if (!["new", "old"].includes(side)) return E(`${where}.side: "${side}" is not new or old`);
    const end = t.end ?? t.start;
    if (!Number.isInteger(t.start) || !Number.isInteger(end) || t.start < 1 || end < t.start)
      return E(`${where}: bad line range ${t.start}-${end}`);
    const f = findFile(cs, t.path, side);
    if (!f) return E(`${where}: ${t.path} is not in the changeset (files: ${cs.files.map((x) => x.path).join(", ")})`);
    if (f.status === "added" && side === "old") return E(`${where}: ${t.path} is a new file; use side "new"`);
    if (f.status === "deleted" && side === "new") return E(`${where}: ${t.path} was deleted; use side "old"`);
    const h = containingHunk(f, side, t.start, end);
    if (!h) {
      const spans = f.hunks.map((x) => hunkRange(x, side).join("-")).join(", ");
      return E(`${where}: ${t.path} ${side} ${t.start}-${end} is not inside one changed hunk (hunks on ${side}: ${spans || "none"})`);
    }
    if (t.highlight) {
      const key = side === "old" ? "o" : "n";
      const hit = h.lines.some((l) => l[key] >= t.start && l[key] <= end && l.s.includes(t.highlight));
      if (!hit) E(`${where}.highlight: "${t.highlight}" does not occur in ${t.path} ${side} ${t.start}-${end}`);
    }
  };
  stepEntries.forEach(({ x: s, path: w }) => {
    claim(s.id, w);
    if (!s.detail && lenOf(s.body) > BUDGET.coreBody) W(`${w}.body: ${lenOf(s.body)} chars; lead with the point, and move detail into a "detail": true step`);
    if (!s.title) E(`${w}.title: missing`);
    if (!STEP_KINDS.includes(s.kind ?? "change")) E(`${w}.kind: "${s.kind}" is not one of ${STEP_KINDS.join("|")}`);
    if (!s.body) W(`${w}.body: empty; say what the step does and why`);
    for (const id of s.intents ?? []) if (!intentIds.has(id)) E(`${w}.intents: unknown intent "${id}"`);
    if (!(s.targets ?? []).length) E(`${w}.targets: at least one target`);
    (s.targets ?? []).forEach((t, j) => checkTarget(t, `${w}.targets[${j}]`));
  });
  (lesson.unasked ?? []).forEach((u, i) => (u.targets ?? []).forEach((t, j) => checkTarget(t, `unasked[${i}].targets[${j}]`)));

  // References anywhere in prose must resolve: inside a hunk, or to real lines at the ref.
  for (const [where, text] of proseFields(lesson)) {
    for (const r of collectRefs(text)) {
      if (r.end < r.start) { E(`${where}: [[${r.path}:${r.start}-${r.end}]] ends before it starts`); continue; }
      const f = findFile(cs, r.path, r.side);
      if (f && containingHunk(f, r.side, r.start, r.end)) continue;
      const body = f?.synthetic ? null : readAtRef(cs, r.path, r.side);
      if (body == null) { E(`${where}: [[${r.path}:${r.start}${r.end !== r.start ? `-${r.end}` : ""}]] is neither inside a hunk nor a readable file at the ${r.side === "old" ? "base" : "head"}`); continue; }
      const n = body.split("\n").length;
      if (r.end > n) E(`${where}: [[${r.path}:${r.start}-${r.end}]] is past the end of the file (${n} lines)`);
    }
  }

  // Coverage: an agent-written diff must not hide a file.
  const skipped = new Set((lesson.skipped ?? []).map((s) => s.path));
  (lesson.skipped ?? []).forEach((s, i) => { if (!s.reason) E(`skipped[${i}].reason: say why ${s.path} is left out`); });
  const targets = [...steps.flatMap((s) => s.targets ?? []), ...(lesson.unasked ?? []).flatMap((u) => u.targets ?? [])];
  const needCoverage = stance === "lesson" || steps.length > 0;
  for (const f of cs.files) {
    const mine = targets.filter((t) => t.path === f.path || (t.side === "old" && t.path === f.oldPath));
    if (!mine.length) { if (needCoverage && !skipped.has(f.path)) E(`coverage: ${f.path} is in the changeset but no step or skipped entry covers it`); continue; }
    if (f.synthetic) continue; // experiment patches repeat changes under mirror keys; per-hunk coverage is noise there
    f.hunks.forEach((h, hi) => {
      const hit = mine.some((t) => { const side = t.side ?? "new"; const [a, b] = hunkRange(h, side); return (t.end ?? t.start) >= a && t.start <= b; });
      if (!hit && !skipped.has(f.path)) W(`coverage: ${f.path} hunk ${hi + 1} (${h.header}) is not targeted by any step`);
    });
  }

  // Quiz rules (adapted from explain-diff-html's quiz-design.md).
  const quizEntries = across(lesson, "quiz");
  const quiz = quizEntries.map((e) => e.x);
  const [qMin, qMax] = explicitTracks ? [3, 8] : [3, 5];
  if (stance === "lesson" && (quiz.length < qMin || quiz.length > qMax)) E(`quiz: ${quiz.length} questions; a lesson needs ${qMin} to ${qMax}`);
  if (explicitTracks) lesson.tracks.forEach((t, ti) => { if ((t.quiz ?? []).length > 3) W(`tracks[${ti}].quiz: ${(t.quiz ?? []).length} questions; keep 3 or fewer per track`); });
  let longestCorrect = 0;
  const correctPos = [];
  quizEntries.forEach(({ x: q, path: w }) => {
    claim(q.id, w);
    if (q.shape && !QUIZ_SHAPES.includes(q.shape)) W(`${w}.shape: "${q.shape}" is not a known shape (${QUIZ_SHAPES.join("|")})`);
    if (!q.stem) E(`${w}.stem: missing`);
    const opts = q.options ?? [];
    if (opts.length < 3 || opts.length > 4) E(`${w}.options: ${opts.length} options; use 3 or 4`);
    const correct = opts.filter((o) => o.correct === true);
    if (correct.length !== 1) E(`${w}.options: exactly one option must have "correct": true (found ${correct.length})`);
    opts.forEach((o, j) => {
      if (!o.text) E(`${w}.options[${j}].text: missing`);
      if (!o.feedback) E(`${w}.options[${j}].feedback: every option needs feedback that explains it`);
      if (/\b(all|none|both) of the above\b|\b(above|below|previous|next|first|second|third|last) (option|answer|choice)\b/i.test(o.text ?? ""))
        E(`${w}.options[${j}]: names another option by position; options are shuffled`);
    });
    if (opts.length >= 3 && correct.length === 1) {
      const lens = opts.map((o) => lenOf(o.text));
      const min = Math.max(1, Math.min(...lens)), max = Math.max(...lens);
      if (max > min * 1.5 + 10) E(`${w}.options: lengths ${lens.join("/")}; the longest is over 1.5x the shortest. Move reasoning into feedback`);
      else if (max > min * 1.25 + 6) W(`${w}.options: lengths ${lens.join("/")}; keep options within about a quarter of each other`);
      const ci = opts.indexOf(correct[0]);
      correctPos.push(ci);
      if (lens[ci] === max && lens.filter((l) => l === max).length === 1) longestCorrect++;
    }
  });
  if (longestCorrect > 2) E(`quiz: the correct option is the longest in ${longestCorrect} questions; a reader could answer by word count`);
  if (correctPos.length >= 3 && new Set(correctPos).size === 1) W(`quiz: every correct option sits at index ${correctPos[0]} in the source; vary it`);

  // Try it: safe by construction.
  across(lesson, "tryIt").forEach(({ x: t, path: w }) => {
    claim(t.id, w);
    if (!t.command) E(`${w}.command: missing`);
    if (!t.predict) E(`${w}.predict: ask for a prediction before the reveal`);
    if (!t.expect) E(`${w}.expect: say what the reader should see`);
    if (LAUNCH_RE.test(t.command ?? "") && t.launches !== true) E(`${w}: "${t.command}" submits a job; set "launches": true or use a dry run`);
    if (DESTRUCTIVE_RE.test(t.command ?? "")) E(`${w}: "${t.command}" destroys or publishes work; not allowed in try it`);
  });

  // Experiment card.
  tracksOf(lesson).forEach((tr, ti) => {
    const ex = tr.experiment;
    if (!ex) return;
    const pre = tr.implicit ? "" : `tracks[${ti}].`;
    (ex.deltas ?? []).forEach((d, i) => {
      const w = `${pre}experiment.deltas[${i}]`;
      if (!d.key) E(`${w}.key: missing`);
      if (!DELTA_STATUS.includes(d.status)) E(`${w}.status: "${d.status}" is not one of ${DELTA_STATUS.join("|")}`);
      if (d.intent && !intentIds.has(d.intent)) E(`${w}.intent: unknown intent "${d.intent}"`);
      if (d.status === "intended" && !d.intent) W(`${w}: "intended" without an intent id`);
    });
    for (const k of ["baseline", "proposed"]) if (ex[k] && !ex[k].command) W(`${pre}experiment.${k}.command: missing`);
  });

  // Memo stance (html-review).
  if (stance === "memo") {
    if (!(lesson.findings ?? []).length) E("findings: a memo needs at least one finding");
    if (!lesson.status) E("status: a memo needs works / broken / unknown buckets");
    (lesson.decisions ?? []).forEach((d, i) => {
      if (!d.question) E(`decisions[${i}].question: missing`);
      const n = (d.options ?? []).length;
      if (n < 2 || n > 4) E(`decisions[${i}].options: ${n} options; use 2 to 4`);
      if (!d.recommend?.option) W(`decisions[${i}].recommend: give a recommendation and one line of why`);
    });
  }
  (lesson.diagrams ?? []).forEach((d, i) => {
    claim(d.id, `diagrams[${i}]`);
    if (!d.caption) E(`diagrams[${i}].caption: state the one claim the figure makes`);
    const frames = d.frames ?? (d.kind === "mermaid" ? [] : [d]);
    frames.forEach((fr, j) => (fr.edges ?? []).forEach((e, k) => { if (!e.label) W(`diagrams[${i}].frames[${j}].edges[${k}]: label every arrow`); }));
  });
  (lesson.connections ?? []).forEach((c, i) => {
    if (!c.url || !/^https?:\/\//.test(c.url)) E(`connections[${i}].url: must be an http(s) URL`);
    if (!c.label) E(`connections[${i}].label: missing`);
  });
  return { errors, warnings };
}

// ---------------------------------------------------------------- outputs for Hunk

const firstSentences = (s, n = 2, max = 240) => {
  const p = plain(s);
  const parts = p.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [p];
  const out = parts.slice(0, n).join("").trim() || p;
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
};
const slug = (s) => String(s ?? "lesson").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "lesson";

/** Hunk --agent-context sidecar: files in story order, one note per step target. */
export function toSidecar(lesson, cs) {
  const order = [], byPath = new Map();
  const tracked = Array.isArray(lesson.tracks) && lesson.tracks.length > 0;
  const label = (e, si) => (tracked ? `${e.track.title} · ${si + 1}. ${e.x.title}` : `${si + 1}. ${e.x.title}`);
  const numbered = tracksOf(lesson).flatMap((tr) => (tr.steps ?? []).map((x, i) => ({ x, track: tr, i })));
  numbered.forEach(({ x: s, track, i: si }) => (s.targets ?? []).forEach((t) => {
    const f = findFile(cs, t.path, t.side ?? "new");
    if (!f) return;
    if (!byPath.has(f.path)) { byPath.set(f.path, { path: f.path, summary: s.title, annotations: [] }); order.push(f.path); }
    const side = t.side ?? "new";
    byPath.get(f.path).annotations.push({
      [side === "old" ? "oldRange" : "newRange"]: [t.start, t.end ?? t.start],
      summary: label({ x: s, track }, si),
      rationale: firstSentences(s.body, 3, 600),
      author: "explain-diff",
      id: `${s.id}:${t.start}`,
      tags: [s.kind ?? "change"],
    });
  }));
  return { version: 1, summary: plain(lesson.tldr), files: order.map((p) => byPath.get(p)) };
}

/** hunk-guide guide.json: one section per step, targets copied exactly. */
export function toGuide(lesson) {
  return {
    version: 1,
    id: `explain-diff-${slug(lesson.title)}`,
    title: lesson.title,
    summary: firstSentences(lesson.tldr, 1, 200),
    // Detail steps become "supporting", which hunk-guide hides by default: the same focus as the page.
    sections: across(lesson, "steps").map(({ x: s, track }) => ({
      id: s.id,
      kind: s.detail && (s.kind ?? "change") === "change" ? "supporting" : s.kind ?? "change",
      title: track.implicit ? s.title : `${track.title}: ${s.title}`,
      explanation: firstSentences(s.body, 2, 240),
      targets: (s.targets ?? []).map((t, i) => ({
        id: `${s.id}-t${i + 1}`, path: t.path, side: t.side ?? "new", startLine: t.start, endLine: t.end ?? t.start,
      })),
    })),
  };
}

/** Batch for `hunk session comment apply --stdin`: one note per step, on its first target. */
export function toCommentBatch(lesson) {
  return {
    comments: tracksOf(lesson).flatMap((tr) => (tr.steps ?? []).map((s, i) => ({ s, tr, i })))
      .filter(({ s }) => s.targets?.length).map(({ s, tr, i }) => {
        const t = s.targets[0];
        return {
          filePath: t.path, [(t.side ?? "new") === "old" ? "oldLine" : "newLine"]: t.start,
          summary: tr.implicit ? `${i + 1}. ${s.title}` : `${tr.title} · ${i + 1}. ${s.title}`,
          rationale: firstSentences(s.body, 3, 600), author: "explain-diff",
        };
      }),
  };
}

// ---------------------------------------------------------------- HTML

function remoteBlobBase(cs) {
  const root = cs.source.repoRoot, head = cs.source.head;
  if (!root || !head || !/^[0-9a-f]{40}$/.test(head)) return null;
  if (!tryGit(root, ["branch", "-r", "--contains", head])) return null; // unpushed: links would 404
  const url = tryGit(root, ["remote", "get-url", "origin"])
    .replace(/^([a-z+]+:\/\/[^/]*):[0-9]+\//, "$1/").replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]*@/, "")
    .replace(/^([^:/]+):/, "$1/").replace(/\.git\/?$/, "").replace(/\/$/, "");
  if (!/^[^/]*github[^/]*\//.test(url)) return null; // GitHub and GitHub Enterprise share the blob URL shape
  return `https://${url}/blob/${head}`;
}

function provenance(lesson, cs) {
  if (lesson.provenance) return lesson.provenance;
  const s = cs.source;
  const short = (x) => (/^[0-9a-f]{40}$/.test(x ?? "") ? x.slice(0, 9) : x);
  const what = s.kind === "hunk-session" ? `Hunk review "${s.title}"` : s.kind === "git" ? `git ${s.target}` : s.kind === "patch" ? `patch ${s.patch}` : "investigation";
  const range = s.base ? ` (${short(s.base)} → ${short(s.head)})` : "";
  return `${what}${range}${s.repoRoot ? ` in ${s.repoRoot}` : ""}`;
}

function diffBlock(f, h, side, start, end, highlight, ctxLines = 2) {
  const key = side === "old" ? "o" : "n";
  const idx = h.lines.map((l, i) => (l[key] >= start && l[key] <= end ? i : -1)).filter((i) => i >= 0);
  // Show what the target replaced: git prints a change block's deletions before its additions, so a new-side
  // target pulls in the "-" run just before its "+" block, and an old-side target the "+" run just after its
  // "-" block. Only when the target starts near that edge, and never more than 12 lines. Then a little context.
  let lo = idx[0], hi = idx[idx.length - 1];
  const same = side === "old" ? "-" : "+", other = side === "old" ? "+" : "-";
  if (side === "new") {
    let bs = lo;
    while (bs > 0 && h.lines[bs - 1].t === same) bs--;
    let k = bs;
    while (lo - bs <= 6 && k > 0 && h.lines[k - 1].t === other && bs - k < 12) k--;
    if (k < bs) lo = k;
  } else {
    let be = hi;
    while (be < h.lines.length - 1 && h.lines[be + 1].t === same) be++;
    let k = be;
    while (be - hi <= 6 && k < h.lines.length - 1 && h.lines[k + 1].t === other && k - be < 12) k++;
    if (k > be) hi = k;
  }
  lo = Math.max(0, lo - ctxLines);
  hi = Math.min(h.lines.length - 1, hi + ctxLines);
  const rows = [];
  for (let i = lo; i <= hi; i++) {
    const l = h.lines[i];
    const cls = l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx";
    const inTarget = i >= idx[0] && i <= idx[idx.length - 1];
    let text = esc(l.s);
    if (highlight && inTarget && l.s.includes(highlight)) {
      const k = l.s.indexOf(highlight);
      text = esc(l.s.slice(0, k)) + `<mark>${esc(highlight)}</mark>` + esc(l.s.slice(k + highlight.length));
    }
    const fade = inTarget ? "" : l.t === " " ? " dim" : " near";
    rows.push(`<tr class="${cls}${fade}"><td class="ln">${l.o ?? ""}</td><td class="ln">${l.n ?? ""}</td><td class="mk">${l.t === " " ? "" : l.t}</td><td class="src">${text || " "}</td></tr>`);
  }
  return `<table class="diff">${rows.join("")}</table>`;
}

function plainBlock(text, start, end) {
  const lines = text.split("\n");
  const rows = [];
  for (let n = start; n <= Math.min(end, lines.length); n++)
    rows.push(`<tr class="ctx"><td class="ln"></td><td class="ln">${n}</td><td class="mk"></td><td class="src">${esc(lines[n - 1]) || " "}</td></tr>`);
  return `<table class="diff">${rows.join("")}</table>`;
}

function navCmd(path, side, line) {
  return `hunk session navigate --repo . --file ${path} --${side}-line ${line}`;
}

// A [[path:a-b]] reference renders as an inline link (valid inside <p>). Its excerpt lives once in the
// "Code references" appendix; the page script shows it as a pop-over, and without scripts the link jumps there.
function makeCtx(cs, blobBase) {
  const refs = [];
  const ids = new Map();
  const ref = (path, start, end, side) => {
    const label = `${path}:${start}${end !== start ? `-${end}` : ""}${side === "old" ? " (before)" : ""}`;
    const key = `${side}|${path}|${start}|${end}`;
    if (!ids.has(key)) {
      const f = findFile(cs, path, side);
      const h = f && containingHunk(f, side, start, end);
      let body;
      if (h) body = diffBlock(f, h, side, start, end, null, 1);
      else {
        const text = f?.synthetic ? null : readAtRef(cs, path, side);
        body = text == null ? `<p class="muted">Not readable at this ref.</p>` : plainBlock(text, start, end);
      }
      const link = blobBase && side === "new" && !f?.synthetic ? `<a class="ext" href="${esc(`${blobBase}/${path}${/\.md$/i.test(path) ? "?plain=1" : ""}#L${start}${end !== start ? `-L${end}` : ""}`)}">source</a>` : "";
      const id = `ref-${refs.length + 1}`;
      ids.set(key, id);
      refs.push(`<div class="excerpt" id="${id}"><div class="reftools"><code>${esc(label)}</code><button type="button" class="copy" data-copy="${esc(navCmd(path, side, start))}">copy Hunk jump</button>${link}</div>${body}</div>`);
    }
    return `<a class="ref" href="#${ids.get(key)}"><code>${esc(label)}</code></a>`;
  };
  return { ref, refs };
}

function flowFrame(fr) {
  const nodes = fr.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = fr.edges ?? [];
  // A linear chain renders as boxes joined by labelled arrows; anything else lists edges.
  const chain = [];
  if (nodes.length && edges.length === nodes.length - 1) {
    let cur = nodes.find((n) => !edges.some((e) => e.to === n.id));
    while (cur) { chain.push(cur); const e = edges.find((x) => x.from === cur.id); cur = e ? byId.get(e.to) : null; }
  }
  if (chain.length === nodes.length && nodes.length) {
    const parts = [`<span class="node ${esc(chain[0].tone ?? "")}">${esc(chain[0].label)}</span>`];
    for (let i = 1; i < chain.length; i++) {
      const e = edges.find((x) => x.from === chain[i - 1].id && x.to === chain[i].id);
      parts.push(`<span class="step"><span class="arrow"><span class="elabel">${esc(e?.label ?? "")}</span>→</span><span class="node ${esc(chain[i].tone ?? "")}">${esc(chain[i].label)}</span></span>`);
    }
    return `<div class="flow">${parts.join("")}</div>`;
  }
  const rows = edges.map((e) => `<li><span class="node ${esc(byId.get(e.from)?.tone ?? "")}">${esc(byId.get(e.from)?.label ?? e.from)}</span> <span class="arrow"><span class="elabel">${esc(e.label ?? "")}</span>→</span> <span class="node ${esc(byId.get(e.to)?.tone ?? "")}">${esc(byId.get(e.to)?.label ?? e.to)}</span></li>`);
  const lone = nodes.filter((n) => !edges.some((e) => e.from === n.id || e.to === n.id)).map((n) => `<li><span class="node ${esc(n.tone ?? "")}">${esc(n.label)}</span></li>`);
  return `<ul class="graph">${[...rows, ...lone].join("")}</ul>`;
}

function diagramHtml(d, ctx) {
  let body;
  if (d.kind === "mermaid") {
    body = `<pre class="mermaid">${esc(d.source ?? "")}</pre>`;
  } else if (d.frames?.length > 1) {
    body = `<div class="frames" data-frames="${d.frames.length}">${d.frames.map((fr, i) =>
      `<div class="frame"${i ? " hidden" : ""}>${flowFrame(fr)}${fr.caption ? `<p class="fcap">${inline(fr.caption, ctx)}</p>` : ""}</div>`).join("")}
      <div class="fnav"><button type="button" class="fprev">← back</button><span class="fpos">1 / ${d.frames.length}</span><button type="button" class="fnext">add the next part →</button></div></div>`;
  } else {
    body = flowFrame(d.frames?.[0] ?? d);
  }
  return `<figure id="${esc(d.id)}">${body}<figcaption>${inline(d.caption ?? "", ctx)}</figcaption></figure>`;
}

const chip = (cls, text) => `<span class="chip ${esc(cls)}">${esc(text)}</span>`;

function renderIntents(lesson, ctx) {
  const intents = lesson.intents ?? [];
  if (!intents.length && !(lesson.unasked ?? []).length) return "";
  const tracked = Array.isArray(lesson.tracks) && lesson.tracks.length > 0;
  const where = (id) => tracksOf(lesson).flatMap((t) => (t.steps ?? []).map((st, i) => ({ st, i, t })))
    .filter(({ st }) => (st.intents ?? []).includes(id))
    .map(({ st, i, t }) => `<a href="#${esc(st.id)}">${tracked ? `${esc(t.title)} ${i + 1}` : `step ${i + 1}`}</a>`).join(", ");
  const rows = intents.map((x) => {
    const w = where(x.id) || (x.status === "missing" ? "<em>no change implements this</em>" : "—");
    return `<tr class="st-${esc(x.status)}"><td>${inline(x.text, ctx)}${x.quote ? `<blockquote>${esc(x.quote)}</blockquote>` : ""}${x.evidence ? `<div class="ev">${inline(x.evidence, ctx)}</div>` : ""}</td><td>${chip("src", x.source)}</td><td>${chip(`st ${x.status}`, x.status)}</td><td>${w}</td></tr>`;
  });
  const unasked = (lesson.unasked ?? []).map((u) => `<li>${inline(u.text, ctx)}${(u.targets ?? []).map((t) => ` ${ctx.ref(t.path, t.start, t.end ?? t.start, t.side ?? "new")}`).join("")}</li>`);
  return `<section id="intent"><h2>What you asked for, and where it landed</h2>
  ${rows.length ? `<table class="intents"><thead><tr><th>Intent</th><th>Source</th><th>Status</th><th>Where</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : ""}
  ${unasked.length ? `<div class="callout warn"><h3>Changes nobody asked for</h3><ul>${unasked.join("")}</ul></div>` : ""}
  </section>`;
}

/** One walkthrough. The first BUDGET.targetsShown excerpts show; the rest fold. Detail steps hide in Essentials mode. */
function renderSteps(steps, cs, ctx, { id = "walkthrough", title = "Walkthrough", level = 2 } = {}) {
  if (!steps?.length) return "";
  const map = steps.map((s, i) => `<span class="fm${s.detail ? " detail" : ""}">${i ? '<span class="muted"> → </span>' : ""}<a href="#${esc(s.id)}">${i + 1}. ${esc(s.title)}</a></span>`).join("");
  const block = (t) => {
    const side = t.side ?? "new", end = t.end ?? t.start;
    const f = findFile(cs, t.path, side);
    const h = f && containingHunk(f, side, t.start, end);
    if (!h) return `<p class="muted">${esc(t.path)}:${t.start}-${end} not found in the changeset.</p>`;
    const label = `${t.path}:${t.start}${end !== t.start ? `-${end}` : ""}${side === "old" ? " (before)" : ""}`;
    return `<div class="target"><div class="filename"><code>${esc(label)}</code><button type="button" class="copy" data-copy="${esc(navCmd(f.path, side, t.start))}">copy Hunk jump</button></div>${diffBlock(f, h, side, t.start, end, t.highlight)}${t.note ? `<p class="tnote">${inline(t.note, ctx)}</p>` : ""}</div>`;
  };
  const card = (s, i) => {
    const intents = (s.intents ?? []).map((x) => chip("intent", x)).join(" ");
    const targets = s.targets ?? [];
    const shown = targets.slice(0, BUDGET.targetsShown), more = targets.slice(BUDGET.targetsShown);
    const blocks = shown.map(block).join("") + (more.length
      ? `<details class="more-code"><summary>${more.length} more code excerpt${more.length > 1 ? "s" : ""}</summary>${more.map(block).join("")}</details>` : "");
    const kind = s.kind ?? "change";
    const inner = `${md(s.body, ctx)}${blocks}`;
    return `<article class="stepcard k-${esc(kind)}${s.detail ? " detail" : ""}" id="${esc(s.id)}"><h${level + 1}><span class="num">${i + 1}</span> ${esc(s.title)} ${chip(`kind ${kind}`, kind)}${s.detail ? ` ${chip("detail", "detail")}` : ""} ${intents}${s.inferred ? chip("inferred", "inferred") : ""}</h${level + 1}>
      ${kind === "mechanical" ? `<details><summary>Mechanical change: expand to see it</summary>${inner}</details>` : inner}</article>`;
  };
  const nDetail = steps.filter((x) => x.detail).length;
  const note = nDetail ? `<p class="detail-note">${nDetail} detail step${nDetail > 1 ? "s" : ""} hidden. <button type="button" class="show-all">Show everything</button></p>` : "";
  return `<section id="${esc(id)}"><h${level}>${esc(title)}</h${level}><p class="flowmap">${map}</p>${steps.map(card).join("\n")}${note}</section>`;
}

function renderExperiment(ex, ctx, sid = "experiment") {
  if (!ex) return "";
  const cmd = (side) => ex[side]?.command ? `<div class="cmd"><div class="cmdhead"><span>${esc(ex[side].label ?? side)}${ex[side].run?.url ? ` · <a href="${esc(ex[side].run.url)}">run ${esc(ex[side].run.id ?? "")}</a>` : ""}</span><button type="button" class="copy" data-copy="${esc(ex[side].command)}">copy</button></div><pre class="code"><code>${esc(ex[side].command)}</code></pre></div>` : "";
  const tokens = (ex.tokens ?? []).length ? `<table class="tokens"><thead><tr><th>Part</th><th>Role</th><th>What it does</th></tr></thead><tbody>${ex.tokens.map((t) =>
    `<tr class="${t.changed ? `chg-${esc(t.changed)}` : ""}"><td><code>${esc(t.text)}</code>${t.changed ? ` ${chip(`chg ${t.changed}`, t.changed)}` : ""}</td><td>${esc(t.role ?? "")}</td><td>${inline(t.explain ?? "", ctx)}</td></tr>`).join("")}</tbody></table>` : "";
  const layers = (ex.layers ?? []).length ? `<ol class="layers">${ex.layers.map((l) =>
    `<li class="ly-${esc(l.status ?? "same")}"><code>${esc(l.path)}</code> ${chip(`ly ${l.status ?? "same"}`, l.status ?? "same")}${l.role ? ` <span class="muted">${inline(l.role, ctx)}</span>` : ""}</li>`).join("")}</ol><p class="muted small">Later layers win. A key set in two layers takes the value from the lower one in this list.</p>` : "";
  const counts = Object.fromEntries(DELTA_STATUS.map((s) => [s, (ex.deltas ?? []).filter((d) => d.status === s).length]));
  const deltas = (ex.deltas ?? []).length ? `<div class="filters">${DELTA_STATUS.map((s) => `<button type="button" class="filter on" data-status="${s}">${s} <b>${counts[s]}</b></button>`).join("")}</div>
    <table class="deltas"><thead><tr><th>Key</th><th>Baseline</th><th>Proposed</th><th>Set by</th><th>Why</th></tr></thead><tbody>${ex.deltas.map((d) =>
    `<tr class="st-${esc(d.status)}" data-status="${esc(d.status)}"><td><code>${esc(d.key)}</code></td><td><code>${esc(fmtVal(d.before))}</code></td><td><code>${esc(fmtVal(d.after))}</code></td><td>${d.setBy ? inline(d.setBy, ctx) : ""}</td><td>${chip(`st ${d.status}`, d.status)}${d.intent ? ` ${chip("intent", d.intent)}` : ""}${d.note ? `<div class="small">${inline(d.note, ctx)}</div>` : ""}</td></tr>`).join("")}</tbody></table>` : "";
  return `<section id="${esc(sid)}"><h2>The experiment</h2>
    ${ex.hypothesis ? `<div class="callout key"><h3>Hypothesis</h3>${md(ex.hypothesis, ctx)}</div>` : ""}
    ${ex.approximate ? `<p class="callout warn">The effective values below come from a generic ordered merge, not the project's own loader. Treat them as approximate.</p>` : ""}
    <div class="cmds">${cmd("baseline")}${cmd("proposed")}</div>${tokens}
    ${layers ? `<h3>Config chain</h3>${layers}` : ""}
    ${deltas ? `<h3>What changes at runtime</h3>${deltas}` : ""}
    ${ex.notes ? md(ex.notes, ctx) : ""}</section>`;
}
const fmtVal = (v) => (v === undefined ? "(unset)" : typeof v === "string" ? v : JSON.stringify(v));

function renderQuiz(quiz, ctx, sid = "quiz") {
  if (!quiz?.length) return "";
  const qs = quiz.map((q, i) => `<div class="q" id="${esc(q.id)}" data-q="${i}"><p class="stem"><b>Q${i + 1}.</b> ${inline(q.stem, ctx)}</p>
    <div class="opts">${(q.options ?? []).map((o) => `<div class="opt"><button type="button" class="pick" data-correct="${o.correct ? 1 : 0}">${inline(o.text, ctx)}</button><div class="fb ${o.correct ? "right" : "wrong"}">${o.correct ? "<b>Right.</b> " : "<b>Not quite.</b> "}${md(o.feedback, ctx)}</div></div>`).join("")}</div></div>`).join("\n");
  return `<section id="${esc(sid)}" class="quiz"><h2>Check your understanding</h2><p class="muted">Pick an answer to see why it is right or wrong. Options shuffle on each load.</p>${qs}
    <div class="score" hidden><span class="scoretext"></span> <button type="button" class="copy export-misses">copy my misses as a prompt</button></div></section>`;
}

function renderTryIt(items, ctx, sid = "tryit") {
  if (!items?.length) return "";
  return `<section id="${esc(sid)}"><h2>Try it</h2><p class="muted">Predict first, then run the command and compare. Your prediction stays in this browser.</p>${items.map((t) => `
    <div class="try" id="${esc(t.id)}"><h3>${esc(t.title ?? t.id)}</h3>
      ${t.launches ? `<p class="callout bad">This command submits a job. Read it; run it only on purpose.</p>` : ""}
      <div class="predict">${md(t.predict, ctx)}<textarea data-key="${esc(t.id)}" placeholder="Your prediction"></textarea></div>
      <div class="cmd"><div class="cmdhead">${t.cwd ? `in <code>${esc(t.cwd)}</code>` : "command"}<button type="button" class="copy" data-copy="${esc(t.command)}">copy</button></div><pre class="code"><code>${esc(t.command)}</code></pre></div>
      <button type="button" class="reveal">I ran it: show what to expect</button>
      <div class="expect" hidden>${t.lookFor ? `<p><b>Look for:</b></p>${md(t.lookFor, ctx)}` : ""}<p><b>Expected:</b></p>${md(t.expect, ctx)}</div>
    </div>`).join("")}</section>`;
}

function renderDecisions(decisions, ctx) {
  if (!decisions?.length) return "";
  return `<section id="decisions"><h2>Decisions for you</h2>${decisions.map((d, i) => `<div class="decision"><h3>D${i + 1}. ${inline(d.question, ctx)}</h3><ul>${(d.options ?? []).map((o) =>
    `<li><b>${esc(o.label)}</b>: ${inline(o.meaning ?? "", ctx)}${o.cost ? ` <em>Cost:</em> ${inline(o.cost, ctx)}` : ""}</li>`).join("")}</ul>${d.recommend ? `<p class="rec"><b>Recommend ${esc(d.recommend.option)}.</b> ${inline(d.recommend.why ?? "", ctx)}</p>` : ""}</div>`).join("")}</section>`;
}

function renderConnections(conns, ctx) {
  if (!conns?.length) return "";
  return `<section id="connections"><h2>Connections</h2><ul class="conns">${conns.map((c) =>
    `<li>${chip(`ck ${c.kind ?? "other"}`, c.kind ?? "link")} <a href="${esc(c.url)}">${esc(c.label)}</a>${c.why ? ` <span class="muted">${inline(c.why, ctx)}</span>` : ""}</li>`).join("")}</ul></section>`;
}

function renderStatus(status, unknowns, ctx, sid = "unknown") {
  const b = (cls, title, items) => (items?.length ? `<div class="bucket ${cls}"><h3>${title}</h3><ul>${items.map((x) => `<li>${inline(x, ctx)}</li>`).join("")}</ul></div>` : "");
  if (status) return `<section id="status"><h2>Where things stand</h2>${b("ok", "Works", status.works)}${b("bad", "Does not work", status.broken)}${b("unk", "Unknown or untested", status.unknown)}</section>`;
  if (unknowns?.length) return `<section id="${esc(sid)}"><h2>Still unknown</h2>${b("unk", "Nobody verified these", unknowns)}</section>`;
  return "";
}

/** Render the page. opts: { template, title } */
export function renderHtml(lesson, cs, opts = {}) {
  const blobBase = opts.blobBase === undefined ? remoteBlobBase(cs) : opts.blobBase;
  const ctx = makeCtx(cs, blobBase);
  const leadHtml = md(lesson.tldr, ctx); // first, so its refs land in the appendix
  const stance = lesson.stance ?? "lesson";
  const diagrams = lesson.diagrams ?? [];
  const first = diagrams[0];
  const tracks = tracksOf(lesson);
  const tracked = stance === "lesson" && Array.isArray(lesson.tracks) && lesson.tracks.length > 0;
  const steps = allSteps(lesson);
  const nq = across(lesson, "quiz").length, nTry = across(lesson, "tryIt").length;
  const minutes = Math.max(3, Math.round((JSON.stringify(lesson).length / 1000) * 0.6));
  const linked = blobBase ? "References link to this commit." : "References are not linked: no pushed GitHub commit to link to.";
  const sec = [], toc = [];
  const add = (id, title, html, cls = "") => { if (html) { sec.push(html); toc.push([id, title, cls]); } };
  const bg = lesson.background ?? {};
  const background = bg.deep || bg.narrow ? `<section id="background"><h2>Background</h2>${bg.deep ? `<details class="deep"><summary>New to this code? Start here.</summary>${md(bg.deep, ctx)}</details>` : ""}${md(bg.narrow, ctx)}</section>` : "";
  const intuition = lesson.intuition ? `<section id="intuition"><h2>Intuition</h2>${md(lesson.intuition, ctx)}${diagrams.slice(1).filter((d) => d.section === "intuition").map((d) => diagramHtml(d, ctx)).join("")}</section>` : "";
  const rest = diagrams.slice(1).filter((d) => d.section !== "intuition");
  const figures = rest.length ? `<section id="figures"><h2>More pictures</h2>${rest.map((d) => diagramHtml(d, ctx)).join("")}</section>` : "";

  if (stance === "memo") {
    add("findings", "What we found", `<section id="findings"><h2>What we found</h2><ul class="findings">${(lesson.findings ?? []).map((f) =>
      `<li><b>${inline(f.claim, ctx)}</b>${f.evidence ? `<div class="ev">${inline(f.evidence, ctx)}</div>` : ""}</li>`).join("")}</ul>${diagrams.map((d) => diagramHtml(d, ctx)).join("")}</section>`);
    add("status", "Where things stand", renderStatus(lesson.status, null, ctx));
    add("decisions", "Decisions", renderDecisions(lesson.decisions, ctx));
    add("change", "The proposed change", renderSteps(steps, cs, ctx, { id: "change", title: "The proposed change" }));
    add("tryit", "Try it", renderTryIt(across(lesson, "tryIt").map((e) => e.x), ctx));
    add("connections", "Connections", renderConnections(lesson.connections, ctx));
  } else if (tracked) {
    // Overview tab: the whole change at a glance, then the tracks ranked, so the reader picks what to focus on.
    const rows = tracks.map((t, i) => {
      const prio = t.priority ?? "focus";
      const tSteps = t.steps ?? [];
      const core = tSteps.filter((x) => !x.detail).length;
      const shownCode = tSteps.filter((x) => !x.detail).reduce((n, x) => n + Math.min((x.targets ?? []).length, BUDGET.targetsShown), 0);
      const code = tSteps.reduce((n, x) => n + (x.targets ?? []).length, 0);
      return `<li class="trackcard p-${esc(prio)}"><a class="tlink" href="#t-${esc(t.id)}"><span class="tnum">${i + 1}</span> <span class="ttitle">${esc(t.title)}</span> ${chip(`prio ${prio}`, prio)}</a>
        <p class="tq">${inline(t.question ?? "", ctx)}</p>${t.why ? `<p class="twhy">${inline(t.why, ctx)}</p>` : ""}
        <p class="tmeta">${core} core step${core === 1 ? "" : "s"}${tSteps.length > core ? ` + ${tSteps.length - core} detail` : ""} · ${shownCode} code excerpt${shownCode === 1 ? "" : "s"}${code > shownCode ? ` (+${code - shownCode} folded)` : ""} · ${(t.quiz ?? []).length} question${(t.quiz ?? []).length === 1 ? "" : "s"}</p></li>`;
    }).join("");
    const overview = `<section class="tab" id="t-overview" data-tab="overview">
      ${first ? `<section id="picture"><h2>The change in one picture</h2>${diagramHtml(first, ctx)}</section>` : ""}
      <section id="tracks"><h2>Tracks</h2><p class="muted">Each track answers one question and reads on its own. Start with the focus tracks; open a context track when you need it.</p><ol class="tracks">${rows}</ol></section>
      ${renderIntents(lesson, ctx)}${intuition}${background}${figures}
      ${renderStatus(null, lesson.unknowns, ctx, "unknown")}${renderDecisions(lesson.decisions, ctx)}${renderConnections(lesson.connections, ctx)}</section>`;
    add("t-overview", "Overview", overview, "tabref");
    tracks.forEach((t, i) => {
      const prio = t.priority ?? "focus";
      const next = tracks[i + 1];
      const html = `<section class="tab track" id="t-${esc(t.id)}" data-tab="${esc(t.id)}">
        <p class="kicker">Track ${i + 1} of ${tracks.length} · ${esc(prio)}</p><h2 class="tracktitle">${esc(t.title)}</h2>
        <p class="lead">${inline(t.question ?? "", ctx)}</p>
        ${t.summary ? `<div class="callout key"><h3>The point</h3>${md(t.summary, ctx)}</div>` : ""}
        ${renderSteps(t.steps ?? [], cs, ctx, { id: `walk-${t.id}`, title: "Walkthrough", level: 3 })}
        ${renderExperiment(t.experiment, ctx, `experiment-${t.id}`)}${renderQuiz(t.quiz, ctx, `quiz-${t.id}`)}
        ${renderTryIt(t.tryIt, ctx, `tryit-${t.id}`)}${renderStatus(null, t.unknowns, ctx, `unknown-${t.id}`)}
        <p class="tracknav"><a href="#t-overview">← Overview</a>${next ? ` · <a href="#t-${esc(next.id)}">Next: ${esc(next.title)} →</a>` : ""}</p></section>`;
      add(`t-${t.id}`, t.title, html, `tabref p-${prio}`);
    });
  } else {
    add("picture", "The change in one picture", first ? `<section id="picture"><h2>The change in one picture</h2>${diagramHtml(first, ctx)}</section>` : "");
    add("intent", "What you asked for", renderIntents(lesson, ctx));
    add("background", "Background", background);
    add("intuition", "Intuition", intuition);
    add("walkthrough", "Walkthrough", renderSteps(steps, cs, ctx));
    add("figures", "More pictures", figures);
    add("experiment", "The experiment", renderExperiment(tracks[0].experiment, ctx));
    add("quiz", "Check your understanding", renderQuiz(tracks[0].quiz, ctx));
    add("tryit", "Try it", renderTryIt(tracks[0].tryIt, ctx));
    add("unknown", "Still unknown", renderStatus(null, tracks[0].unknowns, ctx));
    add("decisions", "Decisions for you", renderDecisions(lesson.decisions, ctx));
    add("connections", "Connections", renderConnections(lesson.connections, ctx));
  }
  const notes = `<details id="notes" open><summary>Notes</summary><p class="muted small">Jot down questions or observations as you read. Saved in this browser.</p><textarea id="notesbox" aria-label="Notes" placeholder="Your notes…"></textarea><button type="button" class="copy" id="notescopy">copy as prompt</button></details>`;
  add("refs", "Code references", ctx.refs.length ? `<section id="refs" class="refs"><h2>Code references</h2>${ctx.refs.join("")}</section>` : "");

  const pageId = createHash("sha1").update(`${lesson.title}|${provenance(lesson, cs)}`).digest("hex").slice(0, 12);
  const nDetail = steps.filter((x) => x.detail).length;
  const meta = `${tracked ? `${tracks.length} tracks · ` : ""}${steps.length} step${steps.length === 1 ? "" : "s"}${nDetail ? ` (${nDetail} detail)` : ""}${nq ? ` · ${nq} questions` : ""}${nTry ? ` · ${nTry} to try` : ""} · about ${minutes} min`;
  const toggle = nDetail ? `<label class="essentials-toggle"><input type="checkbox" id="essentials" checked> Essentials only</label>` : "";
  const header = `<header><p class="kicker">${stance === "memo" ? "Review memo" : "Explain this change"}</p><h1>${esc(lesson.title)}</h1><div class="lead">${leadHtml}</div>
    <p class="provenance">${esc(provenance(lesson, cs))}, explained ${esc(lesson.date ?? new Date().toISOString().slice(0, 10))}. ${esc(linked)}</p><p class="meta">${esc(meta)} ${toggle}</p>
    ${tracked ? `<nav class="tabbar" role="tablist">${toc.filter(([, , c]) => c.includes("tabref")).map(([id, t, c]) => `<a role="tab" class="tab-btn ${esc(c)}" href="#${esc(id)}" data-tab="${esc(id.replace(/^t-/, ""))}">${esc(t)}</a>`).join("")}</nav>` : ""}</header>`;
  const tocHtml = `<nav class="toc"><p class="toctitle">On this page</p><ol>${toc.map(([id, t, c]) => `<li class="${esc(c)}"><a href="#${id}">${esc(t)}</a></li>`).join("")}</ol><div class="progress"><div class="bar"></div></div></nav>`;
  const data = { pageId, title: lesson.title, provenance: provenance(lesson, cs), layout: tracked ? "tracks" : "page",
    quiz: across(lesson, "quiz").map(({ x: q, track }) => ({ id: q.id, track: track.implicit ? null : track.title, stem: plain(q.stem), options: (q.options ?? []).map((o) => ({ text: plain(o.text), correct: !!o.correct })) })) };
  const template = opts.template ?? readFileSync(join(HERE, "page.html"), "utf8");
  const mermaid = diagrams.some((d) => d.kind === "mermaid");
  return template
    .replace("{{TITLE}}", () => esc(lesson.title))
    .replace("{{LAYOUT}}", () => (tracked ? "tracks" : "page"))
    .replace("{{TOC}}", () => tocHtml)
    .replace("{{NOTES}}", () => notes)
    .replace("{{HEADER}}", () => header)
    .replace("{{SECTIONS}}", () => sec.join("\n"))
    .replace("{{DATA}}", () => JSON.stringify(data).replace(/</g, "\\u003c"))
    .replace("{{MERMAID}}", () => (mermaid ? `<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";mermaid.initialize({startOnLoad:true,theme:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"base"});</script>` : ""));
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { (out[key] = out[key] === undefined ? next : [].concat(out[key], next)); i++; }
    } else out._.push(a);
  }
  return out;
}
const list = (v) => (v === undefined ? [] : [].concat(v));

const USAGE = `usage:
  lesson.mjs collect [--hunk [--repo DIR | --session ID] | --git ["A...B" | "A..B" | "A B"] | --commit SHA | --staged | --patch FILE]
                     [--repo DIR] [--synthetic FILE]... [--out DIR]
  lesson.mjs check <lesson.json> [--changeset <changeset.json>]
  lesson.mjs render <lesson.json> [--changeset <changeset.json>] [--html FILE] [--sidecar FILE] [--guide FILE] [--comments FILE] [--no-links]
Exit status: 0 ok, 1 check failed, 2 usage or input error.`;

function main(argv) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  if (cmd === "collect") {
    let cs;
    const repoDir = a.repo && a.repo !== true ? a.repo : ".";
    if (a.hunk) cs = collectFromHunkReview(readHunkReview({ repo: a.repo === true ? "." : a.repo, session: a.session }));
    else if (a.commit && a.commit !== true) cs = collectFromGit(repoDir, ["--commit", String(a.commit)]);
    else if (a.staged) cs = collectFromGit(repoDir, ["--staged"]);
    else if (a.git !== undefined) cs = collectFromGit(repoDir, a.git === true ? [] : String(a.git).split(/\s+/).filter(Boolean));
    else if (list(a.patch).length) cs = collectFromPatch(list(a.patch)[0]);
    else if (list(a.synthetic).length) cs = collectFromPatch(list(a.synthetic)[0], { synthetic: true }); // experiment only
    else cs = collectFromGit(a.repo && a.repo !== true ? a.repo : ".", []);
    const primaryPatch = cs.source.kind === "patch" ? cs.source.patch : null;
    const extra = [...list(a.patch).filter((p) => resolve(p) !== primaryPatch).map((p) => collectFromPatch(p)),
      ...list(a.synthetic).filter((p) => resolve(p) !== primaryPatch).map((p) => collectFromPatch(p, { synthetic: true }))];
    if (extra.length) cs = mergeChangesets(cs, ...extra);
    const out = a.out && a.out !== true ? resolve(a.out) : mkdtempSync(join(tmpdir(), "explain-diff-"));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "changeset.json"), JSON.stringify(cs, null, 1));
    writeFileSync(join(out, "annotated.txt"), annotate(cs));
    const hunks = cs.files.reduce((n, f) => n + f.hunks.length, 0);
    console.log(JSON.stringify({ dir: out, changeset: join(out, "changeset.json"), annotated: join(out, "annotated.txt"), files: cs.files.length, hunks, source: cs.source }, null, 1));
    return 0;
  }
  if (cmd === "check" || cmd === "render") {
    const lessonPath = a._[0];
    if (!lessonPath) { console.error(USAGE); return 2; }
    const lesson = JSON.parse(readFileSync(lessonPath, "utf8"));
    // No changeset (an investigation with no diff): references resolve against files in the current repo.
    const cs = a.changeset && a.changeset !== true
      ? JSON.parse(readFileSync(a.changeset, "utf8"))
      : { version: 1, source: { kind: "none", repoRoot: tryGit(".", ["rev-parse", "--show-toplevel"]) || resolve("."), head: "WORKTREE" }, files: [] };
    const { errors, warnings } = checkLesson(lesson, cs);
    for (const w of warnings) console.log(`warn: ${w}`);
    for (const e of errors) console.log(`FAIL: ${e}`);
    if (errors.length) { console.log(`check: ${errors.length} error(s), ${warnings.length} warning(s)`); return 1; }
    const nTracks = Array.isArray(lesson.tracks) ? lesson.tracks.length : 0;
    console.log(`pass: ${nTracks ? `${nTracks} tracks, ` : ""}${across(lesson, "steps").length} steps, ${across(lesson, "quiz").length} questions, ${warnings.length} warning(s)`);
    if (cmd === "check") return 0;
    const written = {};
    if (a.html) { writeFileSync(a.html, renderHtml(lesson, cs, { blobBase: a["no-links"] ? null : undefined })); written.html = resolve(a.html); }
    if (a.sidecar) { writeFileSync(a.sidecar, JSON.stringify(toSidecar(lesson, cs), null, 1)); written.sidecar = resolve(a.sidecar); }
    if (a.guide) { writeFileSync(a.guide, JSON.stringify(toGuide(lesson), null, 1)); written.guide = resolve(a.guide); }
    if (a.comments) { writeFileSync(a.comments, JSON.stringify(toCommentBatch(lesson))); written.comments = resolve(a.comments); }
    console.log(JSON.stringify(written, null, 1));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; }
}
