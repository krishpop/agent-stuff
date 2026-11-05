// Wrap a pi extension's API so every hook and its duration is logged as JSONL.
// Costs nothing when PI_PERF is unset, so it can stay wired in permanently.
//
//   import { probe } from "<...>/debug/hookprobe.js";
//   export default function activate(rawPi) {
//     const pi = probe(rawPi, "my-extension");
//     ...
//
//   PI_PERF=1 pi
//   jq -s 'group_by(.ext+"|"+.event)
//          | map({k:(.[0].ext+" "+.[0].event), n:length,
//                 total:(map(.ms)|add|floor), max:(map(.ms)|max)})
//          | sort_by(-.total)' ~/.pi/agent/perf.jsonl | head -40
//   jq -c 'select(.kind=="sync" and .ms>16)' ~/.pi/agent/perf.jsonl | tail -50
//
// Budget: any SYNC hook over 16 ms drops a frame. Anything on message_update /
// tool_execution_update over 1 ms is a bug -- those fire per streaming chunk.
import fs from "node:fs";
import path from "node:path";

const LOG = process.env.PI_PERF_LOG ?? path.join(process.env.HOME!, ".pi/agent/perf.jsonl");
const SLOW_MS = Number(process.env.PI_PERF_SLOW_MS ?? 1);
const enabled = process.env.PI_PERF === "1";

export function probe<T extends { on: (event: string, handler: (...a: never[]) => unknown) => unknown }>(
  pi: T,
  ext: string,
): T {
  if (!enabled) return pi;
  const sink = fs.createWriteStream(LOG, { flags: "a" });
  const write = (rec: object) =>
    sink.write(JSON.stringify({ t: Date.now(), pid: process.pid, ext, ...rec }) + "\n");
  const origOn = pi.on.bind(pi);
  (pi as { on: unknown }).on = (event: string, handler: (...a: unknown[]) => unknown) =>
    origOn(event, ((...args: unknown[]) => {
      const t0 = performance.now();
      let sync = true;
      try {
        const r = handler(...args);
        if (r && typeof (r as PromiseLike<unknown>).then === "function") {
          sync = false;
          return (r as Promise<unknown>).finally(() => {
            const ms = performance.now() - t0;
            if (ms >= SLOW_MS) write({ event, ms: +ms.toFixed(2), kind: "async" });
          });
        }
        return r;
      } finally {
        if (sync) {
          // Sync time is what actually freezes the TUI. Flag it harder.
          const ms = performance.now() - t0;
          if (ms >= SLOW_MS) write({ event, ms: +ms.toFixed(2), kind: "sync" });
        }
      }
    }) as never);
  return pi;
}
