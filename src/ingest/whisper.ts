// Whisper transcript (whisper.cpp): the fallback when YouTube has no auto-captions, or when better
// punctuation is needed. whisper.cpp and the model install into .cache/whisper on first use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadWhisperModel, type TranscriptionJson, type WhisperModel } from '@remotion/install-whisper-cpp';
import { paths } from '../core/paths';
import { run, runOrThrow } from '../core/proc';
import type { Transcript, Word } from '../core/schemas';
import { resolveAudio, audioPieces } from './media';

export const WHISPER_CPP_VERSION = '1.9.5';

/**
 * Measured on an M1 (comedy podcast, against YouTube's own words): small.en ran the whole 1 h 57 min
 * episode in 14.3 min (0.12× real time) with 85.7% of words matched and starts a median 49 ms apart.
 * base.en is twice as fast but matches less (81%); medium.en matches only slightly more (86%) at 0.27×
 * real time, about 32 min for 2 h.
 */
export const DEFAULT_WHISPER_MODEL: WhisperModel = 'small.en';

const MODELS: readonly WhisperModel[] = [
  'tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en',
  'large-v1', 'large-v2', 'large-v3', 'large-v3-turbo',
];

export const whisperDir = path.join(paths.cache, 'whisper');
const tmpDir = path.join(paths.cache, 'whisper-tmp');
// Same layout as @remotion/install-whisper-cpp (≥ 1.7.4), so its transcribe() also works on this folder.
export const whisperBin = path.join(whisperDir, 'build', 'bin', 'whisper-cli');
export const whisperModelFile = (model: WhisperModel) => path.join(whisperDir, `ggml-${model}.bin`);

export interface WhisperOptions {
  model?: string;
  fromMs?: number;
  toMs?: number;
  onProgress?: (s: string) => void;
}

export async function whisperTranscript(videoId: string, opts: WhisperOptions = {}): Promise<Transcript> {
  const log = opts.onProgress ?? (() => {});
  const model = (opts.model ?? DEFAULT_WHISPER_MODEL) as WhisperModel;
  if (!MODELS.includes(model)) throw new Error(`Unknown Whisper model "${opts.model}". Use one of: ${MODELS.join(', ')}`);
  const fromMs = Math.max(0, Math.round(opts.fromMs ?? 0));
  const toMs = opts.toMs === undefined ? undefined : Math.round(opts.toMs);
  if (toMs !== undefined && toMs <= fromMs) throw new Error(`Whisper range is empty (${fromMs}–${toMs} ms)`);
  const audio = toMs === undefined ? resolveAudio(videoId, fromMs, fromMs + 1) : null;
  const pieces = audio ? [{ ...audio, startMs: fromMs, endMs: Number.POSITIVE_INFINITY }] : audioPieces(videoId, fromMs, toMs!);
  if (!pieces) throw new Error(`No audio for ${videoId} at ${fromMs}–${toMs ?? 'end'} ms: download it first (audio job or clip scan)`);

  await ensureWhisperCpp(log);
  await ensureModel(model, log);

  fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.join(tmpDir, `${videoId}-${fromMs}-${toMs ?? 'end'}-${process.pid}-${Date.now()}`);
  const wav = `${base}.wav`;
  try {
    log(`Extracting audio from ${pieces.map((p) => path.basename(p.file)).join(' + ')}…`);
    // whisper.cpp only reads 16 kHz mono 16-bit wav. Several pieces (a range across audio chunks)
    // are cut to raw PCM, joined end to end, then wrapped as one wav.
    const raws: string[] = [];
    for (const [k, p] of pieces.entries()) {
      const raw = `${base}.${k}.pcm`;
      raws.push(raw);
      await runOrThrow('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        ...(p.startMs - p.offsetMs > 0 ? ['-ss', ((p.startMs - p.offsetMs) / 1000).toFixed(3)] : []),
        ...(Number.isFinite(p.endMs) ? ['-t', ((p.endMs - p.startMs) / 1000).toFixed(3)] : []),
        '-i', p.file,
        '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', raw,
      ]);
    }
    const joined = `${base}.pcm`;
    fs.writeFileSync(joined, Buffer.concat(raws.map((r) => fs.readFileSync(r))));
    raws.forEach((r) => fs.rmSync(r, { force: true }));
    await runOrThrow('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', joined, '-c:a', 'pcm_s16le', wav]);
    fs.rmSync(joined, { force: true });
    const json = await runWhisper(wav, base, model, (pct) => log(`Transcribing with Whisper ${model}: ${pct}%`));
    const { words, tags } = wordsFromWhisper(json, fromMs);
    return { videoId, source: 'whisper', lang: 'en', words, tags };
  } finally {
    fs.rmSync(wav, { force: true });
    fs.rmSync(`${base}.json`, { force: true });
  }
}

// ---------- install ----------

/**
 * Clone and build whisper.cpp (Metal on Apple Silicon) once. It's built in a side folder and moved into
 * place, so a failed build leaves nothing half-done.
 */
async function ensureWhisperCpp(log: (s: string) => void) {
  if (fs.existsSync(whisperBin)) return;
  const build = path.join(paths.cache, `whisper-build-${process.pid}`);
  fs.rmSync(build, { recursive: true, force: true });
  log(`Installing whisper.cpp ${WHISPER_CPP_VERSION} into .cache/whisper (one-time build, about a minute)…`);
  try {
    await runOrThrow('git', [
      'clone', '--quiet', '--depth', '1', '--branch', `v${WHISPER_CPP_VERSION}`,
      'https://github.com/ggml-org/whisper.cpp.git', build,
    ]);
    const cmake = await cmakeCommand();
    const metal = process.platform === 'darwin' && process.arch === 'arm64';
    await runOrThrow(cmake[0], [
      ...cmake.slice(1), '-S', build, '-B', path.join(build, 'build'),
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF', // one self-contained binary, so the folder still works after the move
      '-DWHISPER_BUILD_TESTS=OFF',
      `-DGGML_METAL=${metal ? 'ON' : 'OFF'}`,
      ...(metal ? ['-DGGML_METAL_EMBED_LIBRARY=ON'] : []),
    ]);
    await runOrThrow(cmake[0], [
      ...cmake.slice(1), '--build', path.join(build, 'build'), '--config', 'Release',
      '--target', 'whisper-cli', '--parallel', String(os.cpus().length),
    ]);
    if (fs.existsSync(whisperBin)) return; // another process finished first
    if (fs.existsSync(whisperDir)) {
      // a broken earlier install: keep its downloaded models
      for (const f of fs.readdirSync(whisperDir)) {
        if (/^ggml-.+\.bin$/.test(f)) fs.renameSync(path.join(whisperDir, f), path.join(build, f));
      }
      fs.rmSync(whisperDir, { recursive: true, force: true });
    }
    fs.renameSync(build, whisperDir);
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
}

/** Xcode's tools don't include cmake; uv (already needed for yt-dlp) can run it from PyPI. */
async function cmakeCommand(): Promise<string[]> {
  const ok = await run('cmake', ['--version']).then((r) => r.code === 0, () => false);
  return ok ? ['cmake'] : ['uvx', '--from', 'cmake', 'cmake'];
}

/** Download into a temp folder and rename, so an interrupted download never looks like a model. */
async function ensureModel(model: WhisperModel, log: (s: string) => void) {
  const file = whisperModelFile(model);
  if (fs.existsSync(file)) return;
  const dl = path.join(tmpDir, `model-${process.pid}`);
  const part = path.join(dl, `ggml-${model}.bin`);
  fs.rmSync(dl, { recursive: true, force: true });
  fs.mkdirSync(dl, { recursive: true });
  let total = 0;
  let lastPct = -1;
  try {
    await downloadWhisperModel({
      model,
      folder: dl,
      printOutput: false,
      onProgress: (got, size) => {
        total = size;
        const pct = Math.floor((got / size) * 100);
        if (pct >= lastPct + 5 || (pct === 100 && lastPct < 100)) {
          lastPct = pct;
          log(`Downloading Whisper model ${model}: ${pct}% of ${Math.round(size / 1e6)} MB`);
        }
      },
    });
    // the downloader resolves once every byte is queued, which can be just before the last write lands
    for (let n = 0; n < 100 && fs.statSync(part).size < total; n++) await new Promise((r) => setTimeout(r, 100));
    if (!total || fs.statSync(part).size !== total) throw new Error(`Whisper model ${model} download is incomplete`);
    fs.renameSync(part, file);
  } finally {
    fs.rmSync(dl, { recursive: true, force: true });
  }
}

// ---------- transcribe ----------

async function runWhisper(
  wav: string,
  outBase: string,
  model: WhisperModel,
  onPercent: (pct: number) => void,
): Promise<TranscriptionJson<true>> {
  const out = `${outBase}.json`;
  fs.rmSync(out, { force: true });
  const ac = new AbortController();
  let killTimer: NodeJS.Timeout | undefined;
  const args = [
    '-m', whisperModelFile(model),
    '-f', wav,
    '-l', 'en',
    '-ojf', '-of', outBase, // full JSON: every token with its text, id and times
    // DTW token times line up with the audio better than the default ones, but whisper.cpp
    // silently turns DTW off while flash attention is on (its default)
    '-dtw', model.replace(/-/g, '.'), '-nfa',
    '-pp',
  ];
  let result: Awaited<ReturnType<typeof run>> | undefined;
  try {
    result = await run(whisperBin, args, {
      signal: ac.signal,
      onLine: (line) => {
        const m = /progress =\s*(\d+)%/.exec(line);
        if (m) onPercent(Number(m[1]));
        // whisper.cpp has been known to hang while freeing Metal after writing its output: don't wait on it
        if (line.includes('total time') && !killTimer) killTimer = setTimeout(() => ac.abort(), 10_000);
      },
    });
  } catch (e) {
    if (!fs.existsSync(out)) throw e;
  } finally {
    clearTimeout(killTimer);
  }
  if (!fs.existsSync(out)) {
    const tail = (result?.stderr || result?.stdout || '').trim().split('\n').slice(-8).join('\n');
    throw new Error(`whisper.cpp exited with ${result?.code} and wrote no transcript\n${tail}`);
  }
  // whisper.cpp escapes only quotes and backslashes; a raw control character would break JSON.parse
  const text = fs.readFileSync(out, 'utf8').replace(/[\u0000-\u001f]/g, ' ');
  return JSON.parse(text) as TranscriptionJson<true>;
}

// ---------- whisper.cpp JSON → words and tags ----------

type WhisperToken = TranscriptionJson<true>['transcription'][number]['tokens'][number];

interface RawWord {
  text: string;
  startMs: number;
  endMs: number; // from whisper's own token times (rough); only used to cap the word's length
  segEndMs: number;
  speakerChange?: boolean;
}

// closing punctuation joins the word before it even when whisper puts a space in front (" ...")
const CLOSING = /^[.,!?;:…%)\]}”’]+$/;
// a lone opening quote or bracket waits for the word it belongs to
const OPENING = /^["'“‘([{¿¡]+$/;
const DASH = /^[-–—]+$/;
const SENTENCE_END = /[.?!…]["')\]”’]*$/;
const DTW_LEAD_MS = 200;
const NOTE = /[♪♫🎵🎶]/u;
const NOTES = /[♪♫🎵🎶]/gu;

/**
 * Merge whisper.cpp's sub-word tokens into words with absolute source times (offsetMs is where the
 * transcribed audio starts). Bracketed non-speech like [Music], (laughs) or ♪ becomes a tag.
 * Token times: `t_dtw` is in centiseconds, `offsets` in milliseconds (checked by padding audio with 7 s of
 * silence: t_dtw moved by 700, offsets by ~7000).
 */
export function wordsFromWhisper(json: TranscriptionJson<true>, offsetMs = 0): Pick<Transcript, 'words' | 'tags'> {
  const eot = json.model?.multilingual ? 50257 : 50256; // ids from here up are special tokens
  const isSpecial = (t: WhisperToken) => t.id >= eot || /^\[_[A-Z]/.test(t.text);
  const raw: RawWord[] = [];
  let prevDtw = -1;
  let pendingSpeaker = false;

  for (const seg of json.transcription) {
    const segEndMs = seg.offsets.to;
    let first = true;
    for (const tok of seg.tokens) {
      if (isSpecial(tok) || tok.text === '') continue;
      let tStart = tok.offsets?.from ?? -1;
      if (tok.t_dtw >= 0) {
        // whisper.cpp's DTW time is where the alignment moves on to the next token, so it lands late
        // (~120 ms for small.en against YouTube's word times). Starting halfway back towards the previous
        // token's time, at most 200 ms (pauses), matched YouTube best for base.en and small.en.
        const own = tok.t_dtw * 10;
        tStart = prevDtw >= 0 ? own - Math.min(Math.max(0, own - prevDtw) / 2, DTW_LEAD_MS) : own;
        prevDtw = own;
      }
      const tEnd = tok.offsets?.to ?? -1;
      const trimmed = tok.text.trim();
      if (!trimmed) continue;
      const spaced = first || /^\s/.test(tok.text);
      const cur = raw[raw.length - 1];
      first = false;
      if (spaced && DASH.test(trimmed)) {
        // "- Terrible. - Okay": whisper's subtitle-style dash for a new speaker; mid-sentence it's a cut-off
        if (!cur || SENTENCE_END.test(cur.text) || /[)\]*]$/.test(cur.text)) pendingSpeaker = true;
        else cur.text += trimmed;
        continue;
      }
      if (cur && (CLOSING.test(trimmed) || (!spaced && !pendingSpeaker) || OPENING.test(cur.text))) {
        cur.text += trimmed;
        cur.endMs = Math.max(cur.endMs, tEnd);
        continue;
      }
      raw.push({ text: trimmed, startMs: tStart, endMs: tEnd, segEndMs, ...(pendingSpeaker ? { speakerChange: true } : {}) });
      pendingSpeaker = false;
    }
  }

  // split off non-speech: [Music], [audience laughing], (laughs), *laughs*, ♪
  const speech: RawWord[] = [];
  const tags: Transcript['tags'] = [];
  const addTag = (ms: number, tag: string | undefined) => {
    if (!tag) return;
    const last = tags[tags.length - 1];
    if (last && last.tag === tag && ms - last.ms < 5000) return; // "♪ la la ♪" is one music cue
    tags.push({ ms: Math.round(ms + offsetMs), tag });
  };
  let speakerChange = false;
  for (let n = 0; n < raw.length; n++) {
    const w = raw[n];
    let text = w.text;
    if (w.speakerChange) speakerChange = true; // kept across tags: "- (laughs) Yeah"
    if (NOTE.test(text)) {
      addTag(w.startMs, 'music');
      text = text.replace(NOTES, '').trim();
      if (!text || CLOSING.test(text)) continue;
    }
    // whisper learned YouTube's ">>" new-speaker mark from its training captions
    if (text.startsWith('>>')) {
      speakerChange = true;
      text = text.replace(/^>>\s*/, '');
      if (!text) continue;
    }
    const open = /^[[(*]/.exec(text)?.[0];
    if (open) {
      const close = open === '[' ? ']' : open === '(' ? ')' : '*';
      const closes = (s: string) => new RegExp(`\\${close}[.,!?;:\\-–—]*$`).test(s) && (s.length > 1 || close !== '*');
      let end = -1;
      for (let k = n; k < Math.min(raw.length, n + 8); k++) {
        if (closes(k === n ? text : raw[k].text)) {
          end = k;
          break;
        }
      }
      if (end >= 0) {
        const inner = [text, ...raw.slice(n + 1, end + 1).map((r) => r.text)].join(' ');
        addTag(w.startMs, tagName(inner));
        n = end;
        continue;
      }
    }
    speech.push({ ...w, text, speakerChange });
    speakerChange = false;
  }

  // times: absolute, never going backwards, each word ending by the time the next one starts
  const starts: number[] = [];
  let prevStart = 0;
  for (const w of speech) {
    prevStart = Math.max(prevStart, w.startMs >= 0 ? w.startMs : prevStart);
    starts.push(prevStart);
  }
  // DTW sometimes gives neighbouring words the same time: spread them so each gets a moment on screen
  for (let a = 0; a < starts.length; ) {
    let b = a + 1;
    while (b < starts.length && starts[b] === starts[a]) b++;
    if (b - a > 1) {
      const room = b < starts.length ? starts[b] - starts[a] : 200 * (b - a);
      const step = Math.min(room / (b - a), 200);
      for (let k = a + 1; k < b; k++) starts[k] = starts[a] + (k - a) * step;
    }
    a = b;
  }
  const words: Word[] = speech.map((w, n) => {
    const start = starts[n];
    const nextStart = starts[n + 1] ?? Infinity;
    const guess = Math.min(1200, Math.max(200, w.text.length * 80 + 120));
    let end = w.endMs > start ? Math.min(w.endMs, start + 2 * guess) : start + guess;
    if (w.segEndMs > start) end = Math.min(end, w.segEndMs);
    end = Math.min(end, nextStart);
    return {
      i: n,
      startMs: Math.round(start + offsetMs),
      endMs: Math.round(Math.max(start, end) + offsetMs),
      text: w.text,
      ...(w.speakerChange ? { speakerChange: true } : {}),
    };
  });
  return { words, tags };
}

/** "[MUSIC PLAYING]" → "music", "(audience laughs)" → "laughter"; [BLANK_AUDIO] isn't worth a tag. */
function tagName(raw: string): string | undefined {
  const s = raw.toLowerCase().replace(/[[\]()*.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /blank_audio|silence|no speech/.test(s)) return undefined;
  if (/laugh|chuckl|giggl/.test(s)) return 'laughter';
  if (/music|song|singing|♪/.test(s)) return 'music';
  if (/applau|clapping/.test(s)) return 'applause';
  if (/cheer/.test(s)) return 'cheering';
  return s;
}
