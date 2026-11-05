// Event-loop lag canary. Load alongside any candidate extension with -e.
// Measures how long the main thread is blocked -- i.e. how much the TUI "hangs".
// Writes JSONL to $PI_LAG_LOG (default /tmp/extperf/lag.jsonl).
import fs from "node:fs";

const LOG = process.env.PI_LAG_LOG ?? "/tmp/extperf/lag.jsonl";
const TAG = process.env.PI_LAG_TAG ?? "unknown";
const PERIOD = 100;

export default function activate(pi: any) {
  try {
    fs.mkdirSync(LOG.replace(/\/[^/]*$/, ""), { recursive: true });
  } catch {}

  const samples: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - PERIOD;
    last = now;
    if (lag > 0) samples.push(lag);
  }, PERIOD);
  timer.unref?.();

  const dump = (phase: string) => {
    if (samples.length === 0) return;
    const s = [...samples].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    const rec = {
      tag: TAG,
      phase,
      n: s.length,
      // total main-thread time lost to blocking, in ms
      blocked_total: Math.round(s.reduce((a, b) => a + b, 0)),
      p50: +q(0.5).toFixed(1),
      p95: +q(0.95).toFixed(1),
      max: +s[s.length - 1].toFixed(1),
      // count of stalls a human would notice
      over_100ms: s.filter((x) => x > 100).length,
      over_1s: s.filter((x) => x > 1000).length,
    };
    try {
      fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
    } catch {}
  };

  pi.on("session_shutdown", () => dump("shutdown"));
  process.on("exit", () => dump("exit"));
}
