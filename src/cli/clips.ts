// Clips: list, show, trim and set fields, caption fixes, the subtitle expert, the credit and the intro line.
import fs from 'node:fs';
import type { Command } from 'commander';
import { fmtTime, parseTime } from '../core/time';
import { type Action } from './shared';

export function register(program: Command, action: Action) {
  // ---------- clips ----------

  program
    .command('clips')
    .description('List clip projects')
    .action(
      action(async () => {
        const { listClips, loadProject } = await import('../project');
        const fs = await import('node:fs');
        const { paths } = await import('../core/paths');
        for (const id of listClips()) {
          const p = loadProject(id);
          const seg = p.segments[0];
          const exported = fs.existsSync(`${paths.exports}/${id}.mp4`) ? 'exported' : '';
          console.log(`${p.title}  (${id})  ${fmtTime(seg.startMs)}–${fmtTime(seg.endMs)}  ${String(p.markers.length).padStart(2)} markers  ${exported}`);
        }
      }),
    );

  program
    .command('show <clipId>')
    .description('Print a clip project as JSON')
    .action(
      action(async (clipId: string) => {
        const { loadProject } = await import('../project');
        console.log(JSON.stringify(loadProject(clipId), null, 2));
      }),
    );

  program
    .command('trim <clipId>')
    .description('Set the clip in/out points (source time; "+3" = 3 s after the current in-point)')
    .option('--in <time>')
    .option('--out <time>')
    .action(
      action(async (clipId: string, o: { in?: string; out?: string }) => {
        const { loadProject, saveProject } = await import('../project');
        const p = loadProject(clipId);
        const seg = p.segments[0];
        const inMs = o.in ? parseTime(o.in, seg.startMs) : seg.startMs;
        const outMs = o.out ? parseTime(o.out, seg.startMs) : seg.endMs;
        if (outMs - inMs < 1000) throw new Error('out must be at least 1 s after in');
        if (inMs < 0 || outMs > p.sourceDurationMs) throw new Error('outside the video');
        p.segments = [{ startMs: inMs, endMs: outMs }];
        saveProject(p);
        console.log(`${clipId}: ${fmtTime(inMs)}–${fmtTime(outMs)} (${((outMs - inMs) / 1000).toFixed(1)} s)`);
      }),
    );

  program
    .command('set <clipId> <assignments...>')
    .description('Change clip settings, e.g. `clip set X captions.style=boxed framing.mode=crop framing.cropX=0.4 title="New"`')
    .action(
      action(async (clipId: string, assignments: string[]) => {
        const { loadProject, saveProject } = await import('../project');
        const p = loadProject(clipId) as unknown as Record<string, unknown>;
        for (const a of assignments) {
          const i = a.indexOf('=');
          if (i < 1) throw new Error(`Expected key=value, got "${a}"`);
          const keys = a.slice(0, i).split('.');
          if (!['title', 'captions', 'framing'].includes(keys[0])) throw new Error(`Only title, captions.* and framing.* can be set here`);
          let v: unknown = a.slice(i + 1);
          try {
            v = JSON.parse(v as string);
          } catch {}
          let obj = p;
          for (const k of keys.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
          obj[keys[keys.length - 1]] = v;
        }
        saveProject(p as never); // schema-validated
        console.log('saved');
      }),
    );

  program
    .command('caption-fix <clipId> <word> <text>')
    .description('Correct a caption word by its index (#123) or time (14:50.2). Use "" to hide the word.')
    .action(
      action(async (clipId: string, word: string, text: string) => {
        const { loadProject, saveProject } = await import('../project');
        const { loadTranscript } = await import('../ingest/ingest');
        const p = loadProject(clipId);
        let idx: number;
        if (/^#?\d+$/.test(word) && !word.includes(':')) idx = Number(word.replace('#', ''));
        else {
          const ms = parseTime(word);
          const w = loadTranscript(p.videoId).words.reduce((a, b) => (Math.abs(b.startMs - ms) < Math.abs(a.startMs - ms) ? b : a));
          idx = w.i;
        }
        const w = loadTranscript(p.videoId).words[idx];
        if (!w) throw new Error(`No word #${idx}`);
        p.captions.fixes[String(idx)] = text;
        saveProject(p);
        console.log(`#${idx} at ${fmtTime(w.startMs)}: "${w.text}" → "${text}"`);
      }),
    );

  program
    .command('subtitles <clipId>')
    .description('Subtitle expert: whether captions belong, the right style/position, and word-level fixes; applies them by default')
    .option('--review', 'only review; do not change the clip')
    .option('--force', 'overwrite existing word fixes')
    .option('--no-settings', 'word fixes only: leave the caption look and on/off as they are (after a decision made from the frames)')
    .option('--enable', 'allow turning captions back on when they are off')
    .option('--json', 'print the full review as JSON')
    .action(
      action(async (clipId: string, o: { review?: boolean; force?: boolean; settings: boolean; enable?: boolean; json?: boolean }) => {
        const { reviewSubtitles, applySubtitleFixes } = await import('../edit/subtitles');
        const applied = o.review ? undefined : await applySubtitleFixes(clipId, { force: !!o.force, settings: o.settings, enable: !!o.enable });
        const r = applied?.review ?? (await reviewSubtitles(clipId));
        if (o.json) {
          console.log(JSON.stringify(applied ? { ...r, applied: applied.applied, changed: applied.changed, kept: applied.kept } : r, null, 2));
          return;
        }
        const d = r.decision;
        console.log(
          `engine says: captions ${d.enabled ? 'ON' : 'OFF'} · ${d.style} · y ${d.position.toFixed(2)} · ${d.uppercase ? 'uppercase' : 'sentence case'} · ${d.fontSize}px`,
        );
        console.log(`  ${d.why}`);
        for (const risk of d.risks) console.log(`  risk: ${risk}`);
        console.log(`${r.score}/100 · ${r.verdict} · ${r.stats.words} words · ${r.stats.hidden} hidden · ${r.issues.length} notes on words`);
        for (const i of r.issues.slice(0, 20)) {
          console.log(`  #${i.wordIndex} ${fmtTime(i.startMs)}  "${i.text}" → ${i.fix === '' ? '(hide)' : `"${i.fix}"`}  [${i.kind}] ${i.why}`);
        }
        if (applied) {
          console.log(`applied ${applied.applied} word fix${applied.applied === 1 ? '' : 'es'}${applied.changed.length ? `; changed ${applied.changed.join(', ')}` : '; caption settings unchanged'}`);
          for (const k of applied.kept) console.log(`  kept: ${k}`);
        }
      }),
    );

  // ---------- markers ----------

  program
    .command('credit <clipId>')
    .description('Name the creator on screen for the whole clip. New clips have it already; this adds it to an older clip, changes what it says, or takes it off')
    .option('--text <text>', 'what it says (default: twitch.tv/<login>, or youtube.com/@<channel>)')
    .option('--label <label>', 'the platform badge before it (default: ▶ YouTube / 🎮 Twitch)')
    .option('--remove', 'take the credit off this clip (QA then fails the export, unless channel.json turns the credit off)')
    .action(
      action(async (clipId: string, o: { text?: string; label?: string; remove?: boolean }) => {
        const { setCredit, CREDIT } = await import('../project');
        const p = await setCredit(clipId, o);
        const m = p.markers.find((x) => x.type === CREDIT);
        console.log(m ? `credit on ${clipId}: ${String(m.params.label ?? '🎥')} ${String(m.params.text)}` : `no credit on ${clipId}`);
      }),
    );

  program
    .command('intro <clipId>')
    .description('Show or set the short premise line that sits in the hook text (4–8 words, explains the clip)')
    .option('--text <text>', 'the line; omit to print the current one')
    .action(
      action(async (clipId: string, o: { text?: string }) => {
        const { setIntro } = await import('../edit/hook');
        const r = await setIntro(clipId, o);
        const text = r.current ?? (r.marker ? String((r.marker.params as Record<string, unknown>).text) : undefined);
        console.log(text ? `intro on ${clipId}: ${text}` : `no intro on ${clipId}`);
      }),
    );
}
