// The design tokens canvas and SVG code needs as values (CSS variables do not reach a canvas). The rest
// are CSS variables in tokens.css.

/** One colour per discovery signal, used by the signal strip and the candidate list. */
export const SIGNAL_COLORS: Record<string, string> = {
  comments: '#60a5fa',
  chat: '#22d3ee',
  clips: '#e879f9',
  laughter: '#facc15',
  teaser: '#f472b6',
  heatmap: '#34d399',
  audio: '#f87171',
  speech: '#a78bfa',
  title: '#fb923c',
};

/** The waveform under the timeline (canvas). */
export const WAVE_COLOR = '#4b5470';
