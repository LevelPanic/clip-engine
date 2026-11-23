// Where everything lives on disk (Node only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Where library/, clips/ and exports/ live. Tests point CLIP_DATA at a temp folder. */
export const DATA = process.env.CLIP_DATA ? path.resolve(process.env.CLIP_DATA) : ROOT;

export const paths = {
  root: ROOT,
  library: path.join(DATA, 'library'),
  video: (id: string) => path.join(DATA, 'library', id),
  videoFile: (id: string, name: string) => path.join(DATA, 'library', id, name),
  clips: path.join(DATA, 'clips'),
  clip: (id: string) => path.join(DATA, 'clips', id),
  project: (id: string) => path.join(DATA, 'clips', id, 'project.json'),
  exports: path.join(DATA, 'exports'),
  presets: path.join(DATA, 'presets'),
  lenses: path.join(ROOT, 'lenses'),
  markers: path.join(ROOT, 'markers'),
  assets: path.join(ROOT, 'assets'),
  sfx: path.join(ROOT, 'assets', 'sfx'),
  cache: path.join(ROOT, '.cache'),
};

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function readJsonIf<T>(file: string): T | undefined {
  return fs.existsSync(file) ? readJson<T>(file) : undefined;
}

/** Write via a temp file + rename so readers (Studio, watchers) never see half a file. */
export function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
