// Tests for lesson.mjs. Run: node --test tests/test_lesson.mjs   (needs git; builds a fixture repo in a temp dir)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  annotate, checkLesson, collectFromGit, containingHunk, md, parsePatch, plain, renderHtml, toCommentBatch, toGuide, toSidecar,
} from "../scripts/lesson.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const repo = join(mkdtempSync(join(tmpdir(), "ed-test-")), "retry");
execFileSync(join(HERE, "make_fixture.sh"), [repo]);
const cs = collectFromGit(repo, []);
const good = JSON.parse(readFileSync(join(HERE, "fixtures/retry/lesson.json"), "utf8"));
const clone = () => structuredClone(good);
const fails = (lesson, re) => {
  const { errors } = checkLesson(lesson, cs);
  assert.ok(errors.some((e) => re.test(e)), `expected an error matching ${re}, got:\n${errors.join("\n") || "(none)"}`);
};

test("parsePatch: added, deleted, renamed, binary, no-newline, and content that looks like a header", () => {
  const text = [
    "diff --git a/new.txt b/new.txt", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/new.txt",
    "@@ -0,0 +1,2 @@", "+--- not a header", "+second", "\\ No newline at end of file",
    "diff --git a/old.txt b/old.txt", "deleted file mode 100644", "--- a/old.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone",
    "diff --git a/a.py b/b.py", "similarity index 90%", "rename from a.py", "rename to b.py", "--- a/a.py", "+++ b/b.py",
    "@@ -1,2 +1,2 @@", " keep", "-x = 1", "+x = 2",
    "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ", "",
  ].join("\n");
  const [n, d, r, b] = parsePatch(text);
  assert.deepEqual([n.path, n.status, n.additions, n.hunks[0].lines[0].s], ["new.txt", "added", 2, "--- not a header"]);
  assert.deepEqual([d.path, d.status, d.deletions], ["old.txt", "deleted", 1]);
  assert.deepEqual([r.path, r.oldPath, r.status], ["b.py", "a.py", "renamed"]);
  assert.deepEqual([b.path, b.binary], ["img.png", true]);
  assert.equal(r.hunks[0].header, "@@ -1,2 +1,2 @@");
});

test("collectFromGit: working tree fixture, line numbers, annotated view", () => {
  assert.deepEqual(cs.files.map((f) => f.path), ["configs/train.yaml", "src/fetch.py"]);
  assert.equal(cs.source.head, "WORKTREE");
  const f = cs.files[1];
  assert.ok(containingHunk(f, "new", 6, 14));
  assert.equal(containingHunk(f, "new", 15, 15), null);
  assert.match(annotate(cs), /F2H1 @@ -1,6 \+1,14 @@\s+new 1-14 \| old 1-6/);
});

test("checkLesson: the fixture lesson passes cleanly", () => {
  const { errors, warnings } = checkLesson(good, cs);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("checkLesson: anchors must sit inside one hunk and highlights must exist", () => {
  const a = clone(); a.steps[0].targets[0] = { path: "src/fetch.py", side: "new", start: 20, end: 22 }; fails(a, /not inside one changed hunk/);
  const b = clone(); b.steps[0].targets[0].highlight = "NotThere"; fails(b, /does not occur/);
  const c = clone(); c.steps[0].targets[0].path = "src/missing.py"; fails(c, /not in the changeset/);
  const d = clone(); d.background.narrow = "See [[src/fetch.py:90-99]]."; fails(d, /past the end of the file/);
});

test("checkLesson: ids, intents, coverage", () => {
  const a = clone(); a.steps[1].id = a.steps[0].id; fails(a, /also used at/);
  const b = clone(); b.steps[0].intents = ["nope"]; fails(b, /unknown intent "nope"/);
  const c = clone(); c.steps.pop(); c.unasked = []; fails(c, /coverage: configs\/train.yaml/);
  const d = clone(); d.steps.pop(); d.unasked = []; d.skipped = [{ path: "configs/train.yaml", reason: "unrelated config" }];
  assert.deepEqual(checkLesson(d, cs).errors, []);
});

test("checkLesson: quiz rules", () => {
  const a = clone(); a.quiz[0].options[0].text = "All of the above"; fails(a, /names another option by position/);
  const b = clone(); b.quiz[0].options.forEach((o) => delete o.correct); fails(b, /exactly one option/);
  const c = clone(); const k = c.quiz[0].options.findIndex((o) => o.correct);
  c.quiz[0].options[k].text = "0.3 seconds, because two failures each sleep before the successful third attempt returns";
  fails(c, /longest is over 1.5x/);
  const d = clone(); d.quiz = d.quiz.slice(0, 2); fails(d, /a lesson needs 3 to 5/);
});

test("checkLesson: try-it safety", () => {
  const a = clone(); a.tryIt[0].command = "sbatch run.sh"; fails(a, /submits a job/);
  const b = clone(); b.tryIt[0].command = "sbatch run.sh"; b.tryIt[0].launches = true;
  assert.deepEqual(checkLesson(b, cs).errors, []);
  const c = clone(); c.tryIt[0].command = "git push origin HEAD"; fails(c, /destroys or publishes/);
  const d = clone(); d.tryIt[0].command = "slurm.py -sN 1 -- python scripts/train.py"; fails(d, /submits a job/);
});

test("renderHtml: escapes code and prose, renders sections and references", () => {
  const a = clone();
  a.tldr = "Handles <script>alert(1)</script> & [[src/fetch.py:3]] safely.";
  const html = renderHtml(a, cs, { blobBase: null });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script from prose must be escaped");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  for (const id of ["picture", "intent", "background", "intuition", "walkthrough", "quiz", "tryit", "unknown", "connections", "refs"])
    assert.ok(html.includes(`<section id="${id}"`), `section ${id}`);
  assert.match(html, /<a class="ref" href="#ref-1"><code>src\/fetch.py:3<\/code><\/a>/);
  assert.match(html, /<mark>\(TimeoutError, ConnectionError\)<\/mark>/);
  assert.ok(!html.includes("mermaid.esm"), "no Mermaid loader without a mermaid diagram");
  assert.ok(!/\{\{[A-Z]+\}\}/.test(html), "every template slot filled");
  const m = clone(); m.diagrams.push({ id: "d-m", kind: "mermaid", caption: "c", source: "flowchart TD\n A[\"a<br/>b\"] -->|x| B" });
  assert.ok(renderHtml(m, cs, { blobBase: null }).includes("mermaid.esm"));
});

test("renderHtml: diff excerpts include the replaced lines", () => {
  const html = renderHtml(good, cs, { blobBase: null });
  const step2 = html.slice(html.indexOf('id="s-loop"'), html.indexOf('id="s-backoff"'));
  assert.ok(step2.includes("def fetch_user(client, user_id):"), "old signature shown next to the new loop");
});

test("toSidecar / toGuide / toCommentBatch follow the story and the changeset", () => {
  const sc = toSidecar(good, cs);
  assert.deepEqual(sc.files.map((f) => f.path), ["src/fetch.py", "configs/train.yaml"]);
  assert.deepEqual(sc.files[0].annotations[0].newRange, [3, 3]);
  assert.match(sc.files[0].annotations[0].summary, /^1\. Name the errors/);
  const g = toGuide(good);
  assert.equal(g.sections.length, good.steps.length);
  for (const s of g.sections) for (const t of s.targets) assert.ok(containingHunk(cs.files.find((f) => f.path === t.path), t.side, t.startLine, t.endLine));
  const cb = toCommentBatch(good);
  assert.deepEqual(Object.keys(cb.comments[0]).sort(), ["author", "filePath", "newLine", "rationale", "summary"]);
});

test("memo stance: findings, status, decisions, and the proposed change", () => {
  const memo = {
    version: 1, stance: "memo", title: "Why fetch_user flaked in CI", tldr: "Network timeouts, not bad data.",
    findings: [{ claim: "Every failure is a `TimeoutError`.", evidence: "Seen at [[src/fetch.py:9]] in the new code path." }],
    status: { works: ["Retry survives two timeouts."], broken: [], unknown: ["Real client exception types."] },
    decisions: [{ question: "Ship the retry?", options: [{ label: "Ship", meaning: "merge now" }, { label: "Wait", meaning: "check client" }], recommend: { option: "Ship", why: "bounded and safe" } }],
    steps: [good.steps[1]], intents: good.intents, skipped: [{ path: "configs/train.yaml", reason: "not part of the fix" }],
  };
  const { errors } = checkLesson(memo, cs);
  assert.deepEqual(errors, []);
  const html = renderHtml(memo, cs, { blobBase: null });
  for (const id of ["findings", "status", "decisions", "change"]) assert.ok(html.includes(`<section id="${id}"`), id);
  assert.ok(html.includes("Review memo"));
});

test("md and plain: the markdown subset", () => {
  assert.equal(md("a **b** *c* `d<e>`"), "<p>a <strong>b</strong> <em>c</em> <code>d&lt;e&gt;</code></p>");
  assert.equal(md("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(md("[x](javascript:alert(1))"), "<p>x</p>", "unsafe link scheme dropped");
  assert.equal(plain("see [[a.py:1-2]] and **b**"), "see a.py:1-2 and b");
});

test("CLI collect --commit diffs exactly one commit (regression: a quoted --git \"--commit X\" fell back to the working tree)", () => {
  const r2 = join(mkdtempSync(join(tmpdir(), "ed-cli-")), "two");
  execFileSync(join(HERE, "make_fixture.sh"), [r2]);
  execFileSync("git", ["-C", r2, "commit", "-qam", "retry"]);
  execFileSync("sh", ["-c", "echo untracked > stray.txt"], { cwd: r2 });
  const out = JSON.parse(execFileSync("node", [join(HERE, "../scripts/lesson.mjs"), "collect", "--commit", "HEAD", "--repo", r2, "--out", join(r2, "..", "w")], { encoding: "utf8" }));
  assert.equal(out.files, 2, "the commit's two files, not the working tree's untracked file");
  assert.equal(out.source.head.length, 40);
});

test("emphasis never fires inside code or on spaced asterisks (regression: `0.1 * 1` lost its asterisks)", () => {
  assert.equal(plain("It sleeps `0.1 * 1` then `0.1 * 2`."), "It sleeps 0.1 * 1 then 0.1 * 2.");
  assert.equal(plain("waits 0.1 * attempt and 2 * x"), "waits 0.1 * attempt and 2 * x");
  assert.equal(md("waits 0.1 * attempt and 2 * x"), "<p>waits 0.1 * attempt and 2 * x</p>");
  assert.equal(md("a *real* emphasis and **bold**"), "<p>a <em>real</em> emphasis and <strong>bold</strong></p>");
  assert.equal(plain("a *real* one"), "a real one");
});

// ---- tracks: parallel, tabbed walkthroughs
const tracked = () => {
  const l = clone();
  const byId = Object.fromEntries(l.steps.map((s) => [s.id, s]));
  l.tracks = [
    { id: "t-retry", title: "Retry behaviour", priority: "focus", question: "When does fetch_user retry, and when does it give up?",
      why: "This is the behaviour CI depends on.", summary: "Two error types retry, up to three attempts, with growing sleeps.",
      steps: [byId["s-transient"], byId["s-loop"], { ...byId["s-backoff"], detail: true }], quiz: l.quiz, tryIt: l.tryIt, unknowns: l.unknowns },
    { id: "t-config", title: "Config", priority: "context", question: "What else changed in configs?", summary: "Warmup doubles.",
      steps: [byId["s-warmup"]] },
  ];
  for (const k of ["steps", "quiz", "tryIt", "unknowns"]) delete l[k];
  return l;
};

test("tracks: a tracked lesson passes and renders tabs, track cards, and unique ids", () => {
  const l = tracked();
  assert.deepEqual(checkLesson(l, cs).errors, []);
  const html = renderHtml(l, cs, { blobBase: null });
  assert.match(html, /<nav class="tabbar" role="tablist">/);
  assert.match(html, /<section class="tab" id="t-overview"/);
  assert.match(html, /<section class="tab track" id="t-t-retry"/);
  assert.match(html, /class="trackcard p-context"/);
  assert.match(html, /id="essentials"/, "Essentials toggle appears when a step is detail");
  assert.match(html, /<article class="stepcard k-change detail" id="s-backoff">/);
  assert.match(html, /<body data-layout="tracks">/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(dupes, [], `duplicate element ids: ${dupes.join(", ")}`);
  assert.match(html, /id="quiz-t-retry" class="quiz"/);
});

test("Notes live below the ToC, outside the reading content, in both layouts", () => {
  for (const l of [clone(), tracked()]) {
    const html = renderHtml(l, cs, { blobBase: null });
    assert.match(html, /<aside class="sidebar">\s*<nav class="toc">[\s\S]*?<\/nav>\s*<details id="notes" open>[\s\S]*?<\/details>\s*<\/aside>\s*<main>/);
    assert.match(html, /<textarea id="notesbox" aria-label="Notes"/);
    assert.equal([...html.matchAll(/id="notesbox"/g)].length, 1);
    assert.ok(!html.includes("Ask back"));
    assert.ok(!html.includes('href="#notes"'), "notes are not a reading-progress section");
  }
});

test("tracks: the checker enforces questions, placement, and focus budgets", () => {
  const a = tracked(); delete a.tracks[0].question; fails(a, /tracks\[0\]\.question/);
  const b = tracked(); b.steps = []; fails(b, /with tracks, move top-level steps into a track/);
  const c = tracked(); c.tracks.reverse();
  assert.ok(checkLesson(c, cs).warnings.some((w) => /first track is "context"/.test(w)));
  const d = tracked(); d.tracks[0].steps = [...d.tracks[0].steps, ...[0, 1, 0].map((k, i) => ({ ...d.tracks[0].steps[k], id: `dup${i}` }))]; // 2 core + 3 copies = 5 core
  assert.ok(checkLesson(d, cs).warnings.some((w) => /core steps; keep 4 or fewer/.test(w)));
  const e = clone(); e.steps = [...e.steps, ...Array.from({ length: 4 }, (_, i) => ({ ...e.steps[0], id: `extra${i}` }))];
  assert.ok(checkLesson(e, cs).warnings.some((w) => /split them into tracks/.test(w)), "a long single walkthrough is told to use tracks");
});

test("tracks: Hunk outputs keep track order and label steps with their track", () => {
  const l = tracked();
  const g = toGuide(l);
  assert.deepEqual(g.sections.map((x) => x.title).slice(0, 2), ["Retry behaviour: Name the errors worth retrying", "Retry behaviour: Wrap the call in a bounded loop"]);
  assert.equal(g.sections.find((x) => x.id === "s-backoff").kind, "supporting", "detail steps hide in hunk-guide by default");
  const sc = toSidecar(l, cs);
  assert.match(sc.files[0].annotations[0].summary, /^Retry behaviour · 1\. /);
  assert.match(toCommentBatch(l).comments.at(-1).summary, /^Config · 1\. /);
});
