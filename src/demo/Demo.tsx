import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

const W = 1920;
const H = 1080;
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const COLORS = {
  bg: '#07080d',
  panel: '#12141c',
  panel2: '#171a24',
  border: '#262a3a',
  text: '#f5f5f7',
  muted: '#9aa0b4',
  cyan: '#25f4ee',
  red: '#fe2c55',
  green: '#35d07f',
  yellow: '#ffd166',
};

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const fade = (f: number, start: number, len = 18) => interpolate(f, [start, start + len], [0, 1], clamp);
const rise = (f: number, start: number, len = 24) => interpolate(f, [start, start + len], [18, 0], clamp);
const pulse = (f: number, at: number) => interpolate(f, [at, at + 6, at + 18], [0, 1, 0], clamp);

const Pill: React.FC<{ children: React.ReactNode; color?: string; dim?: boolean }> = ({ children, color = COLORS.cyan, dim }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 999, background: dim ? '#1b1e29' : `${color}18`, border: `1px solid ${dim ? COLORS.border : `${color}55`}`, color: dim ? COLORS.muted : color, fontSize: 14, fontWeight: 700, letterSpacing: '.02em' }}>{children}</span>
);

const Button: React.FC<{ children: React.ReactNode; primary?: boolean; ghost?: boolean; width?: number; small?: boolean }> = ({ children, primary, ghost, width, small }) => (
  <div style={{ width, height: small ? 46 : 56, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, background: primary ? COLORS.red : ghost ? 'transparent' : '#242838', border: ghost ? `1px solid ${COLORS.border}` : 'none', color: primary ? '#fff' : COLORS.text, fontSize: small ? 15 : 17, fontWeight: 750, boxShadow: primary ? '0 12px 34px #fe2c5540' : 'none' }}>{children}</div>
);

const Toggle: React.FC<{ on?: boolean }> = ({ on }) => (
  <div style={{ width: 42, height: 24, borderRadius: 99, background: on ? COLORS.cyan : '#2c3144', display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', padding: 3 }}>
    <div style={{ width: 18, height: 18, borderRadius: 99, background: on ? '#071018' : '#9aa0b4' }} />
  </div>
);

const Cursor: React.FC<{ x: number; y: number; click?: number }> = ({ x, y, click }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: 34, height: 34, pointerEvents: 'none', zIndex: 50 }}>
    <svg width="30" height="30" viewBox="0 0 24 24" style={{ filter: 'drop-shadow(0 4px 8px #000a)' }}>
      <path d="M3 2l18 9-8.2 2.1L9 22 3 2Z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
    {click !== undefined && click > 0 && (
      <div style={{ position: 'absolute', left: -8, top: -8, width: 40, height: 40, borderRadius: 999, border: `3px solid ${COLORS.cyan}`, opacity: click * 0.9, transform: `scale(${0.7 + click * 0.8})` }} />
    )}
  </div>
);

const Row: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, padding: '13px 0', borderBottom: `1px solid ${COLORS.border}` }}>
    <div>
      <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>{label}</div>
      {hint && <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 3 }}>{hint}</div>}
    </div>
    {children}
  </div>
);

const Field: React.FC<{ label: string; value: string; multiline?: boolean }> = ({ label, value, multiline }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 7, textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 750 }}>{label}</div>
    <div style={{ minHeight: multiline ? 72 : 46, display: 'flex', alignItems: 'center', padding: '0 14px', borderRadius: 10, background: '#0d0f17', border: `1px solid ${COLORS.border}`, color: COLORS.text, fontSize: 15, lineHeight: 1.45 }}>{value}</div>
  </div>
);

const AppShell: React.FC<{ f: number; children: React.ReactNode; connected?: boolean; active?: string }> = ({ f, children, connected, active = 'Post' }) => (
  <div style={{ position: 'absolute', left: 100, top: 70, width: 1720, height: 940, borderRadius: 24, overflow: 'hidden', background: COLORS.panel, border: `1px solid ${COLORS.border}`, boxShadow: '0 40px 120px #000a', opacity: fade(f, 0, 24), transform: `translateY(${interpolate(f, [0, 24], [22, 0], clamp)}px)` }}>
    <div style={{ height: 58, background: '#0e1018', borderBottom: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', padding: '0 22px', gap: 12 }}>
      <div style={{ display: 'flex', gap: 7 }}>{['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 11, height: 11, borderRadius: 99, background: c }} />)}</div>
      <div style={{ marginLeft: 16, fontWeight: 800, letterSpacing: '-.02em', fontSize: 17 }}>Clip Engine</div>
      <Pill color={COLORS.yellow} dim>Sandbox</Pill>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, color: COLORS.muted, fontSize: 13 }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: connected ? COLORS.green : COLORS.yellow }} />
        {connected ? 'TikTok connected · null_clipper' : 'TikTok not connected'}
      </div>
    </div>
    <div style={{ display: 'flex', height: 882 }}>
      <div style={{ width: 280, borderRight: `1px solid ${COLORS.border}`, padding: '24px 18px', background: '#0d0f17' }}>
        <div style={{ fontSize: 12, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '.1em', fontWeight: 800, marginBottom: 14 }}>Review queue</div>
        {[
          ['Lacy — LA uniform', '32s · TikTok'],
          ['Lacy — BMW X6M', '59s · TikTok'],
          ['Lacy — did I scare ya', '16s · TikTok'],
        ].map(([title, meta], i) => (
          <div key={title} style={{ borderRadius: 12, padding: '12px 12px', marginBottom: 8, background: i === 0 ? '#1a1e2b' : 'transparent', border: `1px solid ${i === 0 ? COLORS.border : 'transparent'}` }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: i === 0 ? COLORS.text : COLORS.muted }}>{title}</div>
            <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 4 }}>{meta}</div>
          </div>
        ))}
        <div style={{ height: 1, background: COLORS.border, margin: '18px 0' }} />
        <div style={{ fontSize: 12, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '.1em', fontWeight: 800, marginBottom: 12 }}>Publish</div>
        {['Post', 'Inbox draft', 'Scopes'].map((x) => (
          <div key={x} style={{ padding: '10px 12px', borderRadius: 10, color: active === x ? COLORS.text : COLORS.muted, background: active === x ? '#1a1e2b' : 'transparent', fontSize: 14, fontWeight: 650, marginBottom: 4 }}>{x}</div>
        ))}
      </div>
      <div style={{ flex: 1, padding: '28px 34px', position: 'relative' }}>{children}</div>
    </div>
  </div>
);

const Preview: React.FC = () => (
  <div style={{ width: 340, flexShrink: 0 }}>
    <div style={{ fontSize: 12, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '.1em', fontWeight: 800, marginBottom: 10 }}>Preview</div>
    <div style={{ width: 340, height: 604, borderRadius: 22, overflow: 'hidden', border: `1px solid #303548`, background: '#000', position: 'relative', boxShadow: '0 20px 50px #0008' }}>
      <Img src={staticFile('clip.jpg')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <div style={{ position: 'absolute', left: 14, right: 14, bottom: 16, padding: '10px 12px', borderRadius: 12, background: '#000b', color: '#fff', fontSize: 14, fontWeight: 700 }}>They gave the UK guy the LA UNIFORM 💀</div>
      <div style={{ position: 'absolute', top: 14, left: 14 }}><Pill color={COLORS.cyan}>9:16</Pill></div>
    </div>
  </div>
);

const Compose: React.FC<{ f: number; connected: boolean; inbox?: boolean }> = ({ f, connected, inbox }) => (
  <div style={{ display: 'flex', gap: 36, opacity: fade(f, 0, 16) }}>
    <Preview />
    <div style={{ flex: 1, paddingTop: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <Pill color={COLORS.cyan}>Content Posting API</Pill>
        <Pill color={COLORS.green} dim>Login Kit connected</Pill>
      </div>
      <div style={{ fontSize: 28, fontWeight: 850, letterSpacing: '-.03em', marginBottom: 4 }}>Publish to TikTok</div>
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 18 }}>Connected as <b style={{ color: COLORS.text }}>null_clipper</b> · sandbox</div>
      <Field label="Title" value="They gave the UK guy the LA UNIFORM 💀" />
      <Field label="Caption + hashtags" value={'The UK guy gets the full LA fit.\n#Lacy #JustChatting #shorts'} multiline />
      <Row label="Privacy" hint="Only me — SELF_ONLY (private)">
        <div style={{ minWidth: 250, height: 44, borderRadius: 9, border: `1px solid ${COLORS.cyan}88`, background: '#0d1a1e', color: COLORS.cyan, display: 'flex', alignItems: 'center', padding: '0 12px', fontSize: 14, fontWeight: 700 }}>Private · SELF_ONLY</div>
      </Row>
      <Row label="Allow comments / Duet / Stitch" hint="Off by default">
        <div style={{ display: 'flex', gap: 10 }}><Toggle /><Toggle /><Toggle /></div>
      </Row>
      <Row label="Commercial content" hint="Off by default">
        <Toggle />
      </Row>
      <div style={{ display: 'flex', gap: 12, marginTop: 22, alignItems: 'center' }}>
        <Button primary width={320}>{inbox ? 'Save to TikTok inbox' : 'Post to TikTok'}</Button>
        {!inbox && <Button ghost width={210}>Save to inbox</Button>}
        <div style={{ fontSize: 12, color: COLORS.muted }}>{inbox ? 'video.upload · draft' : 'video.publish · direct'}</div>
      </div>
      {connected && <div style={{ position: 'absolute', right: 0, top: 0 }}><Pill color={COLORS.green}>Ready</Pill></div>}
    </div>
  </div>
);

export const TikTokDemo: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const phase = f < 70 ? 'connect' : f < 150 ? 'oauth' : f < 210 ? 'connected' : f < 420 ? 'compose' : f < 520 ? 'consent' : f < 620 ? 'posting' : f < 720 ? 'inbox' : 'summary';
  const [cursor, setCursor] = React.useState({ x: 1480, y: 690, click: 0 });
  React.useEffect(() => {
    const c =
      phase === 'connect' ? { x: 1280 + Math.sin(f / 9) * 18, y: 690 + Math.cos(f / 11) * 10, click: f > 48 ? pulse(f, 48) : 0 } :
      phase === 'oauth' ? { x: 1030 + Math.sin(f / 8) * 12, y: 760, click: f > 115 ? pulse(f, 115) : 0 } :
      phase === 'compose' ? { x: 1200 + Math.sin(f / 10) * 14, y: 690 + Math.cos(f / 9) * 8, click: f > 380 ? pulse(f, 380) : 0 } :
      phase === 'consent' ? { x: 1120, y: 720, click: f > 475 ? pulse(f, 475) : 0 } :
      phase === 'posting' ? { x: 1120, y: 650, click: 0 } :
      phase === 'inbox' ? { x: 1300, y: 760, click: f > 665 ? pulse(f, 665) : 0 } : { x: 1700, y: 980, click: 0 };
    setCursor(c);
  }, [f, phase]);
  const progress = interpolate(f, [520, 590], [0, 100], clamp);
  const settled = spring({ frame: f - 590, fps, config: { damping: 18, stiffness: 140 } });

  return (
    <AbsoluteFill style={{ background: COLORS.bg, fontFamily: FONT, color: COLORS.text }}>
      <AbsoluteFill style={{ background: `radial-gradient(900px 600px at 15% 0%, #25f4ee14, transparent 65%), radial-gradient(800px 600px at 90% 15%, #fe2c5514, transparent 65%)` }} />
      <div style={{ position: 'absolute', left: 60, top: 28, display: 'flex', alignItems: 'center', gap: 12, opacity: 0.9 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: `linear-gradient(135deg, ${COLORS.cyan}, ${COLORS.red})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, color: '#08090e' }}>C</div>
        <div style={{ fontSize: 18, fontWeight: 850, letterSpacing: '-.02em' }}>Clip Engine</div>
        <Pill color={COLORS.yellow} dim>TikTok Sandbox demo</Pill>
      </div>

      <AppShell f={f} connected={phase !== 'connect' && phase !== 'oauth'} active={phase === 'inbox' ? 'Inbox draft' : phase === 'summary' ? 'Scopes' : 'Post'}>
        {(phase === 'connect' || phase === 'oauth') && (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: fade(f, 0, 20) }}>
            <div style={{ width: 680, textAlign: 'center' }}>
              <div style={{ fontSize: 16, color: COLORS.cyan, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 12 }}>Login Kit · Content Posting API</div>
              <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-.04em', marginBottom: 10 }}>Connect TikTok to publish</div>
              <div style={{ fontSize: 17, color: COLORS.muted, lineHeight: 1.5, marginBottom: 26 }}>Authorize your own creator account, preview the clip, and choose whether it goes to your inbox or posts directly.</div>
              <Button primary width={320}>Connect TikTok</Button>
              <div style={{ marginTop: 18, fontSize: 12, color: COLORS.muted }}>You will be redirected to TikTok. Clip Engine never sees your password.</div>
            </div>
          </div>
        )}

        {phase === 'oauth' && (
          <div style={{ position: 'absolute', inset: 0, background: '#05060bcc', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30, opacity: fade(f, 85, 16) }}>
            <div style={{ width: 760, borderRadius: 20, background: COLORS.panel2, border: `1px solid ${COLORS.border}`, padding: '28px 32px', boxShadow: '0 30px 100px #000c' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                <div style={{ fontSize: 14, color: COLORS.muted, fontWeight: 700 }}>TIKTOK AUTHORIZATION</div>
                <Pill color={COLORS.yellow} dim>Sandbox</Pill>
              </div>
              <div style={{ fontSize: 26, fontWeight: 850, letterSpacing: '-.03em', marginBottom: 8 }}>Authorize Clip Engine</div>
              <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 20 }}>Clip Engine is requesting access to:</div>
              {[
                ['user.info.basic', 'Your open ID, display name and avatar'],
                ['video.upload', 'Send drafts to your TikTok inbox'],
                ['video.publish', 'Post directly after you confirm'],
              ].map(([scope, desc]) => (
                <div key={scope} style={{ display: 'flex', gap: 12, padding: '12px 0', borderTop: `1px solid ${COLORS.border}` }}>
                  <div style={{ width: 22, height: 22, borderRadius: 6, background: COLORS.cyan, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#071018', fontWeight: 900, fontSize: 13 }}>✓</div>
                  <div><div style={{ fontWeight: 800, fontSize: 15 }}>{scope}</div><div style={{ fontSize: 13, color: COLORS.muted, marginTop: 2 }}>{desc}</div></div>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 12, marginTop: 22, justifyContent: 'flex-end' }}>
                <Button ghost width={130} small>Cancel</Button>
                <Button primary width={220} small>Authorize</Button>
              </div>
            </div>
          </div>
        )}

        {phase === 'connected' && (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: fade(f, 145, 16) }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 74, height: 74, borderRadius: 99, background: '#123126', border: `1px solid ${COLORS.green}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', color: COLORS.green, fontSize: 34, fontWeight: 900 }}>✓</div>
              <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: '-.03em' }}>TikTok connected</div>
              <div style={{ fontSize: 16, color: COLORS.muted, marginTop: 6 }}>null_clipper · sandbox account</div>
              <div style={{ marginTop: 22 }}><Pill color={COLORS.green}>Login Kit complete</Pill></div>
            </div>
          </div>
        )}

        {phase === 'compose' && <Compose f={f} connected />}

        {phase === 'consent' && (
          <div style={{ position: 'absolute', inset: 0, background: '#05060bcc', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 30, opacity: fade(f, 420, 16) }}>
            <div style={{ width: 700, borderRadius: 20, background: COLORS.panel2, border: `1px solid ${COLORS.border}`, padding: '30px 34px', boxShadow: '0 30px 100px #000c' }}>
              <div style={{ fontSize: 14, color: COLORS.muted, fontWeight: 750, marginBottom: 12 }}>POST TO TIKTOK</div>
              <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-.03em', marginBottom: 12 }}>Post privately?</div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 16px', borderRadius: 12, background: '#0d0f17', border: `1px solid ${COLORS.border}`, marginBottom: 18 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: '#252a3a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>🔒</div>
                <div><div style={{ fontWeight: 800 }}>Private · SELF_ONLY</div><div style={{ fontSize: 13, color: COLORS.muted }}>Only you can see this post until you change it to Everyone.</div></div>
              </div>
              <div style={{ fontSize: 13, color: COLORS.muted, lineHeight: 1.55, marginBottom: 22 }}>By posting, you agree to TikTok’s <span style={{ color: COLORS.cyan }}>Music Usage Confirmation</span>. Processing can take a few minutes.</div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}><Button ghost width={130} small>Cancel</Button><Button primary width={230} small>Publish privately</Button></div>
            </div>
          </div>
        )}

        {phase === 'posting' && (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: fade(f, 505, 16) }}>
            <div style={{ width: 680 }}>
              <div style={{ fontSize: 14, color: COLORS.muted, fontWeight: 750, marginBottom: 10 }}>CONTENT POSTING API</div>
              <div style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-.03em' }}>{progress < 100 ? 'Uploading to TikTok…' : 'Posted privately'}</div>
              <div style={{ height: 12, borderRadius: 99, background: '#232738', overflow: 'hidden', margin: '22px 0 12px' }}>
                <div style={{ width: `${progress}%`, height: '100%', background: `linear-gradient(90deg, ${COLORS.cyan}, ${COLORS.red})` }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: COLORS.muted, fontSize: 13 }}><span>{Math.round(progress)}%</span><span>{progress < 100 ? 'uploading chunks' : 'SELF_ONLY · private'}</span></div>
              {progress >= 100 && (
                <div style={{ marginTop: 24, opacity: settled, transform: `scale(${0.9 + settled * 0.1})`, padding: '16px 18px', borderRadius: 14, background: '#0f2a20', border: `1px solid ${COLORS.green}55`, display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{ width: 34, height: 34, borderRadius: 99, background: COLORS.green, color: '#06120d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900 }}>✓</div>
                  <div><div style={{ fontWeight: 850 }}>Posted to null_clipper</div><div style={{ fontSize: 13, color: COLORS.muted }}>Private post · video.publish</div></div>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === 'inbox' && (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: fade(f, 615, 16) }}>
            <div style={{ width: 720, textAlign: 'center' }}>
              <Pill color={COLORS.cyan}>video.upload</Pill>
              <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: '-.03em', margin: '14px 0 8px' }}>Or save a draft to the inbox</div>
              <div style={{ fontSize: 15, color: COLORS.muted, lineHeight: 1.5, marginBottom: 24 }}>The creator can finish the post inside TikTok with the normal editor.</div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}><Button primary width={300}>Save to TikTok inbox</Button><Button ghost width={180}>Skip</Button></div>
              <div style={{ marginTop: 22, fontSize: 13, color: COLORS.green, opacity: f > 690 ? 1 : 0 }}>✓ Draft sent to TikTok inbox</div>
            </div>
          </div>
        )}

        {phase === 'summary' && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', opacity: fade(f, 715, 20) }}>
            <div style={{ fontSize: 15, color: COLORS.cyan, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 10 }}>What this demo shows</div>
            <div style={{ fontSize: 38, fontWeight: 900, letterSpacing: '-.04em', marginBottom: 26 }}>Login Kit + Content Posting API</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {[
                ['Login Kit', 'user.info.basic', 'Connect the creator and show the account.'],
                ['Content Posting API', 'video.upload', 'Send a draft to the TikTok inbox.'],
                ['Content Posting API', 'video.publish', 'Post directly after explicit consent.'],
                ['Sandbox', 'creator-authorized', 'No third-party content. No posting without confirmation.'],
              ].map(([title, scope, desc]) => (
                <div key={title + scope} style={{ padding: '18px 18px', borderRadius: 14, background: '#10131c', border: `1px solid ${COLORS.border}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}><span style={{ fontWeight: 850 }}>{title}</span><Pill color={COLORS.cyan} dim>{scope}</Pill></div>
                  <div style={{ fontSize: 13, color: COLORS.muted, lineHeight: 1.45 }}>{desc}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ width: 30, height: 30, borderRadius: 9, background: `linear-gradient(135deg, ${COLORS.cyan}, ${COLORS.red})` }} /><span style={{ fontWeight: 850 }}>Clip Engine</span><span style={{ color: COLORS.muted, fontSize: 13 }}>creator-authorized TikTok publishing</span></div>
              <Pill color={COLORS.yellow} dim>TikTok Sandbox</Pill>
            </div>
          </div>
        )}
      </AppShell>

      {(() => {
        const t = cursor;
        return <Cursor x={t.x} y={t.y} click={t.click} />;
      })()}

      <div style={{ position: 'absolute', right: 60, bottom: 28, color: COLORS.muted, fontSize: 12, letterSpacing: '.02em' }}>Clip Engine · TikTok for Developers demo</div>
    </AbsoluteFill>
  );
};
