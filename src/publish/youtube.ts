// YouTube publishing: OAuth once, then resumable `videos.insert` uploads.
//
// No googleapis dependency: the OAuth loopback flow and the resumable upload are small enough to do
// with Node's fetch. The token lives in .cache/youtube-token.json; upload records live next to the
// export so a retry never posts the same clip twice.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { paths, readJsonIf, writeJson } from '../core/paths';
import { loadProject, suggestedPost } from '../project';
import { loadCandidates } from '../candidates';
import { loadQa } from '../qa';
import { postBody, postFor } from '../core/post';
import { doNotClipError, optedOutVideo, uncredited } from '../core/channel';
import type { QaReport } from '../qa';
import type { Project, Candidate } from '../core/schemas';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];
const REDIRECT = 'http://localhost:8080/oauth2callback';
const CHUNK = 8 * 1024 * 1024;
const TOKEN_FILE = () => path.join(paths.cache, 'youtube-token.json');
const SECRETS_FILE = () => process.env.CLIP_YOUTUBE_CLIENT_SECRETS ?? path.join(paths.root, 'client_secrets.json');

export interface PublishRecord {
  platform: 'youtube';
  clipId: string;
  videoId: string;
  url: string;
  title: string;
  privacy: string;
  publishAt?: string;
  at: string;
  /** 18+: the reviewer asked for it to go up age-restricted. */
  ageRestricted?: boolean;
  /** What YouTube's own record says after the upload (read back, never assumed). */
  ageRestriction?: 'applied' | 'not-applied';
  /** Why it was left private instead of scheduled (an 18+ clip YouTube did not age-restrict). */
  heldPrivate?: string;
}

const SCHEDULE_LEAD_MS = 5 * 60_000; // first upload goes live 5 minutes from now
const SCHEDULE_STEP_MS = 5 * 60_000; // then 10, 15, 20… minutes from the first upload
const SCHEDULE_HORIZON_MS = 2 * 60 * 60_000; // older/far-off schedules don't push a new batch

/** Publish times already queued by uploads in this batch. */
function pendingPublishTimes(): string[] {
  if (!fs.existsSync(paths.exports)) return [];
  return fs
    .readdirSync(paths.exports)
    .filter((f) => f.endsWith('.publish.json'))
    .flatMap((f) => {
      const rec = readJsonIf<PublishRecord>(path.join(paths.exports, f));
      return rec?.publishAt ? [rec.publishAt] : [];
    });
}

/**
 * The next scheduled slot: +5 min for the first upload, +10 for the second, +15 for the third,
 * measured from the first upload of the batch. Ignore old or far-future schedules so a new batch
 * starts at +5 again.
 */
export function nextPublishSlot(pending: string[] = pendingPublishTimes(), now = Date.now()): string {
  const horizon = now + SCHEDULE_HORIZON_MS;
  const latest = pending
    .map((t) => Date.parse(t))
    .filter((t) => t > now && t <= horizon)
    .reduce((a, b) => Math.max(a, b), 0);
  return new Date(Math.max(now + SCHEDULE_LEAD_MS, latest + SCHEDULE_STEP_MS)).toISOString();
}

interface ClientSecrets {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

interface TokenFile {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
}

/** Google's downloaded JSON has either `installed` or `web` at the top level. */
export function readClientSecrets(file = SECRETS_FILE()): ClientSecrets {
  if (!fs.existsSync(file)) {
    throw new Error(
      `No YouTube OAuth client at ${file}. Create a Google Cloud OAuth client (Desktop app or Web app with ${REDIRECT}) and save its JSON there, or set CLIP_YOUTUBE_CLIENT_SECRETS.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { installed?: ClientSecrets; web?: ClientSecrets };
  const c = raw.installed ?? raw.web;
  if (!c?.client_id || !c.client_secret) throw new Error(`${file} isn't a Google OAuth client JSON (client_id/client_secret missing)`);
  return c;
}

const openBrowser = (url: string) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  import('node:child_process').then(({ spawn }) => spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref());
};

/** One-time loopback OAuth. Opens the browser, waits for the callback, stores the refresh token. */
export async function authYoutube(opts: { open?: boolean } = {}): Promise<TokenFile> {
  const secrets = readClientSecrets();
  const redirect = secrets.redirect_uris?.find((u) => /^http:\/\/localhost:\d+\//.test(u)) ?? REDIRECT;
  const port = Number(new URL(redirect).port || 8080);
  const state = crypto.randomUUID();
  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: secrets.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', redirect);
      if (u.pathname !== new URL(redirect).pathname) {
        res.writeHead(404).end();
        return;
      }
      if (u.searchParams.get('state') !== state) {
        res.writeHead(400).end('state mismatch');
        return;
      }
      const err = u.searchParams.get('error');
      const c = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(err ? `Authorization failed: ${err}` : 'YouTube connected. You can close this tab.');
      server.close();
      if (err || !c) reject(new Error(err ?? 'no authorization code'));
      else resolve(c);
    });
    server.on('error', (e) => reject(new Error(`OAuth callback server on port ${port}: ${e.message}`)));
    server.listen(port, () => {
      console.log(`Open this URL if the browser doesn't open:\n${authUrl.toString()}\n`);
      if (opts.open !== false) openBrowser(authUrl.toString());
    });
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timed out after 5 minutes'));
    }, 5 * 60_000).unref();
  });

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: secrets.client_id,
      client_secret: secrets.client_secret,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`YouTube token exchange failed: ${j.error_description ?? (await r.text())}`);
  const token: TokenFile = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
    token_type: 'Bearer',
  };
  writeJson(TOKEN_FILE(), token);
  return token;
}

/** A valid access token, refreshing the stored one when it's close to expiry. */
export async function youtubeAccessToken(): Promise<string> {
  const file = TOKEN_FILE();
  const token = readJsonIf<TokenFile>(file);
  if (!token?.access_token) throw new Error('YouTube is not connected. Run `./clip auth youtube` first.');
  if (Date.now() < token.expires_at - 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error('YouTube token expired and has no refresh token. Run `./clip auth youtube` again.');
  const secrets = readClientSecrets();
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: secrets.client_id,
      client_secret: secrets.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  // invalid_grant: the login expired (a Testing-mode Google app's lasts 7 days) or was revoked
  if (!r.ok || !j.access_token) throw new Error(`YouTube token refresh failed (${j.error ?? r.status}: ${j.error_description ?? 'no detail'}). Run \`./clip auth youtube\` to log in again.`);
  const next = { ...token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 };
  writeJson(file, next);
  return next.access_token;
}

export interface YoutubeMetadata {
  title: string;
  description: string;
  tags: string[];
  privacy: 'public' | 'unlisted' | 'private';
  publishAt?: string;
  categoryId: string;
  madeForKids: boolean;
  notifySubscribers: boolean;
  /** 18+: ask YouTube for an age-restricted video (`contentDetails.contentRating.ytRating`). */
  ageRestricted?: boolean;
}

/** YouTube categories that fit each lens; override with --category. */
export function categoryForLens(lens?: string): string {
  if (lens === 'stream-moments') return '20'; // Gaming
  if (lens === 'hot-takes') return '22'; // People & Blogs
  return '24'; // podcast-general → Entertainment
}

const cleanText = (s: string) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();

/** Build the request body and enforce YouTube's limits before spending quota. */
export function youtubeMetadata(o: Partial<YoutubeMetadata> & { title: string; description: string }): { body: object; query: string } {
  const title = cleanText(o.title).slice(0, 100);
  if (!title) throw new Error('YouTube title is empty');
  const description = o.description.trim().slice(0, 5000);
  const tags = [...new Set((o.tags ?? []).map((t) => cleanText(t.replace(/^#/, '')).replace(/[<>]/g, '')).filter(Boolean))].slice(0, 30);
  if (tags.join(',').length > 500) throw new Error('YouTube tags exceed the 500-character total');
  const publishAt = o.publishAt;
  if (publishAt) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(publishAt))
      throw new Error('publishAt must be an ISO timestamp with a timezone, e.g. 2026-12-01T12:00:00Z');
    if (Date.parse(publishAt) <= Date.now()) throw new Error('publishAt must be in the future');
  }
  // Scheduled videos must be private until YouTube publishes them.
  const privacy = publishAt ? 'private' : (o.privacy ?? 'unlisted');
  const body = {
    snippet: {
      title,
      description,
      tags,
      categoryId: o.categoryId ?? '24',
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
    },
    status: {
      privacyStatus: privacy,
      selfDeclaredMadeForKids: o.madeForKids ?? false,
      license: 'youtube',
      embeddable: true,
      publicStatsViewable: true,
      containsSyntheticMedia: false,
      ...(publishAt ? { publishAt } : {}),
    },
    // YouTube's docs do not list this as writable on insert; the upload reads it back and never assumes it
    ...(o.ageRestricted ? { contentDetails: { contentRating: { ytRating: 'ytAgeRestricted' } } } : {}),
  };
  const query = new URLSearchParams({
    uploadType: 'resumable',
    part: o.ageRestricted ? 'snippet,status,contentDetails' : 'snippet,status',
    ...(o.notifySubscribers ? {} : { notifySubscribers: 'false' }),
  }).toString();
  return { body, query };
}

const retry = async <T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> => {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message;
      if (i >= attempts - 1 || /quota|upload limit|not connected|invalid|forbidden/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      if (i === 0) console.log(`${label}: retrying (${msg})`);
    }
  }
};

/** Resumable `videos.insert`. Returns the new video id. */
export async function uploadYoutube(
  file: string,
  meta: YoutubeMetadata,
  opts: { log?: (s: string) => void } = {},
): Promise<{ videoId: string; url: string; privacy: string }> {
  const log = opts.log ?? console.log;
  if (!fs.existsSync(file)) throw new Error(`No export at ${file}`);
  const size = fs.statSync(file).size;
  if (!size) throw new Error(`${file} is empty`);
  let { body, query } = youtubeMetadata(meta);
  const token = await youtubeAccessToken();

  const init = () => retry(
    async () => {
      const r = await fetch(`${UPLOAD_URL}?${query}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(size),
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`YouTube upload init failed (${r.status}): ${(await r.text()).slice(0, 500)}`);
      const location = r.headers.get('location');
      if (!location) throw new Error('YouTube didn\'t return a resumable upload URL');
      return location;
    },
    'upload init',
  );
  let uploadUrl: string;
  try {
    uploadUrl = await init();
  } catch (e) {
    // an 18+ request YouTube refuses as a field (not a limit, not the login) goes up without it; the
    // caller reads the rating back and keeps the video private when it is not there
    const msg = (e as Error).message;
    if (!meta.ageRestricted || !/\((400|403)\)/.test(msg) || /uploadLimitExceeded|quota|rateLimit|auth|token/i.test(msg)) throw e;
    log(`YouTube refused the age restriction field (${msg.split('\n')[0].slice(0, 160)}); uploading without it`);
    ({ body, query } = youtubeMetadata({ ...meta, ageRestricted: false }));
    uploadUrl = await init();
  }

  log(`uploading ${(size / 1e6).toFixed(1)} MB to YouTube…`);
  const fd = fs.openSync(file, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, offset);
      const end = offset + len - 1;
      const res = await retry(
        () =>
          fetch(uploadUrl, {
            method: 'PUT',
            headers: {
              'Content-Length': String(len),
              'Content-Range': `bytes ${offset}-${end}/${size}`,
            },
            body: buf,
          }),
        `upload at ${(offset / 1e6).toFixed(1)} MB`,
      );
      if (res.status === 308) {
        const range = res.headers.get('range');
        const last = range ? Number(range.split('-')[1]) : NaN;
        offset = Number.isFinite(last) ? last + 1 : end + 1;
        log(`  ${Math.round((offset / size) * 100)}%`);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`YouTube upload failed (${res.status}): ${text.slice(0, 500)}`);
      const j = JSON.parse(text) as { id?: string };
      if (!j.id) throw new Error(`YouTube returned no video id: ${text.slice(0, 300)}`);
      log(`YouTube: https://youtu.be/${j.id}`);
      return { videoId: j.id, url: `https://youtu.be/${j.id}`, privacy: meta.publishAt ? 'private' : (meta.privacy ?? 'unlisted') };
    }
    throw new Error('YouTube upload ended without a video id');
  } finally {
    fs.closeSync(fd);
  }
}

/** Refuse to publish a recut/skip or a QA failure unless the caller explicitly forces it. */
export function publishBlocked(p: Project, cand: Candidate | undefined, qa: QaReport | undefined, force: boolean): string | null {
  if (force) return null;
  if (!cand) return 'no candidate is attached to this clip';
  if (cand.verdict !== 'post') return `candidate verdict is ${cand.verdict ?? 'unjudged'}; only post is publishable (use --force to override)`;
  if (qa && !qa.passed) return 'QA failed; fix the export or use --force';
  if (!qa) return 'no QA report; run `./clip qa <clipId>` first (or use --force)';
  return null;
}

/** Read back a video's age rating and status: what YouTube actually stored. */
export async function youtubeVideoState(videoId: string): Promise<{ ytRating: string | null; privacy: string | null; publishAt: string | null }> {
  const token = await youtubeAccessToken();
  const r = await fetch(`${VIDEOS_URL}?part=contentDetails,status&id=${encodeURIComponent(videoId)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`YouTube videos.list failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { items?: { contentDetails?: { contentRating?: { ytRating?: string } }; status?: { privacyStatus?: string; publishAt?: string } }[] };
  const v = j.items?.[0];
  if (!v) throw new Error(`YouTube has no video ${videoId}`);
  return { ytRating: v.contentDetails?.contentRating?.ytRating ?? null, privacy: v.status?.privacyStatus ?? null, publishAt: v.status?.publishAt ?? null };
}

/** Schedule a private video: `videos.update` of the whole status part (fields left out would be reset). */
export async function scheduleYoutube(videoId: string, publishAt: string): Promise<void> {
  const token = await youtubeAccessToken();
  const status = { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: false, containsSyntheticMedia: false, license: 'youtube', embeddable: true, publicStatsViewable: true };
  const r = await fetch(`${VIDEOS_URL}?part=status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ id: videoId, status }),
  });
  if (!r.ok) throw new Error(`YouTube videos.update failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
}

export interface PublishOptions {
  privacy?: 'public' | 'unlisted' | 'private';
  publishAt?: string;
  /** Upload immediately instead of scheduling. */
  immediate?: boolean;
  categoryId?: string;
  force?: boolean;
  /** 18+ (age-restricted). Default: the clip's review decision (`review.adult`). */
  ageRestricted?: boolean;
  log?: (s: string) => void;
}

/** Publish one exported clip. Idempotent unless `force` is set. */
export async function publishYoutube(clipId: string, opts: PublishOptions = {}): Promise<PublishRecord> {
  const file = path.join(paths.exports, `${clipId}.mp4`);
  const recordFile = path.join(paths.exports, `${clipId}.publish.json`);
  const existing = readJsonIf<PublishRecord>(recordFile);
  if (existing && !opts.force) {
    console.log(`Already published: ${existing.url}`);
    return existing;
  }
  const p = loadProject(clipId);
  const cand = loadCandidates(p.videoId).candidates.find((c) => c.id === p.candidateId);
  const qa = loadQa(clipId);
  const out = optedOutVideo(p.videoId);
  if (out) throw doNotClipError(out); // --force does not override a creator who said no
  const bare = uncredited(clipId);
  if (bare) throw new Error(bare);
  // the never-post list: nudity, a slur said, a minor, a sexual title. Not overridable with --force
  const { neverPost, neverPostText } = await import('../qa/unsafe');
  const unsafe = await neverPost(clipId, { look: true });
  if (unsafe.length) throw new Error(neverPostText(clipId, unsafe));
  const blocked = publishBlocked(p, cand, qa, !!opts.force);
  if (blocked) throw new Error(blocked);

  // the same post the Studio and `clip post` show, credit included
  const suggestion = suggestedPost(p);
  const post = postFor(p.post, suggestion);
  const title = post.title;
  const description = postBody(post);
  // YouTube says tags play a minimal role; the description hashtags carry the keywords.
  const tags: string[] = [];

  // Default: private now, public at the next 5-minute slot. --publish-at sets an exact time;
  // --now bypasses the queue and uploads with the requested privacy.
  const publishAt = opts.publishAt ?? (opts.immediate ? undefined : nextPublishSlot());
  const log = opts.log ?? console.log;
  // 18+: up private with the age rating asked for, read back, and only then scheduled. YouTube's docs
  // do not list the rating as writable, so a clip it did not age-restrict stays private (never public
  // without the restriction) and says so on the review page.
  // a clip approved before the 18+ check existed has no decision: the check decides for it
  const ageRestricted = opts.ageRestricted ?? p.review?.adult ?? qa?.adult?.detected ?? false;
  const uploaded = await uploadYoutube(file, {
    title,
    description,
    tags,
    privacy: ageRestricted ? 'private' : publishAt ? 'private' : (opts.privacy ?? 'unlisted'),
    publishAt: ageRestricted ? undefined : publishAt,
    categoryId: opts.categoryId ?? categoryForLens(cand?.lens),
    madeForKids: false,
    notifySubscribers: false,
    ageRestricted,
  }, { log });
  const record: PublishRecord = {
    platform: 'youtube',
    clipId,
    videoId: uploaded.videoId,
    url: uploaded.url,
    title,
    privacy: uploaded.privacy,
    ...(publishAt && !ageRestricted ? { publishAt } : {}),
    at: new Date().toISOString(),
  };
  if (ageRestricted) {
    record.ageRestricted = true;
    const state = await youtubeVideoState(uploaded.videoId).catch((e: Error) => ({ error: e.message }));
    if ('error' in state) {
      record.heldPrivate = `could not read the age rating back (${state.error.slice(0, 160)}): check it in YouTube Studio, then publish`;
    } else if (state.ytRating === 'ytAgeRestricted') {
      record.ageRestriction = 'applied';
      if (publishAt) {
        // the upload took a while: a publish time already passed moves to 2 minutes from now
        const at = Date.parse(publishAt) > Date.now() + 60_000 ? publishAt : new Date(Date.now() + 2 * 60_000).toISOString();
        try {
          await scheduleYoutube(uploaded.videoId, at);
          record.publishAt = at;
        } catch (e) {
          record.heldPrivate = `age-restricted, but scheduling failed (${(e as Error).message.slice(0, 160)}): publish it in YouTube Studio`;
        }
      }
    } else {
      record.ageRestriction = 'not-applied';
      record.heldPrivate = "YouTube did not take the age restriction from the upload: in YouTube Studio set Age restriction to 18+, then publish it";
    }
    log(record.ageRestriction === 'applied' && !record.heldPrivate ? `18+: YouTube age-restricted it${record.publishAt ? `; live ${record.publishAt}` : ''}` : `18+: left private: ${record.heldPrivate}`);
  }
  writeJson(recordFile, record);
  return record;
}
