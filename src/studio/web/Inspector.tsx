// Right-hand panel: the selected marker's params (form generated from its zod schema),
// a caption word fix, or the clip's settings (in/out, captions, framing, presets).
import { CAPTION_LOOKS, CAPTION_LOOK_KEYS, type CaptionLookKey } from '../../core/captionLooks';
import React, { useEffect, useRef, useState } from 'react';
import type { Project, Word, CaptionSettings, Framing, FramingBox, Post, SplitLayout } from '../../core/schemas';
import { postFor, postBody } from '../../core/post';
import { fmtTime, parseTime } from '../../core/time';
import { TYPE_MAP, paramSchemas, patchMarker, type ParamSchema } from './types';
import { api } from './api';
import { acceptProposals, rejectProposals } from '../../core/proposals';
import { STYLES } from '../../edit/styles';
import type { Selection } from './Timeline';

type Update = (fn: (p: Project) => Project, key?: string) => void;

export function TimeInput({ label, ms, onCommit }: { label: string; ms: number; onCommit: (ms: number) => void }) {
  const [v, setV] = useState(fmtTime(ms, 2));
  const [bad, setBad] = useState(false);
  useEffect(() => setV(fmtTime(ms, 2)), [ms]);
  const commit = () => {
    try {
      const n = parseTime(v);
      setBad(false);
      if (n !== ms) onCommit(n);
    } catch {
      setBad(true);
    }
  };
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="text"
        className="mono"
        value={v}
        style={bad ? { borderColor: 'var(--bad)' } : undefined}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
    </div>
  );
}

function ParamField({
  name,
  s,
  value,
  onChange,
  sfx,
}: {
  name: string;
  s: ParamSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  sfx: string[];
}) {
  const label = (
    <label>
      <span>{name}</span>
      {typeof value === 'number' && <span className="mono">{Math.round(value * 1000) / 1000}</span>}
    </label>
  );
  let input: React.ReactNode;
  if (s.enum) {
    input = (
      <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {s.enum.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  } else if (s.type === 'boolean') {
    input = <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  } else if (s.ui === 'color') {
    input = (
      <div className="row">
        <input type="color" value={String(value)} onChange={(e) => onChange(e.target.value)} />
        <input type="text" className="mono" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  } else if (s.ui === 'sfx') {
    input = (
      <div className="row">
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {[...new Set([String(value), ...sfx])].map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <button title="Listen" onClick={() => void new Audio(`/media/assets/sfx/${encodeURIComponent(String(value))}`).play()}>
          ▶
        </button>
      </div>
    );
  } else if ((s.type === 'number' || s.type === 'integer') && s.minimum !== undefined && s.maximum !== undefined) {
    const step = s.type === 'integer' ? 1 : (s.maximum - s.minimum) / 200;
    input = (
      <input type="range" min={s.minimum} max={s.maximum} step={step} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />
    );
  } else if (s.type === 'number' || s.type === 'integer') {
    input = <input type="number" value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} />;
  } else {
    input =
      name === 'text' ? (
        <textarea rows={2} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      );
  }
  return (
    <div className="field">
      {label}
      {input}
      {s.description && <div className="hint">{s.description}</div>}
    </div>
  );
}

export function Inspector(props: {
  project: Project;
  sel: Selection;
  setSel: (s: Selection) => void;
  update: Update;
  words: Word[];
  sfx: string[];
  presets: string[];
  onSavePreset: (name: string) => void;
  onApplyPreset: (name: string) => void;
  onTrimEnd: () => void;
  /** Drop a marker at the playhead (quick effects). */
  onQuick: (type: string, params: Record<string, unknown>) => void;
  /** Suggested post text (the Post fields override it). */
  postSuggestion?: Post;
}) {
  const { project, sel } = props;
  if (sel?.kind === 'marker') {
    const m = project.markers.find((x) => x.id === sel.id);
    if (m) return <MarkerInspector {...props} markerId={m.id} />;
  }
  if (sel?.kind === 'word') {
    const w = props.words.find((x) => x.i === sel.i);
    if (w) return <WordInspector {...props} word={w} />;
  }
  return <ClipSettings {...props} />;
}

function MarkerInspector({ project, update, setSel, sfx, markerId }: Parameters<typeof Inspector>[0] & { markerId: string }) {
  const m = project.markers.find((x) => x.id === markerId)!;
  const t = TYPE_MAP.get(m.type);
  if (!t) return <div className="section">Unknown marker type “{m.type}”. Is markers/{m.type}/ missing?</div>;
  const schemas = paramSchemas(t);
  const inMs = project.segments[0].startMs;
  return (
    <>
      <div className="section">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="swatch" style={{ background: t.color }} />
          <strong className="grow">{t.label}</strong>
          <span className="muted mono">{m.id}</span>
        </div>
        <div className="muted" style={{ marginBottom: 10 }}>
          {t.description}
        </div>
        {m.proposed && (
          <div className="proposal">
            <div style={{ marginBottom: 6 }}>Proposed{m.source ? ` by ${m.source}` : ''}. The preview shows it; the export skips it until you accept.</div>
            <div className="row">
              <button className="primary" onClick={() => update((p) => acceptProposals(p, [m.id]))}>
                Accept <kbd>A</kbd>
              </button>
              <button onClick={() => (update((p) => rejectProposals(p, [m.id])), setSel(null))}>Reject</button>
            </div>
          </div>
        )}
        <TimeInput
          label={`${t.kind === 'span' ? 'Start' : 'At'} (+${((m.startMs - inMs) / 1000).toFixed(2)} s into clip)`}
          ms={m.startMs}
          onCommit={(ms) => update((p) => patchMarker(p, m.id, { startMs: ms, endMs: m.endMs !== undefined ? ms + (m.endMs - m.startMs) : undefined }))}
        />
        {t.kind === 'span' && m.endMs !== undefined && (
          <TimeInput label={`End (${((m.endMs - m.startMs) / 1000).toFixed(2)} s long)`} ms={m.endMs} onCommit={(ms) => ms > m.startMs && update((p) => patchMarker(p, m.id, { endMs: ms }))} />
        )}
      </div>
      <div className="section">
        <h3>Parameters</h3>
        {Object.entries(schemas).map(([k, s]) => (
          <ParamField
            key={k}
            name={k}
            s={s}
            value={m.params[k] ?? s.default}
            sfx={sfx}
            onChange={(v) => {
              const parsed = t.params.safeParse({ ...m.params, [k]: v });
              if (parsed.success) update((p) => patchMarker(p, m.id, { params: parsed.data as Record<string, unknown> }), `param:${m.id}:${k}`);
            }}
          />
        ))}
      </div>
      <div className="section row">
        <button className="danger" onClick={() => (update((p) => ({ ...p, markers: p.markers.filter((x) => x.id !== m.id) })), setSel(null))}>
          Delete <kbd>⌫</kbd>
        </button>
        <button onClick={() => setSel(null)}>
          Done <kbd>esc</kbd>
        </button>
      </div>
    </>
  );
}

function WordInspector({ project, update, setSel, word }: Parameters<typeof Inspector>[0] & { word: Word }) {
  const fix = project.captions.fixes[String(word.i)];
  const [v, setV] = useState(fix ?? word.text);
  useEffect(() => setV(fix ?? word.text), [word.i, fix, word.text]);
  const setFix = (text: string | undefined) =>
    update((p) => {
      const fixes = { ...p.captions.fixes };
      if (text === undefined || text === word.text) delete fixes[String(word.i)];
      else fixes[String(word.i)] = text;
      return { ...p, captions: { ...p.captions, fixes } };
    });
  return (
    <div className="section">
      <h3>Caption word</h3>
      <div className="muted mono" style={{ marginBottom: 8 }}>
        #{word.i} at {fmtTime(word.startMs, 2)} · captions heard “{word.text}”
      </div>
      <div className="field">
        <label>Show as</label>
        <input
          type="text"
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setFix(v);
              setSel(null);
            }
          }}
        />
        <div className="hint">Enter saves. Keep punctuation; a full stop starts a new caption page.</div>
      </div>
      <div className="row">
        <button className="primary" onClick={() => (setFix(v), setSel(null))}>
          Save
        </button>
        <button onClick={() => setFix('')}>Hide word</button>
        {fix !== undefined && <button onClick={() => setFix(undefined)}>Revert</button>}
      </div>
    </div>
  );
}

const rnd = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const QUICK: { label: string; title: string; type: string; params: () => Record<string, unknown> }[] = [
  { label: '💥 Boom', title: 'A random boom (boom, bass drop or pop)', type: 'sfx', params: () => ({ sound: rnd(['boom.wav', 'bass-drop.wav', 'pop.wav']) }) },
  { label: '😂 Emoji', title: 'A random laughing/skull emoji pop', type: 'emoji', params: () => ({ emoji: rnd(['😂', '💀', '🤣', '😭', '🔥', '😳']) }) },
  { label: '⚡ Glitch', title: 'A short glitch with its sound', type: 'glitch', params: () => ({}) },
  { label: '💨 Whoosh', title: 'A whoosh sound', type: 'sfx', params: () => ({ sound: rnd(['whoosh.wav', 'swish.wav']) }) },
  { label: '📈 Riser', title: 'A riser that builds for 1.4 s', type: 'sfx', params: () => ({ sound: 'riser.wav', volume: 0.6 }) },
  { label: '📸 Flash', title: 'A camera flash with a shutter sound', type: 'flash', params: () => ({}) },
  { label: '🫨 Shake', title: 'A short shake', type: 'shake', params: () => ({}) },
  {
    label: '🔔 Subscribe',
    title: 'A subtle 3 s subscribe prompt near the bottom',
    type: 'text',
    params: () => ({ text: '🔔 SUBSCRIBE', style: 'hook', y: 0.82, fontSize: 38, animation: 'fade' }),
  },
];

function ClipSettings({ project, update, presets, onSavePreset, onApplyPreset, onTrimEnd, onQuick, postSuggestion }: Parameters<typeof Inspector>[0]) {
  const seg = project.segments[0];
  const c = project.captions;
  const f = project.framing;
  const len = (seg.endMs - seg.startMs) / 1000;
  const [title, setTitle] = useState(project.title);
  const [presetName, setPresetName] = useState('');
  const [presetSel, setPresetSel] = useState('');
  useEffect(() => setTitle(project.title), [project.title]);
  const setCap = (patch: Partial<CaptionSettings>, key: string) => update((p) => ({ ...p, captions: { ...p.captions, ...patch } }), key);
  const setFrame = (patch: Partial<Framing>, key?: string) => update((p) => ({ ...p, framing: { ...p.framing, ...patch } }), key);
  const setSeg = (patch: Partial<typeof seg>) => {
    const s = { ...seg, ...patch };
    if (s.endMs - s.startMs < 1000 || s.startMs < 0 || s.endMs > project.sourceDurationMs) return;
    update((p) => ({ ...p, segments: [s] }));
    setTimeout(onTrimEnd);
  };
  const proposed = project.markers.filter((m) => m.proposed);
  const [styleKey, setStyleKey] = useState('punch');
  const runAction = async (kind: string, body: Record<string, unknown> = {}) => {
    try {
      await api(`/api/clips/${project.id}/action`, { body: { kind, ...body } });
    } catch (e) {
      alert((e as Error).message);
    }
  };
  return (
    <>
      {proposed.length > 0 && (
        <div className="section">
          <div className="proposal">
            <div style={{ marginBottom: 6 }}>
              {proposed.length} proposed marker{proposed.length > 1 ? 's' : ''} (
              {[...new Set(proposed.map((m) => m.source ?? m.type))].join(', ')}). Dashed on the timeline; the export skips them until accepted.
            </div>
            <div className="row">
              <button className="primary" onClick={() => update((p) => acceptProposals(p))}>
                Accept all
              </button>
              <button onClick={() => update((p) => rejectProposals(p))}>Reject all</button>
            </div>
          </div>
        </div>
      )}
      <div className="section">
        <h3>Edit style</h3>
        <div className="field">
          <select value={styleKey} onChange={(e) => setStyleKey(e.target.value)}>
            {STYLES.map((st) => (
              <option key={st.key} value={st.key}>
                {st.label}
              </option>
            ))}
          </select>
          <div className="hint">{STYLES.find((st) => st.key === styleKey)?.description}</div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => void runAction('autoedit', { style: styleKey })} title="Fill in the style's edits as proposals; re-applying replaces the previous engine edits">
            Apply style
          </button>
          <button
            onClick={() => update((p) => ({ ...p, markers: p.markers.filter((m) => m.source !== 'autoedit' && m.source !== 'silence') }))}
            title="Remove everything the engine added (undo with ⌘Z)"
            disabled={!project.markers.some((m) => m.source === 'autoedit' || m.source === 'silence')}
          >
            Remove engine edits
          </button>
        </div>
        <h3 style={{ marginTop: 12 }}>Quick effects at the playhead</h3>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {QUICK.map((q) => (
            <button key={q.label} title={q.title} onClick={() => onQuick(q.type, q.params())}>
              {q.label}
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <h3>Engine</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button onClick={() => void runAction('reframe')} title="Track faces; crop follows the speaker (as proposals). Select a span on the timeline to reframe just that part.">
            Auto-reframe
          </button>
          <button onClick={() => void runAction('suggest-cuts')} title="Propose jump cuts on dead air">
            Suggest cuts
          </button>
        </div>
        {project.review?.note && <div className="warn" style={{ marginTop: 6 }}>Reviewer: {project.review.note}</div>}
      </div>

      <div className="section">
        <h3>Clip</h3>
        <div className="field">
          <label>Title</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== project.title && update((p) => ({ ...p, title }))} />
        </div>
        <div className="row">
          <div className="grow">
            <TimeInput label="In" ms={seg.startMs} onCommit={(ms) => setSeg({ startMs: ms })} />
          </div>
          <div className="grow">
            <TimeInput label="Out" ms={seg.endMs} onCommit={(ms) => setSeg({ endMs: ms })} />
          </div>
        </div>
        <div className={len > 60 ? 'warn' : 'muted'}>
          {len.toFixed(1)} s{len > 60 ? ' · over 60 s: YouTube blocks claimed Shorts over 1 min' : ''}
        </div>
      </div>

      <PostSection project={project} update={update} suggestion={postSuggestion} />

      <div className="section">
        <h3>Captions</h3>
        <div className="field row">
          <input type="checkbox" checked={c.enabled} onChange={(e) => setCap({ enabled: e.target.checked }, 'cap:enabled')} />
          <span>Show captions</span>
          <span className="grow" />
          <input type="checkbox" checked={c.uppercase} onChange={(e) => setCap({ uppercase: e.target.checked }, 'cap:upper')} />
          <span>CAPS</span>
          <input type="checkbox" checked={c.censor !== false} onChange={(e) => setCap({ censor: e.target.checked }, 'cap:censor')} />
          <span title="Mask strong swears (f***ing) and slurs in the captions. The audio needs a Bleep marker: ./clip censor">Mask swears</span>
        </div>
        <div className="field">
          <label>Style</label>
          <select
            value={c.style}
            onChange={(e) => {
              // a look comes with its own case and size; the sliders below still adjust them
              const look = CAPTION_LOOKS[e.target.value as CaptionLookKey];
              setCap({ style: look.key, uppercase: look.uppercase, fontSize: look.fontSize }, 'cap:style');
            }}
          >
            {CAPTION_LOOK_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}: {CAPTION_LOOKS[k].label.split(': ').slice(1).join(': ') || CAPTION_LOOKS[k].label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            <span>Position</span>
            <span className="mono">{Math.round(c.position * 100)}%</span>
          </label>
          <input type="range" min={0.1} max={0.95} step={0.01} value={c.position} onChange={(e) => setCap({ position: Number(e.target.value) }, 'cap:pos')} />
        </div>
        <div className="field">
          <label>
            <span>Size</span>
            <span className="mono">{c.fontSize}px</span>
          </label>
          <input type="range" min={30} max={160} step={1} value={c.fontSize} onChange={(e) => setCap({ fontSize: Number(e.target.value) }, 'cap:size')} />
        </div>
        <div className="field">
          <label>
            <span>Words per page</span>
            <span className="mono">{c.combineMs} ms</span>
          </label>
          <input type="range" min={0} max={2500} step={50} value={c.combineMs} onChange={(e) => setCap({ combineMs: Number(e.target.value) }, 'cap:combine')} />
          <div className="hint">Words closer together than this share a page. 0 = one word at a time.</div>
        </div>
        <div className="field row">
          <span className="grow">Highlight</span>
          <input type="color" value={c.highlightColor} onChange={(e) => setCap({ highlightColor: e.target.value }, 'cap:hl')} />
        </div>
        <div className="hint">
          {Object.keys(c.fixes).length} word fix{Object.keys(c.fixes).length === 1 ? '' : 'es'}. Click a word in the transcript or the caption lane to fix it.
        </div>
      </div>

      <div className="section">
        <h3>Framing</h3>
        <div className="field">
          <select value={f.mode} onChange={(e) => setFrame({ mode: e.target.value as Framing['mode'] }, 'frame:mode')}>
            <option value="blur">blur-fit: whole picture, blurred fill</option>
            <option value="crop">crop: fill the frame</option>
            <option value="split">split: facecam on top, gameplay below</option>
          </select>
        </div>
        {f.mode === 'crop' && (
          <div className="field">
            <label>
              <span>Crop position</span>
              <span className="mono">{Math.round(f.cropX * 100)}%</span>
            </label>
            <input type="range" min={0} max={1} step={0.005} value={f.cropX} onChange={(e) => setFrame({ cropX: Number(e.target.value) }, 'frame:x')} />
          </div>
        )}
        {f.mode === 'split' && (
          <>
            <SplitEditor split={f.split} onChange={(split, key) => setFrame({ split }, key)} />
            <div className="field">
              <label>
                <span>Facecam band</span>
                <span className="mono">{Math.round(f.split.camShare * 100)}%</span>
              </label>
              <input
                type="range"
                min={0.2}
                max={0.6}
                step={0.01}
                value={f.split.camShare}
                onChange={(e) => setFrame({ split: { ...f.split, camShare: Number(e.target.value) } }, 'frame:camshare')}
              />
            </div>
            <div className="field">
              <label>
                <span>Under the cam</span>
              </label>
              <select value={f.split.content ?? 'fill'} onChange={(e) => setFrame({ split: { ...f.split, content: e.target.value as 'fill' | 'fit' } }, 'frame:content')}>
                <option value="fill">fill: crop the game to fill the band</option>
                <option value="fit">whole frame: websites, menus, Just Chatting</option>
              </select>
            </div>
            <div className="row">
              <button onClick={() => void runAction('split')} title="Track the facecam and place both boxes automatically (needs the footage)">
                Find facecam
              </button>
            </div>
          </>
        )}
        <div className="field">
          <label>
            <span>Zoom</span>
            <span className="mono">{f.zoom.toFixed(2)}×</span>
          </label>
          <input type="range" min={1} max={3} step={0.01} value={f.zoom} onChange={(e) => setFrame({ zoom: Number(e.target.value) }, 'frame:zoom')} />
          <div className="hint">Extra zoom; in split it tightens both boxes around their centres.</div>
        </div>
      </div>

      <div className="section">
        <h3>Presets</h3>
        <div className="row field">
          <select value={presetSel} onChange={(e) => setPresetSel(e.target.value)}>
            <option value="">{presets.length ? 'choose a preset…' : '(no presets yet)'}</option>
            {presets.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <button disabled={!presetSel} onClick={() => onApplyPreset(presetSel)}>
            Apply
          </button>
        </div>
        <div className="row">
          <input type="text" placeholder="name, e.g. podcast-punchy" value={presetName} onChange={(e) => setPresetName(e.target.value.replace(/[^a-z0-9-_]/gi, '-'))} />
          <button disabled={!presetName} onClick={() => (onSavePreset(presetName), setPresetName(''))}>
            Save
          </button>
        </div>
        <div className="hint">Saves markers (relative to the clip start or end), caption style and framing. “default” is applied to every new clip.</div>
      </div>
    </>
  );
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A small source-frame map with the facecam and gameplay boxes; drag to move, corner to resize. */
function SplitEditor({ split, onChange }: { split: SplitLayout; onChange: (s: SplitLayout, key?: string) => void }) {
  const area = useRef<HTMLDivElement>(null);
  const latest = useRef(split);
  latest.current = split;
  const drag = useRef<{ box: 'cam' | 'game'; kind: 'move' | 'resize'; sx: number; sy: number; start: FramingBox; w: number; h: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const down = (e: React.PointerEvent, box: 'cam' | 'game', kind: 'move' | 'resize') => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { box, kind, sx: e.clientX, sy: e.clientY, start: { ...latest.current[box] }, w: r.width, h: r.height };
    setActive(`${box}:${kind}`);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / d.w;
    const dy = (e.clientY - d.sy) / d.h;
    const b: FramingBox = { ...d.start };
    if (d.kind === 'move') {
      b.x = Math.min(1 - b.w, Math.max(0, b.x + dx));
      b.y = Math.min(1 - b.h, Math.max(0, b.y + dy));
    } else {
      b.w = Math.min(1 - b.x, Math.max(0.04, b.w + dx));
      b.h = Math.min(1 - b.y, Math.max(0.04, b.h + dy));
    }
    onChange({ ...latest.current, [d.box]: { x: r3(b.x), y: r3(b.y), w: r3(b.w), h: r3(b.h) } }, `split:${d.box}:${d.kind}`);
  };
  const up = () => {
    drag.current = null;
    setActive(null);
  };

  const box = (which: 'cam' | 'game', color: string) => {
    const b = split[which];
    return (
      <div
        key={which}
        onPointerDown={(e) => down(e, which, 'move')}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        style={{
          position: 'absolute',
          left: `${b.x * 100}%`,
          top: `${b.y * 100}%`,
          width: `${b.w * 100}%`,
          height: `${b.h * 100}%`,
          border: `2px solid ${color}`,
          background: `${color}22`,
          borderRadius: 4,
          cursor: 'move',
          touchAction: 'none',
          boxShadow: active?.startsWith(which) ? `0 0 0 2px ${color}` : undefined,
        }}
      >
        <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 11, color, fontFamily: 'monospace' }}>{which}</span>
        <div
          onPointerDown={(e) => down(e, which, 'resize')}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          style={{ position: 'absolute', right: -6, bottom: -6, width: 12, height: 12, background: color, borderRadius: 2, cursor: 'nwse-resize', touchAction: 'none' }}
        />
      </div>
    );
  };

  return (
    <div className="field">
      <div
        ref={area}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 9',
          background: 'repeating-conic-gradient(#1d1d1d 0% 25%, #2b2b2b 0% 50%) 50% / 24px 24px',
          borderRadius: 6,
          overflow: 'hidden',
          userSelect: 'none',
        }}
      >
        {box('game', '#38bdf8')}
        {box('cam', '#fbbf24')}
      </div>
      <div className="hint">Drag a box to move it, its corner to resize. Both are measured on the 16:9 source frame.</div>
    </div>
  );
}

export async function fetchSfx() {
  return api<string[]>('/api/sfx');
}

/** Title, caption and hashtags to paste when posting. Blank fields use the suggestion. */
function PostSection({ project, update, suggestion }: { project: Project; update: Update; suggestion?: Post }) {
  const sug = suggestion ?? { title: project.title, caption: '', hashtags: '#shorts' };
  const post = postFor(project.post, sug);
  const set = (k: keyof Post, v: string) =>
    update((p) => {
      const next = { ...p.post, [k]: v.trim() || undefined };
      return { ...p, post: Object.values(next).some(Boolean) ? next : undefined };
    }, `post:${k}`);
  return (
    <div className="section">
      <h3>Post</h3>
      <PostField label="Title (YouTube Shorts)" value={project.post?.title} placeholder={sug.title} onCommit={(v) => set('title', v)} copy={post.title} />
      {sug.titles && sug.titles.length > 1 && (
        <div className="field">
          <label>Title options</label>
          <select value={post.title} onChange={(e) => set('title', e.target.value)}>
            {!sug.titles.includes(post.title) && <option value={post.title}>{post.title}</option>}
            {sug.titles.map((t, i) => (
              <option key={i} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className="hint">Bold name + action, spoken quote, curiosity, chat-aware, or searchable context. Pick the one the clip actually delivers; don’t promise a payoff that isn’t there.</div>
        </div>
      )}
      <PostField label="Caption (TikTok, Reels)" value={project.post?.caption} placeholder={sug.caption} onCommit={(v) => set('caption', v)} copy={post.caption} multiline />
      <PostField label="Hashtags" value={project.post?.hashtags} placeholder={sug.hashtags} onCommit={(v) => set('hashtags', v)} copy={post.hashtags} />
      <div className="row">
        <CopyButton text={postBody(post)} label="Copy caption + hashtags" />
        <span className="hint">Saved next to the MP4 as a .txt on export.</span>
      </div>
    </div>
  );
}

function PostField({ label, value, placeholder, onCommit, copy, multiline }: { label: string; value?: string; placeholder: string; onCommit: (v: string) => void; copy: string; multiline?: boolean }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => v !== (value ?? '') && onCommit(v);
  return (
    <div className="field">
      <label>
        <span>{label}</span>
        <CopyButton text={copy} label="copy" small />
      </label>
      {multiline ? (
        <textarea rows={3} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />
      ) : (
        <input type="text" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />
      )}
    </div>
  );
}

export function CopyButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={small ? 'ghost' : undefined}
      style={small ? { padding: '0 6px', fontSize: 11 } : undefined}
      disabled={!text}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        })
      }
    >
      {done ? 'copied ✓' : label}
    </button>
  );
}
