// Node-side marker registry: finds every markers/<type>/ folder and generates the
// import file the browser and renderer bundles use. Adding a folder is all it takes.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths, listDirs } from '../core/paths';
import { sortMarkerTypes, type MarkerMeta } from './define';

export function markerFolders(): string[] {
  return listDirs(paths.markers).filter(
    (d) => !d.startsWith('_') && !d.startsWith('.') && fs.existsSync(path.join(paths.markers, d, 'schema.ts')),
  );
}

let cache: Map<string, MarkerMeta> | undefined;

export async function loadMarkerSchemas(): Promise<Map<string, MarkerMeta>> {
  if (cache) return cache;
  const out = new Map<string, MarkerMeta>();
  for (const dir of markerFolders()) {
    const mod = await import(pathToFileURL(path.join(paths.markers, dir, 'schema.ts')).href);
    const meta = mod.default as MarkerMeta;
    if (!meta?.type) throw new Error(`markers/${dir}/schema.ts must default-export defineMarker({...})`);
    if (meta.type !== dir) throw new Error(`markers/${dir}: type is "${meta.type}" but the folder is "${dir}"; they must match`);
    out.set(meta.type, meta);
  }
  cache = new Map(sortMarkerTypes([...out.values()]).map((m) => [m.type, m]));
  return cache;
}

const GENERATED = path.join(paths.markers, 'index.generated.ts');

/** Rewrite markers/index.generated.ts if the set of folders changed. Returns true when it wrote. */
export function generateMarkerIndex(): boolean {
  const dirs = markerFolders().filter((d) => {
    const hasRender = ['render.tsx', 'render.ts'].some((f) => fs.existsSync(path.join(paths.markers, d, f)));
    if (!hasRender) console.warn(`markers/${d}: no render.tsx, skipped`);
    return hasRender;
  });
  const ident = (d: string) => d.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines = [
    '// AUTO-GENERATED from the folders in markers/. Do not edit; add a folder instead.',
    "import type { MarkerType } from '../src/markers/define';",
    ...dirs.flatMap((d) => [
      `import ${ident(d)}Meta from './${d}/schema';`,
      `import ${ident(d)}Render from './${d}/render';`,
    ]),
    '',
    'export const markerTypes: MarkerType[] = [',
    ...dirs.map((d) => `  { ...${ident(d)}Meta, ...${ident(d)}Render } as MarkerType,`),
    '];',
    '',
  ];
  const text = lines.join('\n');
  const old = fs.existsSync(GENERATED) ? fs.readFileSync(GENERATED, 'utf8') : '';
  if (old === text) return false;
  fs.writeFileSync(GENERATED, text);
  return true;
}
