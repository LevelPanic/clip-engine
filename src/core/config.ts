// Every setting the engine reads from the environment, in one place: its type, its default, what it does
// and which part reads it. Code reads them through `setting(name)`, which parses the value each time it
// is called (a test may change one), and refuses a value it cannot read instead of quietly using NaN
// (`UPLOAD_MIN=15m` was NaN). `clip config` prints the values in force; docs/operations.md → "Settings"
// lists them, and test/config.test.ts keeps that table, this file and the code in step. Node only.

type Base = { doc: string; area: string; alias?: string };
type Spec =
  | (Base & { kind: 'number'; default: number; unit?: string })
  | (Base & { kind: 'optional-number'; unit?: string })
  | (Base & { kind: 'flag'; default: boolean })
  | (Base & { kind: 'choice'; values: readonly string[]; default: string })
  | (Base & { kind: 'text'; default?: string; fallback?: string });

const n = (area: string, d: number, doc: string, unit?: string, alias?: string): Extract<Spec, { kind: 'number' }> => ({ kind: 'number', default: d, doc, area, unit, alias });

export const SETTINGS = {
  // where things are
  CLIP_DATA: { kind: 'text', area: 'paths', doc: 'Where library/, clips/ and exports/ live (default: the project folder). The tests point it at a temp folder.' },
  CLIP_YOUTUBE_CLIENT_SECRETS: { kind: 'text', area: 'publishing', doc: 'The Google OAuth client JSON (default: client_secrets.json in the project).' },
  TIKTOK_SECRETS: { kind: 'text', area: 'publishing', doc: "The TikTok app's keys JSON (default: tiktok_secrets.json in the project)." },
  TIKTOK_CLIENT_KEY: { kind: 'text', area: 'publishing', doc: 'The TikTok client key, instead of the secrets file.' },
  TIKTOK_CLIENT_SECRET: { kind: 'text', area: 'publishing', doc: 'The TikTok client secret, instead of the secrets file.' },
  TIKTOK_REDIRECT_URI: { kind: 'text', area: 'publishing', doc: 'The TikTok login redirect (default: the one in the secrets file).' },
  CLIP_INSIGHTFACE_PY: { kind: 'text', area: 'faces', doc: 'A Python for the InsightFace sidecar, instead of the one it sets up in .cache/face-py.' },
  CLIP_NUDITY_PY: { kind: 'text', area: 'qa', doc: 'A Python for the NudeNet sidecar, instead of the one it sets up in .cache/nudity-py.' },
  CLIP_CLAUDE: { kind: 'text', area: 'judge', doc: 'The claude CLI to run the headless judge with (default: found on PATH).' },
  CLIP_OPENCODE: { kind: 'text', area: 'judge', doc: 'The opencode CLI for the unattended agents (default: the OpenCode app, then PATH).' },
  CLIP_BROWSER: { kind: 'text', area: 'render', doc: 'A Chrome to render with, instead of Remotion\'s headless shell.' },

  // models and engines
  CLIP_JUDGE: { kind: 'choice', values: ['claude', 'opencode', 'heuristic'], default: 'claude', area: 'judge', doc: 'Which judge `clip judge` and batches use.' },
  CLIP_JUDGE_MODEL: { kind: 'text', default: 'opencode-go/deepseek-v4.1-flash', area: 'judge', doc: 'The model the OpenCode judge runs.' },
  CLIP_PIPELINE_MODEL: { kind: 'text', fallback: 'CLIP_JUDGE_MODEL', area: 'pipeline', doc: "The model the unattended pipeline's agents run (default: CLIP_JUDGE_MODEL)." },
  CLIP_WHISPER_MODEL: { kind: 'text', area: 'transcripts', doc: 'The whisper.cpp model (default: small.en; `small` is multilingual and translates to English).' },
  CLIP_FACE_DETECTOR: { kind: 'choice', values: ['hybrid', 'vision', 'insightface'], default: 'hybrid', area: 'faces', doc: 'Apple Vision, InsightFace, or Vision with InsightFace filling its misses.' },

  // render
  CLIP_CONCURRENCY: { kind: 'optional-number', area: 'render', doc: 'Render tabs (default: CPUs − 2, at least 2).' },
  CLIP_OVT: { kind: 'optional-number', area: 'render', doc: 'Video-decode threads per render (default 4).' },
  CLIP_HW: { kind: 'flag', default: true, area: 'render', doc: 'Hardware video encoding (0 turns it off).' },
  CLIP_GL: { kind: 'choice', values: ['', 'swangle', 'angle', 'swiftshader'], default: '', area: 'render', doc: "Chrome's GL backend for rendering (default: Remotion's choice)." },
  CLIP_LOG: { kind: 'choice', values: ['error', 'warn', 'info', 'verbose'], default: 'error', area: 'render', doc: "Remotion's log level while rendering." },

  // the unattended pipeline
  MAX_KEEP: n('pipeline', 3, 'Candidates the unattended pipeline keeps per pass at most.'),
  FULL_EXPERT_TIMEOUT_MIN: n('pipeline', 60, 'Time limit for the three queue experts.', 'min'),
  FULL_VERIFY_TIMEOUT_MIN: n('pipeline', 45, 'Time limit for checking the experts\' confirms.', 'min'),
  FULL_EXTRACT_TIMEOUT_MIN: n('pipeline', 60, 'Time limit for the extractor.', 'min'),
  FULL_CURATE_TIMEOUT_MIN: n('pipeline', 45, 'Time limit for the curator.', 'min'),
  FULL_EDIT_TIMEOUT_MIN: n('pipeline', 90, 'Time limit for the editor (and a change request).', 'min'),

  // the watchlist
  CHECK_MIN: n('watchlist', 15, 'How often the creators and topics are checked for broadcasts.', 'min'),
  RECENT_HOURS: n('watchlist', 48, 'A creator check takes every broadcast live within this.', 'h'),
  MOMENTS_PER_STREAM: n('watchlist', 4, 'Moment jobs per stream at most.'),
  MAX_JOBS: { kind: 'optional-number', area: 'watchlist', doc: 'Jobs to run before a one-off watchlist run stops (default: --max, else 2).' },
  WATCHLIST_RETRIES: n('watchlist', 1, 'Retries for a job that failed on a timeout or the network.'),
  AUTO_CLIPS: n('watchlist', 3, 'Clips per YouTube video the watchlist makes at most.'),
  AUTO_EDITED: { kind: 'flag', default: false, area: 'watchlist', doc: 'Clip edited YouTube channels too (1), not only streams and podcasts.' },
  MIN_YT_MIN: n('watchlist', 15, "A YouTube upload shorter than this (or the creator's minMinutes) is skipped as a Short or an edited clip.", 'min'),
  MAX_YT_STREAM_MIN: n('watchlist', 720, 'A YouTube stream recording longer than this is skipped (too long to ingest whole).', 'min'),
  TOPICS: { kind: 'flag', default: true, area: 'watchlist', doc: 'Follow the trending games in topics.json (0 turns topics off).' },
  TOPIC_TOP: n('watchlist', 3, "Each topic's top streams taken into the tracker."),
  MOMENT_RANKER: { kind: 'choice', values: ['score', 'alternate'], default: 'score', area: 'watchlist', doc: 'The ranking the watchlist orders moments by (outside the trial).' },
  RANKER_TRIAL: { kind: 'flag', default: true, area: 'watchlist', doc: 'The blind ranker trial (0 turns it off).' },
  TRIAL_TOP: n('watchlist', 4, "A stream's top moments each trial arm draws from."),

  // the observer
  OBSERVE_CHUNK_MIN: n('observer', 60, 'Chat read per job at most.', 'min'),
  OBSERVE_LIVE_BATCH_MIN: n('observer', 10, "A live stream's new minutes are read in batches of this.", 'min'),
  OBSERVE_IDLE_S: n('observer', 60, 'Sleep when there is nothing to read.', 's'),
  RANK_EVERY_MIN: n('observer', 20, 'Each tracked stream is re-ranked this often.', 'min'),
  TRACK_ENDED_HOURS: n('observer', 48, 'An ended stream is followed this long (viewer clips keep coming).', 'h'),

  // the upload scheduler
  UPLOADS_PER_DAY: n('uploads', 8, 'Uploads in any 24 hours at most, until Settings → Uploads is saved in the Studio.'),
  UPLOAD_MIN: n('uploads', 180, 'Minutes between uploads at least, until Settings → Uploads is saved.', 'min'),
  LEAD_MIN: n('uploads', 5, 'An upload goes live this long after it is uploaded, until Settings → Uploads is saved.', 'min'),
  HOLD_RETRY_MIN: n('uploads', 60, 'A clip held by a passing error is tried again after this.', 'min', 'QUOTA_MIN'),
  REFUSED_PAUSE_MIN: n('uploads', 20, 'Pause after a refusal for good, so a fault cannot sweep the line aside.', 'min'),
  AUTH_RETRY_MIN: n('uploads', 10, 'While the YouTube login is broken, a token refresh is tried this often.', 'min'),
  MIN_UPLOAD_S: n('uploads', 5, 'An approval shorter than this is a broken export and is set aside.', 's'),
  ANALYTICS_HOURS: n('uploads', 24, 'How often the scheduler pulls YouTube analytics (0 turns it off).', 'h'),

  // the cleanup
  CLEANUP_MIN: n('cleanup', 60, 'How often the cleanup sweeps.', 'min'),
  REJECTED_GRACE_MIN: n('cleanup', 60, 'A rejected clip is deleted this long after the rejection.', 'min'),
  SOURCE_GRACE_HOURS: n('cleanup', 24, "A source's footage is kept this long after its last activity.", 'h'),
  SOURCE_DELETE: { kind: 'choice', values: ['media', 'all'], default: 'media', area: 'cleanup', doc: "What goes when a source is done: its media, or the whole folder." },
} satisfies Record<string, Spec>;

export type Name = keyof typeof SETTINGS;
type ValueOf<S> = S extends { kind: 'number' } ? number : S extends { kind: 'optional-number' } ? number | undefined : S extends { kind: 'flag' } ? boolean : S extends { kind: 'choice' } ? string : S extends { kind: 'text'; default: string } ? string : S extends { kind: 'text'; fallback: string } ? string : string | undefined;

const raw = (name: string, spec: Spec): string | undefined => {
  const v = process.env[name] ?? (spec.alias ? process.env[spec.alias] : undefined);
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

/** A setting's value now: the environment's, parsed, else its default. Throws on a value it cannot read. */
export function setting<K extends Name>(name: K): ValueOf<(typeof SETTINGS)[K]> {
  const spec = SETTINGS[name] as Spec;
  const v = raw(name, spec);
  const bad = (want: string) => new Error(`${name}=${v} is not ${want}${'unit' in spec && spec.unit ? ` (${spec.unit})` : ''}: ${spec.doc}`);
  switch (spec.kind) {
    case 'number':
    case 'optional-number': {
      if (v === undefined) return (spec.kind === 'number' ? spec.default : undefined) as never;
      const x = Number(v);
      if (!Number.isFinite(x)) throw bad('a number');
      return x as never;
    }
    case 'flag':
      if (v === undefined) return spec.default as never;
      if (v === '1' || v.toLowerCase() === 'true') return true as never;
      if (v === '0' || v.toLowerCase() === 'false') return false as never;
      throw bad('1 or 0');
    case 'choice':
      if (v === undefined) return spec.default as never;
      if (!spec.values.includes(v)) throw bad(`one of ${spec.values.filter(Boolean).join(', ')}`);
      return v as never;
    case 'text':
      return (v ?? (spec.fallback ? setting(spec.fallback as Name) : spec.default)) as never;
  }
}

/** Every setting with its value now and where it came from, for `clip config`. */
export function settingsNow(): { name: Name; value: string; from: 'env' | 'default'; area: string; doc: string }[] {
  return (Object.keys(SETTINGS) as Name[]).map((name) => {
    const spec = SETTINGS[name] as Spec;
    let value: string;
    try {
      const x = setting(name);
      value = x === undefined ? '' : String(x);
    } catch (e) {
      value = `✖ ${(e as Error).message}`;
    }
    return { name, value, from: raw(name, spec) === undefined ? 'default' : 'env', area: spec.area, doc: spec.doc };
  });
}

/** The default as the docs show it. */
export function defaultText(name: Name): string {
  const s = SETTINGS[name] as Spec;
  if (s.kind === 'number') return `${s.default}${s.unit ? ` ${s.unit}` : ''}`;
  if (s.kind === 'flag') return s.default ? 'on' : 'off';
  if (s.kind === 'choice') return s.default || '(engine default)';
  if (s.kind === 'text' && s.default) return s.default;
  if (s.kind === 'text' && s.fallback) return `= ${s.fallback}`;
  return '(see description)';
}
