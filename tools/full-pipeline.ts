#!/usr/bin/env tsx
// Run the full manual pipeline automatically for one range:
//   npx tsx tools/full-pipeline.ts <videoId> --from 0:00 --to 0:30 --creator "Name"
//
// Stages: queue-check (three experts + coordinator) -> extractor -> curator -> edit.
// The watchlist calls runFullPipeline directly; this wrapper is for testing and manual runs.
import { runFullPipeline } from '../src/pipeline/full';
import { parseTime, fmtTime } from '../src/core/time';
import { loadMeta } from '../src/ingest/ingest';

const args = process.argv.slice(2);
const id = args[0];
const opt = (f: string, d?: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
if (!id) {
  console.log('usage: full-pipeline.ts <videoId> [--from 0:00] [--to 0:30] [--creator Name] [--max 3]');
  process.exit(2);
}
const meta = loadMeta(id);
const fromMs = opt('--from') ? parseTime(opt('--from')!) : 0;
const toMs = opt('--to') ? parseTime(opt('--to')!) : meta.durationMs;
const creator = opt('--creator', meta.channel ?? id) ?? id;
const maxKeep = Number(opt('--max', '3'));
console.log(`${id} ${fmtTime(fromMs, 0)}–${fmtTime(toMs, 0)} · ${creator}`);
const r = await runFullPipeline({ videoId: id, fromMs, toMs, creator, maxKeep, log: (s) => console.log(`  ${s}`) });
console.log(r.note);
