// What the command groups share: the action wrapper's type, the Studio's address and argument parsers.
import fs from 'node:fs';

export type Action = <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) => (...args: A) => Promise<void>;

export const STUDIO = 'http://localhost:4400';

/** "--param scale=1.4" → { scale: 1.4 } (numbers, booleans and JSON are parsed; the rest stays text). */
export function parseParams(list: string[] = [], json?: string): Record<string, unknown> {
  const out: Record<string, unknown> = json ? JSON.parse(json) : {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`--param needs key=value, got "${kv}"`);
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export const collect = (v: string, prev: string[] = []) => [...prev, v];

/** A JSON list from a file or stdin ("-"): either a bare array or { <key>: [...] }. */
export function readList(src: string, key: string): unknown[] {
  const text = fs.readFileSync(src === '-' ? 0 : src, 'utf8');
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`${src === '-' ? 'stdin' : src} is not valid JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(j) ? j : (j as Record<string, unknown>)?.[key];
  if (!Array.isArray(list)) throw new Error(`expected a JSON array, or an object with a "${key}" array`);
  return list;
}
