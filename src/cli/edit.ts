// Editing: dead-air cuts, autoedit, the editors, censoring, post text, duplicate and delete, styles, reframe and split, accepting proposals, presets.
import fs from 'node:fs';
import type { Command } from 'commander';
import { fmtTime, parseTime } from '../core/time';
import type { EditorMode } from '../edit/editors';
import { STUDIO, type Action } from './shared';

export function register(program: Command, action: Action) {
  program
    .command('suggest-cuts <clipId>')
    .description('Propose jump cuts on dead air (pauses between words); accept them in the Studio or with `clip accept`')
    .option('--min-gap <ms>', 'shortest pause to cut', '700')
    .option('--keep <ms>', 'breath kept at each side', '120')
    .action(
      action(async (clipId: string, o: { minGap: string; keep: string }) => {
        const { loadProject, saveProject } = await import('../project');
        const { suggestSilenceCuts } = await import('../edit/suggest');
        const p = loadProject(clipId);
        const cuts = await suggestSilenceCuts(p, { minGapMs: Number(o.minGap), keepMs: Number(o.keep) });
        p.markers = [...p.markers, ...cuts].sort((a, b) => a.startMs - b.startMs);
        saveProject(p);
        const saved = cuts.reduce((a, c) => a + (c.endMs! - c.startMs), 0);
        console.log(`proposed ${cuts.length} cuts, removing ${(saved / 1000).toFixed(1)} s of dead air`);
      }),
    );

  program
    .command('autoedit <clipIds...>')
    .description('First-pass edit as proposed markers: hook text, punchline zoom/boom/flash, dead-air cuts, caption fixes')
    .option('--accept', 'add the edits as accepted, not proposed')
    .option('--reframe', 'also track faces and switch to crop framing')
    .option('--no-cuts', "don't propose dead-air cuts")
    .option('--preset <name>', 'apply this preset first')
    .option('--style <name>', 'clean | punch | hype | story (default punch); `clip styles` lists them')
    .action(
      action(async (clipIds: string[], o: { accept?: boolean; reframe?: boolean; cuts: boolean; preset?: string; style?: string }) => {
        const { autoEdit, printAutoEdit } = await import('../edit/autoedit');
        for (const id of clipIds) printAutoEdit(await autoEdit(id, { accept: !!o.accept, reframe: !!o.reframe, cuts: o.cuts ? undefined : false, preset: o.preset, style: o.style }));
      }),
    );

  program
    .command('editors <clipId>')
    .description('Meme and expert editors review a clip and add their edits to it as proposed markers (captions and the review note are left alone)')
    .option('--meme', 'meme editor only')
    .option('--expert', 'expert editor only')
    .option('--review', 'only review; do not add the suggestions to the clip')
    .option('--accept', 'add them accepted, not proposed')
    .option('--json', 'print the full reviews as JSON')
    .action(
      action(async (clipId: string, o: { meme?: boolean; expert?: boolean; review?: boolean; accept?: boolean; json?: boolean }) => {
        const { reviewClip, applyEditorSuggestions } = await import('../edit/editors');
        const modes: EditorMode[] = o.meme && !o.expert ? ['meme'] : o.expert && !o.meme ? ['expert'] : ['meme', 'expert'];
        const reviews = [];
        for (const mode of modes) {
          if (!o.review) {
            const { review, added, skipped } = await applyEditorSuggestions(clipId, mode, { accept: !!o.accept });
            reviews.push(review);
            if (!o.json) console.log(`${mode}  added ${added} ${o.accept ? 'accepted' : 'proposed'} marker${added === 1 ? '' : 's'} to the clip${skipped ? ` (${skipped} skipped: an edit is already there)` : ''}`);
          } else reviews.push(await reviewClip(clipId, mode));
        }
        if (o.json) {
          console.log(JSON.stringify(reviews, null, 2));
          return;
        }
        for (const r of reviews) {
          console.log(`${r.mode.padEnd(6)} fit ${String(r.score).padStart(3)}/100  ${r.summary}`);
          for (const s of r.suggestions) {
            const at = fmtTime(s.startMs);
            const span = s.endMs !== undefined ? `–${fmtTime(s.endMs)}` : '';
            console.log(`  + ${s.type.padEnd(7)} ${at}${span}  ${s.why}`);
          }
          for (const n of r.notes) console.log(`  → ${n}`);
          if (r.risks.length) console.log(`  risks: ${r.risks.join('; ')}`);
        }
      }),
    );

  program
    .command('censor <clipIds...>')
    .description('Bleep what the clip says that must not be heard: every slur, and the f-words in its first 3 s (--swears all: every strong swear). Captions mask the text by themselves; render again after')
    .option('--swears <scope>', 'open (the f-words in the first 3 s), all (every strong swear) or none (slurs only)', 'open')
    .option('--mute', 'silence only, no bleep tone')
    .option('--propose', 'add the bleeps as proposed markers for the reviewer to accept')
    .option('--review', 'only say what it would bleep')
    .option('--json')
    .action(
      action(async (clipIds: string[], o: { swears: string; mute?: boolean; propose?: boolean; review?: boolean; json?: boolean }) => {
        const { censorClip } = await import('../edit/censor');
        const { maskSwearing } = await import('../core/risk');
        if (!['open', 'all', 'none'].includes(o.swears)) throw new Error('--swears is open, all or none');
        const out = [];
        for (const id of clipIds) {
          const r = await censorClip(id, { swears: o.swears as 'open' | 'all' | 'none', sound: o.mute ? 'mute' : 'tone', propose: !!o.propose, review: !!o.review });
          out.push(r);
          if (o.json) continue;
          const words = r.hits.map((h) => `"${maskSwearing(h.word)}" at ${fmtTime(h.atMs, 1)} (${h.why})`).join(', ');
          const verb = o.review ? 'would bleep' : o.propose ? 'proposed bleeps over' : 'bleeped';
          console.log(r.hits.length ? `${id}: ${verb} ${r.hits.length} word${r.hits.length === 1 ? '' : 's'} in ${r.spans.length} span${r.spans.length === 1 ? '' : 's'}: ${words}` : `${id}: nothing to bleep`);
          if (r.replaced && !o.review) console.log(`  replaced ${r.replaced} bleep${r.replaced === 1 ? '' : 's'} from the last pass`);
          if (r.saved && !o.review && !o.propose) console.log(`  render again for the export to have it: ./clip render ${id}`);
        }
        if (o.json) console.log(JSON.stringify(out, null, 2));
      }),
    );

  program
    .command('post <clipId>')
    .description('Show the post text (title, caption, hashtags); set any part with the options ("" goes back to the suggestion)')
    .option('--title <text>')
    .option('--caption <text>')
    .option('--hashtags <text>')
    .action(
      action(async (clipId: string, o: { title?: string; caption?: string; hashtags?: string }) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { loadProject, saveProject, suggestedPost } = await import('../project');
        const { postFor, postFile } = await import('../core/post');
        const { paths } = await import('../core/paths');
        let p = loadProject(clipId);
        if (o.title !== undefined || o.caption !== undefined || o.hashtags !== undefined) {
          const next = { ...p.post };
          for (const k of ['title', 'caption', 'hashtags'] as const) if (o[k] !== undefined) next[k] = o[k]!.trim() || undefined;
          p = saveProject({ ...p, post: Object.values(next).some(Boolean) ? next : undefined });
        }
        const suggestion = suggestedPost(p);
        if (suggestion.titles?.length) console.log(`title options:\n${suggestion.titles.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}\n`);
        const text = postFile(postFor(p.post, suggestion));
        if (fs.existsSync(path.join(paths.exports, `${clipId}.mp4`))) fs.writeFileSync(path.join(paths.exports, `${clipId}.txt`), text);
        console.log(text);
      }),
    );

  program
    .command('duplicate <clipId>')
    .description('Copy a clip (…-v2) to try a different edit; review state and exports are not copied')
    .action(
      action(async (clipId: string) => {
        const { duplicateClip } = await import('../candidates');
        const id = duplicateClip(clipId);
        console.log(`${id}  ${STUDIO}/#/clip/${id}`);
      }),
    );

  program
    .command('delete <clipId>')
    .description('Delete a clip: project and exports move to clips/.trash/, and its candidate can be made again')
    .action(
      action(async (clipId: string) => {
        const { deleteClip } = await import('../candidates');
        console.log(`moved to ${deleteClip(clipId).trash}`);
      }),
    );

  program
    .command('styles')
    .description('List the edit styles autoedit can apply')
    .action(
      action(async () => {
        const { STYLES } = await import('../edit/styles');
        for (const st of STYLES) console.log(`${st.key.padEnd(7)} ${st.label}: ${st.description}`);
      }),
    );

  program
    .command('reframe <clipId>')
    .description('Track faces and propose reframe markers so the 9:16 crop follows the speaker, for the whole clip or --from/--to a range')
    .option('--accept', 'add them as accepted, not proposed')
    .option('--from <time>', 'only this range (source time, or +s after the in-point)')
    .option('--to <time>', 'end of the range')
    .action(
      action(async (clipId: string, o: { accept?: boolean; from?: string; to?: string }) => {
        const { autoReframe } = await import('../reframe/apply');
        const { loadProject } = await import('../project');
        const inMs = loadProject(clipId).segments[0].startMs;
        const range = o.from || o.to ? { startMs: o.from ? parseTime(o.from, inMs) : inMs, endMs: o.to ? parseTime(o.to, inMs) : Infinity } : undefined;
        const r = await autoReframe(clipId, { accept: !!o.accept, range, log: console.log });
        if ('split' in r && r.split) console.log('using the split facecam/gameplay layout');
        else console.log(`${o.accept ? 'added' : 'proposed'} ${r.keyframes} reframe keyframes (${r.cuts} cuts); faces in ${r.faces}/${r.samples} samples`);
      }),
    );

  program
    .command('split <clipId>')
    .description('Find the facecam and switch the clip to the split layout: facecam on top, gameplay below')
    .option('--detector <name>', 'hybrid (default), insightface or vision', process.env.CLIP_FACE_DETECTOR ?? 'hybrid')
    .action(
      action(async (clipId: string, o: { detector: string }) => {
        const { detectSplit } = await import('../reframe/split');
        const { loadProject } = await import('../project');
        const r = await detectSplit(clipId, { log: console.log, detector: o.detector as 'insightface' | 'vision' });
        if (!r.found) {
          console.log(`no stable facecam found (${r.reason ?? 'no face'}); framing unchanged`);
          return;
        }
        const b = loadProject(clipId).framing.split;
        const fmt = (v: number) => v.toFixed(2);
        console.log(`split layout: cam ${fmt(b.cam.x)},${fmt(b.cam.y)} ${fmt(b.cam.w)}×${fmt(b.cam.h)} · game ${fmt(b.game.x)},${fmt(b.game.y)} ${fmt(b.game.w)}×${fmt(b.game.h)} · cam band ${Math.round(b.camShare * 100)}%`);
      }),
    );

  program
    .command('accept <clipId> [markerIds...]')
    .description('Accept proposed markers (all of them, or the ones listed)')
    .option('--reject', 'remove them instead')
    .action(
      action(async (clipId: string, ids: string[], o: { reject?: boolean }) => {
        const { loadProject, saveProject } = await import('../project');
        const p = loadProject(clipId);
        const { acceptProposals, rejectProposals } = await import('../core/proposals');
        const n = p.markers.filter((m) => m.proposed && (!ids.length || ids.includes(m.id))).length;
        saveProject(o.reject ? rejectProposals(p, ids) : acceptProposals(p, ids));
        console.log(`${o.reject ? 'rejected' : 'accepted'} ${n} marker${n === 1 ? '' : 's'}`);
      }),
    );

  // ---------- presets ----------

  const preset = program.command('preset').description('Save a clip’s look and apply it to other clips');

  preset.command('list').action(
    action(async () => {
      const { listPresets } = await import('../project');
      console.log(listPresets().join('\n') || '(no presets)');
    }),
  );

  preset
    .command('save <clipId> <name>')
    .description('Save markers (relative to the clip edges), caption style and framing')
    .action(
      action(async (clipId: string, name: string) => {
        const { loadProject, presetFromProject, presetFile } = await import('../project');
        const { writeJson } = await import('../core/paths');
        const pr = presetFromProject(loadProject(clipId), name);
        writeJson(presetFile(name), pr);
        console.log(`saved preset ${name} (${pr.markers.length} markers)`);
      }),
    );

  preset
    .command('apply <name> <clipId>')
    .option('--add', 'keep existing markers instead of replacing them')
    .action(
      action(async (name: string, clipId: string, o: { add?: boolean }) => {
        const { loadProject, saveProject, loadPreset, applyPreset } = await import('../project');
        const p = await applyPreset(loadProject(clipId), loadPreset(name), o.add ? 'add' : 'replace');
        saveProject(p);
        console.log(`applied ${name} to ${clipId} (${p.markers.length} markers)`);
      }),
    );
}
