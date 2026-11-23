// Running external tools: yt-dlp (through uvx), ffmpeg, ffprobe (Node only).
import { spawn, type SpawnOptions } from 'node:child_process';
import type { MediaInfo } from './schemas';

/** Whether a process with this pid is running (and ours to signal). A pid of 0 is never one. */
export function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { onLine?: (line: string) => void; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let partial = '';
    const onData = (buf: Buffer, isErr: boolean) => {
      const s = buf.toString();
      if (isErr) stderr += s;
      else stdout += s;
      if (opts.onLine) {
        partial += s;
        const lines = partial.split(/\r|\n/);
        partial = lines.pop() ?? '';
        lines.filter(Boolean).forEach(opts.onLine);
      }
    };
    child.stdout!.on('data', (b) => onData(b, false));
    child.stderr!.on('data', (b) => onData(b, true));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

export async function runOrThrow(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-8).join('\n');
    throw new Error(`${cmd} exited with ${r.code}\n${tail}`);
  }
  return r;
}

/** yt-dlp via uv, always the latest release (YouTube changes often), using Node for its JS challenges.
 *  curl-cffi lets it impersonate a browser, which YouTube asks for and which cuts down on HTTP 429s. */
export const YTDLP = ['uvx', ['--from', 'yt-dlp[default,curl-cffi]@latest', 'yt-dlp', '--js-runtimes', 'node']] as const;

export async function ffprobe(file: string): Promise<MediaInfo> {
  const r = await runOrThrow('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
    '-of', 'json',
    file,
  ]);
  const j = JSON.parse(r.stdout);
  const s = j.streams?.[0] ?? {};
  const [num, den] = String(s.r_frame_rate ?? '30/1').split('/').map(Number);
  return {
    width: s.width,
    height: s.height,
    fps: den ? num / den : num,
    durationMs: Math.round(parseFloat(j.format?.duration ?? '0') * 1000),
  };
}
