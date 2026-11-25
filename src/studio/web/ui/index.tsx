// The Studio's UI components: one way to draw a button, a key hint, a chip, tabs, a nav bar, a page, a
// callout, a field, a row you can select, and a loading/empty/error state. Styles are in ui.css and read
// only the tokens in tokens.css. A page builds from these instead of inline styles and one-off classes.
import React, { cloneElement, createContext, isValidElement, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

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

/** The keys a page answers to, in one format everywhere: `[['A', 'approve'], ['R', 'reject']]`; `stacked` is one per line (in a popover). */
export function ShortcutLegend({ keys, label = 'Keyboard shortcuts', stacked }: { keys: [string, string][]; label?: string; stacked?: boolean }) {
  return (
    <div className={cx('legend', stacked && 'stacked')} aria-label={label}>
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
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Navigation ----------

export type Section = 'library' | 'review' | 'jobs' | 'settings' | 'video';

/** What the app puts at the right end of every nav bar (the watchlist's switch), set once in App.tsx. */
export const NavEnd = createContext<React.ReactNode>(null);

/** The Studio's sections, and one line on each that the nav shows when you rest on it (pages keep the space for the work). */
const SECTIONS: { key: Section; href: string; label: string; about: string }[] = [
  { key: 'library', href: '#/', label: 'Library', about: 'The videos and streams the engine has read, and the clips made from them.' },
  { key: 'review', href: '#/review', label: 'Review', about: 'Watch each clip and decide with one key. Approved clips go to the upload line.' },
  { key: 'jobs', href: '#/jobs', label: 'Jobs', about: 'Renders, downloads and other Studio work, newest first.' },
  { key: 'settings', href: '#/settings', label: 'Settings', about: 'How the channel uploads: how many a day, how far apart, the posting hours, and a pause.' },
];

/** The bar at the top of every page but the editor: the Studio's sections, the current one marked. */
export function Nav({ current, children }: { current: Section; children?: React.ReactNode }) {
  const end = useContext(NavEnd);
  const base = useId();
  return (
    <nav className="nav" aria-label="Studio">
      <a className="brand" href="#/">
        <span className="mark" aria-hidden="true" />
        <span className="brand-name">Clip Studio</span>
      </a>
      {SECTIONS.map(({ key, href, label, about }) => (
        <span key={key} className="nav-item">
          <a href={href} aria-current={current === key ? 'page' : undefined} aria-describedby={`${base}-${key}`}>
            {label}
          </a>
          <span className="nav-pop" role="tooltip" id={`${base}-${key}`}>
            {about}
          </span>
        </span>
      ))}
      {(children || end) && <span className="grow" />}
      {children}
      {end}
    </nav>
  );
}

/** A button that opens a small panel under it (a page's keyboard shortcuts); Esc or a click elsewhere closes it. */
export function Popover({
  trigger,
  label,
  open,
  onOpenChange,
  align = 'right',
  small,
  children,
}: {
  trigger: React.ReactNode;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which edge of the button the panel lines up with. */
  align?: 'left' | 'right';
  small?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  // fixed to the screen under its button, so a scrolling panel around it cannot clip it
  const [pos, setPos] = useState<React.CSSProperties>();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos(align === 'left' ? { top: r.bottom + 6, left: Math.max(8, r.left) } : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, onOpenChange]);
  return (
    <span className="popover-anchor" ref={ref}>
      <Button variant="ghost" className={cx(small && 'small-button')} aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)}>
        {trigger}
      </Button>
      {open && (
        <div className="popover" style={pos} id={id} role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </span>
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

/** A page's heading: its title, one line on what it is for, and the page's own actions on the right. */
export function PageHead({ title, description, children }: { title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children}
    </header>
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

/**
 * A row the keyboard can reach: Enter or Space does what a click does. For rows that hold their own links
 * or buttons (a <button> cannot). The key stops at the row, so a page's own shortcut for it (Enter to
 * edit, Space to play) does not fire as well.
 */
export function rowKeys(onActivate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
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
  return <img className="thumb" src={`/api/videos/${videoId}/thumbnail`} alt="" width={112} height={63} loading="lazy" onError={() => setFailed(true)} />;
}

// ---------- Copy ----------

/** Copies text to the clipboard and says so for a moment. */
export function CopyButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cx(small && 'ghost small-button')}
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
