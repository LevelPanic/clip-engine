// Markers: add, list, change and remove them, and regenerate the marker index.
import type { Command } from 'commander';
import { fmtTime, parseTime } from '../core/time';
import { parseParams, collect, type Action } from './shared';

export function register(program: Command, action: Action) {
  const marker = program.command('marker').description('Add, list, change and remove markers');

  marker
    .command('types')
    .description('List marker types and their parameters')
    .action(
      action(async () => {
        const { loadMarkerSchemas } = await import('../markers/registry-node');
        const { z } = await import('zod');
        let n = 1;
        for (const t of (await loadMarkerSchemas()).values()) {
          console.log(`${n++}. ${t.type} (${t.kind}, ${t.layer}): ${t.description}`);
          const js = z.toJSONSchema(t.params) as { properties?: Record<string, Record<string, unknown>> };
          for (const [k, s] of Object.entries(js.properties ?? {})) {
            const range = s.enum ? (s.enum as string[]).join('|') : s.minimum !== undefined ? `${s.minimum}–${s.maximum}` : s.type;
            console.log(`     ${k} = ${JSON.stringify(s.default)}  (${range})${s.description ? `  ${s.description}` : ''}`);
          }
        }
      }),
    );

  marker
    .command('list <clipId>')
    .action(
      action(async (clipId: string) => {
        const { loadProject } = await import('../project');
        const p = loadProject(clipId);
        const inMs = p.segments[0].startMs;
        if (!p.markers.length) console.log('no markers');
        for (const m of p.markers) {
          const when = m.endMs !== undefined ? `${fmtTime(m.startMs)}–${fmtTime(m.endMs)}` : fmtTime(m.startMs);
          console.log(`${m.id}  ${m.type.padEnd(6)} ${when.padEnd(18)} (+${((m.startMs - inMs) / 1000).toFixed(2)} s)  ${JSON.stringify(m.params)}`);
        }
      }),
    );

  marker
    .command('add <clipId> <type>')
    .description('Add a marker. Times are source time (14:50.2) or "+3.5" = seconds after the clip in-point')
    .requiredOption('--at <time>', 'start')
    .option('--to <time>', 'end (spans only; default length otherwise)')
    .option('--param <key=value>', 'parameter (repeatable)', collect)
    .option('--params <json>', 'parameters as JSON')
    .action(
      action(async (clipId: string, type: string, o: { at: string; to?: string; param?: string[]; params?: string }) => {
        const { addMarker, loadProject } = await import('../project');
        const inMs = loadProject(clipId).segments[0].startMs;
        const { marker: m } = await addMarker(clipId, {
          type,
          startMs: parseTime(o.at, inMs),
          endMs: o.to ? parseTime(o.to, inMs) : undefined,
          params: parseParams(o.param, o.params),
        });
        console.log(`${m.id}  ${m.type} at ${fmtTime(m.startMs)}${m.endMs ? `–${fmtTime(m.endMs)}` : ''}  ${JSON.stringify(m.params)}`);
      }),
    );

  marker
    .command('update <clipId> <markerId>')
    .option('--at <time>')
    .option('--to <time>')
    .option('--param <key=value>', 'parameter (repeatable)', collect)
    .option('--params <json>')
    .action(
      action(async (clipId: string, id: string, o: { at?: string; to?: string; param?: string[]; params?: string }) => {
        const { updateMarker, loadProject } = await import('../project');
        const inMs = loadProject(clipId).segments[0].startMs;
        const { marker: m } = await updateMarker(clipId, id, {
          startMs: o.at ? parseTime(o.at, inMs) : undefined,
          endMs: o.to ? parseTime(o.to, inMs) : undefined,
          params: o.param || o.params ? parseParams(o.param, o.params) : undefined,
        });
        console.log(`${m.id}  ${m.type} at ${fmtTime(m.startMs)}${m.endMs ? `–${fmtTime(m.endMs)}` : ''}  ${JSON.stringify(m.params)}`);
      }),
    );

  marker
    .command('rm <clipId> <markerId>')
    .action(
      action(async (clipId: string, id: string) => {
        const { removeMarker } = await import('../project');
        removeMarker(clipId, id);
        console.log(`removed ${id}`);
      }),
    );

  program
    .command('markers-gen', { hidden: true })
    .description('Regenerate markers/index.generated.ts')
    .action(
      action(async () => {
        const { generateMarkerIndex } = await import('../markers/registry-node');
        console.log(generateMarkerIndex() ? 'updated markers/index.generated.ts' : 'up to date');
      }),
    );
}
