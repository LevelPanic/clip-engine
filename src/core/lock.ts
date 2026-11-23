// One writer at a time for a video's growing files (transcript.json, chat.json).
//
// A stream's transcript and chat are filled in window by window, by whoever needs a window: a scan
// pass, a watcher, `clip transcript`, `clip chat`, or three queue experts reading the same segment at
// once. Each of those reads the file, adds its window and writes it back, so two at the same time can
// lose a window (and both pay for the same Whisper run). The lock makes the second one wait, then
// find the work already done.
import fs from 'node:fs';
import { paths } from './paths';

/** Locks this process holds right now (two tasks in one process must take turns too). */
const held = new Set<string>();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Run `fn` holding library/<id>/<name>.lock; waits for another process, clears a dead one's lock. */
export async function withVideoLock<T>(videoId: string, name: string, fn: () => Promise<T>, waitMs = 15 * 60_000): Promise<T> {
  const file = paths.videoFile(videoId, `${name}.lock`);
  fs.mkdirSync(paths.video(videoId), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); // fails if it exists: atomic
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(file, 'utf8').trim());
      } catch {
        continue; // released between our two calls
      }
      const ours = pid === process.pid && held.has(file);
      if (!ours && (!pid || pid === process.pid || !alive(pid))) {
        fs.rmSync(file, { force: true }); // left behind by a process that died
        continue;
      }
      if (Date.now() - t0 > waitMs) throw new Error(`${videoId}: ${name} is busy (process ${pid} has held it for over ${Math.round(waitMs / 60_000)} min)`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  held.add(file);
  try {
    return await fn();
  } finally {
    held.delete(file);
    fs.rmSync(file, { force: true });
  }
}
