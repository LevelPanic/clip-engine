// The Studio's UI components: one way to draw a button, a key hint, a chip, tabs, a nav bar, a page, a
// callout, a field, a row you can select, and a loading/empty/error state. Styles are in ui.css and read
// only the tokens in tokens.css. A page builds from these instead of inline styles and one-off classes.
import React, { cloneElement, isValidElement, useId } from 'react';

type Tone = 'default' | 'good' | 'warn' | 'bad' | 'accent';
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Button and key hints ----------

export function Button({ variant, kbd, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost'; kbd?: string }) {
  return (
    <button type="button" className={cx(variant, className)} {...rest}>
      {children}
      {kbd && (
        <>
          {' '}
          <Kbd>{kbd}</Kbd>
        </>
      )}
    </button>
  );
}

export const Kbd = ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>;

/** The keys a page answers to, in one format everywhere: `[['A', 'approve'], ['R', 'reject']]`. */
export function ShortcutLegend({ keys, label = 'Keyboard shortcuts' }: { keys: [string, string][]; label?: string }) {
  return (
    <div className="legend" aria-label={label}>
      {keys.map(([k, what]) => (
        <span key={k + what}>
          {k.split(' ').map((part) => (
            <Kbd key={part}>{part}</Kbd>
          ))}{' '}
          {what}
        </span>
      ))}
    </div>
  );
}

// ---------- Chip ----------

export function Chip({ tone = 'default', on, small, dot, title, className, children }: { tone?: Tone; on?: boolean; small?: boolean; dot?: string; title?: string; className?: string; children: React.ReactNode }) {
  return (
    <span className={cx('chip', on && 'on', small && 'small', tone !== 'default' && `tone-${tone}`, className)} title={title}>
      {dot && <span className="dot" style={{ background: dot }} />}
      {children}
    </span>
  );
}

// ---------- Tabs ----------

export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: { key: K; label: string; count?: number }[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={t.key === value} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && ` (${t.count})`}
        </button>
      ))}
    </div>
  );
}

// ---------- Navigation ----------

export type Section = 'library' | 'review' | 'jobs' | 'video';

/** The bar at the top of every page but the editor: the Studio's sections, the current one marked. */
export function Nav({ current, children }: { current: Section; children?: React.ReactNode }) {
  const link = (s: Section, href: string, label: string) => (
    <a href={href} aria-current={current === s ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <nav className="nav" aria-label="Studio">
      <a className="brand" href="#/">
        Clip Studio
      </a>
      {link('library', '#/', 'Library')}
      {link('review', '#/review', 'Review')}
      {link('jobs', '#/jobs', 'Jobs')}
      {children && <span className="grow" />}
      {children}
    </nav>
  );
}

/** The editor's top bar. */
export const TopBar = ({ children }: { children: React.ReactNode }) => <div className="topbar">{children}</div>;

// ---------- Page, card, callout ----------

export function Page({ width, nav, children }: { width?: 'medium' | 'wide'; nav?: Section; children: React.ReactNode }) {
  return (
    <div className={cx('page', width)}>
      {nav && <Nav current={nav} />}
      {children}
    </div>
  );
}

export function Callout({ tone = 'default', title, className, children }: { tone?: Tone; title?: React.ReactNode; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cx('callout', tone !== 'default' && `tone-${tone}`, className)}>
      {title && <div className="callout-title">{title}</div>}
      {children}
    </div>
  );
}

// ---------- Field ----------

/** A label tied to its control (the control gets the id), a value or action on the label's right, and a hint under it. */
export function Field({ label, aside, hint, children }: { label: React.ReactNode; aside?: React.ReactNode; hint?: React.ReactNode; children: React.ReactElement<{ id?: string }> }) {
  const id = useId();
  const control = isValidElement(children) ? cloneElement(children, { id: children.props.id ?? id }) : children;
  return (
    <div className="field">
      <label htmlFor={children.props.id ?? id}>
        <span>{label}</span>
        {aside}
      </label>
      {control}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

// ---------- Selectable rows ----------

/** A row the keyboard can reach: Enter or Space does what a click does. For rows that hold their own links or buttons (a <button> cannot). */
export function useRowKeys(onActivate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

// ---------- Page states ----------

/** Loading, empty and error look the same on every page; an error can offer a retry. */
export function PageState({ kind, children, onRetry }: { kind: 'loading' | 'empty' | 'error'; children?: React.ReactNode; onRetry?: () => void }) {
  return (
    <div className={cx('page-state', kind === 'error' && 'error')} role={kind === 'error' ? 'alert' : 'status'}>
      {children ?? (kind === 'loading' ? 'Loading…' : kind === 'empty' ? 'Nothing here yet.' : 'Something went wrong.')}
      {onRetry && (
        <Button className="retry" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ---------- Thumbnails ----------

/** A video's thumbnail (YouTube or Twitch, through the server); a plain box if it has none. */
export function Thumb({ videoId }: { videoId: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return <span className="thumb empty-thumb">no picture</span>;
  return <img className="thumb" src={`/api/videos/${videoId}/thumbnail`} alt="" width={96} height={54} loading="lazy" onError={() => setFailed(true)} />;
}
