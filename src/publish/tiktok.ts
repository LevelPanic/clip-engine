// TikTok Content Posting API: connect a creator and upload the clip to their TikTok inbox as a draft.
//
// We use the inbox endpoint (video.upload), not Direct Post (video.publish). An unaudited TikTok app
// can only Direct Post privately; the inbox flow hands the draft to the creator inside TikTok, where
// they finish the post. Connecting uses the desktop Login Kit flow: http://localhost callback + PKCE.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, readJsonIf, writeJson } from '../core/paths';
import { loadProject, suggestedPost } from '../project';
import { postFor, postBody } from '../core/post';
import { doNotClipError, optedOutVideo, uncredited } from '../core/channel';
import { loadCandidates } from '../candidates';
import { setting } from '../core/config';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const API = 'https://open.tiktokapis.com';
const SCOPES = ['user.info.basic', 'video.upload'];
const TOKEN_FILE = () => path.join(paths.cache, 'tiktok-token.json');
const SECRETS_FILE = () => setting('TIKTOK_SECRETS') ?? path.join(paths.root, 'tiktok_secrets.json');
const DEFAULT_REDIRECT = 'http://localhost:8080/tiktok/callback/';

export interface TikTokSecrets {
  client_key: string;
  client_secret: string;
  redirect_uri?: string;
  /** Default: user.info.basic + video.upload (inbox). Add video.publish for Direct Post. */
  scopes?: string[];
}

export interface TikTokToken {
  access_token: string;
  refresh_token: string;
  open_id: string;
  scope: string;
  token_type: string;
  expires_at: number;
  refresh_expires_at: number;
}

interface TikTokTokenResponse extends Partial<TikTokToken> {
  expires_in?: number;
  refresh_expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface TikTokUploadRecord {
  platform: 'tiktok';
  clipId: string;
  publishId: string;
  status: string;
  mode: 'inbox' | 'direct';
  privacy?: string;
  openId: string;
  at: string;
}

export function readTikTokSecrets(file = SECRETS_FILE()): TikTokSecrets {
  const env = {
    client_key: setting('TIKTOK_CLIENT_KEY'),
    client_secret: setting('TIKTOK_CLIENT_SECRET'),
    redirect_uri: setting('TIKTOK_REDIRECT_URI'),
  };
  let raw: Partial<TikTokSecrets> = env;
  if ((!env.client_key || !env.client_secret) && fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TikTokSecrets>;
  if (!raw.client_key || !raw.client_secret) {
    throw new Error(
      `No TikTok app credentials. Create a TikTok developer app, add Login Kit + Content Posting API (video.upload), register ${DEFAULT_REDIRECT}, then save {"client_key":"…","client_secret":"…"} as ${file} or set TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET.`,
    );
  }
  return { client_key: raw.client_key, client_secret: raw.client_secret, redirect_uri: raw.redirect_uri ?? DEFAULT_REDIRECT, scopes: raw.scopes };
}

const openBrowser = (url: string) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  import('node:child_process').then(({ spawn }) => spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref());
};

export function codeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('hex');
}

/** Desktop Login Kit: local HTTP callback, PKCE, then the inbox upload scope. */
export async function authTikTok(opts: { open?: boolean } = {}): Promise<TikTokToken> {
  const secrets = readTikTokSecrets();
  const redirect = secrets.redirect_uri ?? DEFAULT_REDIRECT;
  const scopes = secrets.scopes?.length ? secrets.scopes : SCOPES;
  const u = new URL(redirect);
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new Error(`TikTok desktop login needs http://localhost or http://127.0.0.1; got ${redirect}`);
  }
  const port = Number(u.port || 80);
  const state = crypto.randomUUID();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = codeChallenge(verifier);
  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_key: secrets.client_key,
    scope: scopes.join(','),
    response_type: 'code',
    redirect_uri: redirect,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', redirect);
      if (reqUrl.pathname !== u.pathname) {
        res.writeHead(404).end();
        return;
      }
      if (reqUrl.searchParams.get('state') !== state) {
        res.writeHead(400).end('state mismatch');
        return;
      }
      const err = reqUrl.searchParams.get('error');
      const c = reqUrl.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(err ? `TikTok authorization failed: ${err}` : 'TikTok connected. You can close this tab.');
      server.close();
      if (err || !c) reject(new Error(err ?? 'no authorization code'));
      else resolve(c);
    });
    server.on('error', (e) => reject(new Error(`TikTok callback server on port ${port}: ${e.message}`)));
    server.listen(port, () => {
      console.log(`Open this URL if the browser doesn't open:\n${authUrl.toString()}\n`);
      if (opts.open !== false) openBrowser(authUrl.toString());
    });
    setTimeout(() => {
      server.close();
      reject(new Error('TikTok OAuth timed out after 5 minutes'));
    }, 5 * 60_000).unref();
  });

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: secrets.client_key,
      client_secret: secrets.client_secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirect,
      code_verifier: verifier,
    }),
  });
  const j = (await r.json()) as TikTokTokenResponse;
  if (!r.ok || !j.access_token || !j.refresh_token) throw new Error(`TikTok token exchange failed: ${j.error_description ?? j.error ?? (await r.text())}`);
  const token: TikTokToken = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    open_id: j.open_id ?? '',
    scope: j.scope ?? scopes.join(','),
    token_type: j.token_type ?? 'Bearer',
    expires_at: Date.now() + (j.expires_in ?? 7200) * 1000,
    refresh_expires_at: Date.now() + (j.refresh_expires_in ?? 180 * 86400) * 1000,
  };
  writeJson(TOKEN_FILE(), token);
  return token;
}

export async function tiktokAccessToken(): Promise<TikTokToken> {
  const token = readJsonIf<TikTokToken>(TOKEN_FILE());
  if (!token?.access_token) throw new Error('TikTok is not connected. Run `./clip tiktok auth` first.');
  if (token.expires_at > Date.now() + 60_000) return token;
  if (token.refresh_expires_at && token.refresh_expires_at < Date.now()) throw new Error('TikTok refresh token expired. Run `./clip tiktok auth` again.');
  const secrets = readTikTokSecrets();
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: secrets.client_key,
      client_secret: secrets.client_secret,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    }),
  });
  const j = (await r.json()) as TikTokTokenResponse;
  if (!r.ok || !j.access_token) throw new Error(`TikTok token refresh failed: ${j.error_description ?? j.error ?? ''}`);
  const next: TikTokToken = {
    ...token,
    access_token: j.access_token,
    // TikTok rotates the refresh token: keep the new one immediately.
    refresh_token: j.refresh_token ?? token.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 7200) * 1000,
    refresh_expires_at: Date.now() + (j.refresh_expires_in ?? 180 * 86400) * 1000,
    scope: j.scope ?? token.scope,
  };
  writeJson(TOKEN_FILE(), next);
  return next;
}

/** TikTok requires 5–64 MB chunks; one chunk is fine for a small clip. */
export function chunkPlan(size: number): { chunkSize: number; total: number } {
  if (size <= 0) throw new Error('empty video');
  // TikTok accepts 5–64 MB chunks and rejects a tiny final chunk. Use one chunk for a normal
  // short-form export, and split large files evenly so the last chunk stays in range.
  const MAX = 64 * 1024 * 1024;
  const total = Math.max(1, Math.ceil(size / MAX));
  return { chunkSize: Math.ceil(size / total), total };
}

const tiktokError = (j: { error?: { code?: string; message?: string; log_id?: string } }, status: number) =>
  new Error(`TikTok API ${status}: ${j.error?.code ?? 'error'} — ${j.error?.message ?? 'unknown'}${j.error?.log_id ? ` (log ${j.error.log_id})` : ''}`);

async function uploadFile(uploadUrl: string, file: string, size: number, chunkSize: number, total: number, log: (s: string) => void) {
  const fd = fs.openSync(file, 'r');
  try {
    for (let i = 0; i < total; i++) {
      const start = i * chunkSize;
      const end = Math.min(size, start + chunkSize) - 1;
      const buf = Buffer.alloc(end - start + 1);
      fs.readSync(fd, buf, 0, buf.length, start);
      const up = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(buf.length),
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
        body: buf,
      });
      if (!up.ok) throw new Error(`TikTok chunk ${i + 1}/${total} failed (${up.status}): ${(await up.text()).slice(0, 300)}`);
      log(`uploaded chunk ${i + 1}/${total}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function pollStatus(publishId: string, accessToken: string, success: string[], log: (s: string) => void): Promise<string> {
  let status = 'PROCESSING_UPLOAD';
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${API}/v2/post/publish/status/fetch/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const j = (await r.json()) as { data?: { status?: string; fail_reason?: string }; error?: { code?: string; message?: string; log_id?: string } };
    if (!r.ok || j.error?.code !== 'ok') throw tiktokError(j, r.status);
    status = j.data?.status ?? status;
    log(`TikTok status: ${status}`);
    if (success.includes(status)) return status;
    if (status === 'FAILED') throw new Error(`TikTok upload failed: ${j.data?.fail_reason ?? 'unknown reason'}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return status;
}

function captionFor(clipId: string): { title: string; body: string } {
  const p = loadProject(clipId);
  const suggestion = suggestedPost(p);
  const post = postFor(p.post, suggestion);
  return { title: post.title, body: postBody(post) };
}

export async function uploadTikTokInbox(clipId: string, opts: { force?: boolean; log?: (s: string) => void } = {}): Promise<TikTokUploadRecord> {
  const log = opts.log ?? (() => {});
  const out = optedOutVideo(loadProject(clipId).videoId);
  if (out) throw doNotClipError(out);
  const bare = uncredited(clipId);
  if (bare) throw new Error(bare);
  const { neverPost, neverPostText } = await import('../qa/unsafe');
  const unsafe = await neverPost(clipId, { look: true });
  if (unsafe.length) throw new Error(neverPostText(clipId, unsafe));
  const file = path.join(paths.exports, `${clipId}.mp4`);
  const recordFile = path.join(paths.exports, `${clipId}.tiktok.json`);
  const existing = readJsonIf<TikTokUploadRecord>(recordFile);
  if (existing && !opts.force) {
    console.log(`Already uploaded to TikTok: ${existing.publishId} (${existing.status})`);
    return existing;
  }
  if (!fs.existsSync(file)) throw new Error(`No export at ${file}. Render the clip first.`);
  const size = fs.statSync(file).size;
  const { chunkSize, total } = chunkPlan(size);
  const token = await tiktokAccessToken();

  const init = await fetch(`${API}/v2/post/publish/inbox/video/init/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: total } }),
  });
  const initJson = (await init.json()) as { data?: { publish_id?: string; upload_url?: string }; error?: { code?: string; message?: string; log_id?: string } };
  if (!init.ok || initJson.error?.code !== 'ok' || !initJson.data?.publish_id || !initJson.data?.upload_url) throw tiktokError(initJson, init.status);
  const publishId = initJson.data.publish_id;
  log(`TikTok inbox upload ${publishId}: ${total} chunk${total === 1 ? '' : 's'} of ${chunkSize} bytes`);
  await uploadFile(initJson.data.upload_url, file, size, chunkSize, total, log);
  const status = await pollStatus(publishId, token.access_token, ['SEND_TO_USER_INBOX'], log);

  const record: TikTokUploadRecord = { platform: 'tiktok', clipId, publishId, status, mode: 'inbox', openId: token.open_id, at: new Date().toISOString() };
  writeJson(recordFile, record);
  const post = captionFor(clipId);
  log(`TikTok draft ${status}. Open TikTok → Inbox notifications to edit and post.`);
  log(`Suggested caption:\n${post.title}\n${post.body}`);
  return record;
}

/**
 * Direct Post as a private post (SELF_ONLY). Unaudited clients can only do this to an account set
 * to private, and the post is visible only to the owner until they change it to Everyone in TikTok.
 */
export async function directPostTikTok(clipId: string, opts: { force?: boolean; log?: (s: string) => void } = {}): Promise<TikTokUploadRecord> {
  const log = opts.log ?? (() => {});
  const file = path.join(paths.exports, `${clipId}.mp4`);
  const recordFile = path.join(paths.exports, `${clipId}.tiktok.json`);
  const existing = readJsonIf<TikTokUploadRecord>(recordFile);
  if (existing && existing.mode === 'direct' && !opts.force) {
    console.log(`Already posted directly: ${existing.publishId} (${existing.status})`);
    return existing;
  }
  // the same rules as every other post: the creator's no, the credit, the never-post list
  const out = optedOutVideo(loadProject(clipId).videoId);
  if (out) throw doNotClipError(out);
  const bare = uncredited(clipId);
  if (bare) throw new Error(bare);
  const { neverPost, neverPostText } = await import('../qa/unsafe');
  const unsafe = await neverPost(clipId, { look: true });
  if (unsafe.length) throw new Error(neverPostText(clipId, unsafe));
  if (!fs.existsSync(file)) throw new Error(`No export at ${file}. Render the clip first.`);
  const token = await tiktokAccessToken();
  if (!token.scope.split(',').map((s) => s.trim()).includes('video.publish')) {
    throw new Error('This TikTok token does not have the video.publish scope. Add video.publish to the app, add it to tiktok_secrets.json scopes, then run `./clip tiktok auth` again.');
  }

  const creatorRes = await fetch(`${API}/v2/post/publish/creator_info/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
  });
  const creator = (await creatorRes.json()) as {
    data?: { creator_nickname?: string; privacy_level_options?: string[]; max_video_post_duration_sec?: number };
    error?: { code?: string; message?: string; log_id?: string };
  };
  if (!creatorRes.ok || creator.error?.code !== 'ok' || !creator.data) throw tiktokError(creator, creatorRes.status);
  const options = creator.data.privacy_level_options ?? [];
  if (!options.includes('SELF_ONLY')) throw new Error(`TikTok did not offer SELF_ONLY for this creator: ${options.join(', ')}`);
  const p = loadProject(clipId);
  const durationS = (p.segments[0].endMs - p.segments[0].startMs) / 1000;
  const maxS = creator.data.max_video_post_duration_sec ?? 600;
  if (durationS > maxS) throw new Error(`Clip is ${durationS.toFixed(0)}s; TikTok allows ${maxS}s for this creator.`);
  log(`TikTok creator ${creator.data.creator_nickname ?? token.open_id}; posting SELF_ONLY (private)`);

  const size = fs.statSync(file).size;
  const { chunkSize, total } = chunkPlan(size);
  const post = captionFor(clipId);
  const title = `${post.title}\n\n${post.body}`.slice(0, 2200);
  const init = await fetch(`${API}/v2/post/publish/video/init/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: {
        title,
        privacy_level: 'SELF_ONLY',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        brand_content_toggle: false,
        brand_organic_toggle: false,
        is_aigc: false,
      },
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: total },
    }),
  });
  const initJson = (await init.json()) as { data?: { publish_id?: string; upload_url?: string }; error?: { code?: string; message?: string; log_id?: string } };
  if (!init.ok || initJson.error?.code !== 'ok' || !initJson.data?.publish_id || !initJson.data?.upload_url) {
    const code = initJson.error?.code ?? '';
    if (code === 'unaudited_client_can_only_post_to_private_accounts') {
      throw new Error('TikTok blocked this because the account is public. Set the TikTok account to private (Settings → Privacy → Private account), retry, then switch it back public and change the post to Everyone.');
    }
    throw tiktokError(initJson, init.status);
  }
  const publishId = initJson.data.publish_id;
  log(`TikTok direct post ${publishId}: ${total} chunk${total === 1 ? '' : 's'}`);
  await uploadFile(initJson.data.upload_url, file, size, chunkSize, total, log);
  const status = await pollStatus(publishId, token.access_token, ['PUBLISH_COMPLETE'], log);
  const record: TikTokUploadRecord = { platform: 'tiktok', clipId, publishId, status, mode: 'direct', privacy: 'SELF_ONLY', openId: token.open_id, at: new Date().toISOString() };
  writeJson(recordFile, record);
  log(`TikTok post ${status}. It is private (SELF_ONLY). To make it public: switch the account public, then set this post’s privacy to Everyone in TikTok.`);
  return record;
}

export async function tiktokStatus(publishId: string): Promise<{ status: string; fail?: string }> {
  const token = await tiktokAccessToken();
  const r = await fetch(`${API}/v2/post/publish/status/fetch/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const j = (await r.json()) as { data?: { status?: string; fail_reason?: string }; error?: { code?: string; message?: string; log_id?: string } };
  if (!r.ok || j.error?.code !== 'ok') throw tiktokError(j, r.status);
  return { status: j.data?.status ?? 'UNKNOWN', fail: j.data?.fail_reason };
}
