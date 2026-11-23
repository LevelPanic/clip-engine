// Render, logins and publishing: render, auth, TikTok, YouTube, analytics, QA.
import type { Command } from 'commander';
import { type Action } from './shared';

export function register(program: Command, action: Action) {
  // ---------- render & studio ----------

  program
    .command('render <clipId>')
    .description('Render exports/<clipId>.mp4 (1080×1920, H.264/AAC)')
    .option('--wait', 'wait for the video download if it is still running')
    .option('--keep-layout', 'a split whose camera band has no face is reported, not switched to blur-fit')
    .action(
      action(async (clipId: string, o: { wait?: boolean; keepLayout?: boolean }) => {
        const { renderClip } = await import('../render');
        await renderClip(clipId, { wait: !!o.wait, keepLayout: !!o.keepLayout });
        const { qaClip } = await import('../qa');
        const q = await qaClip(clipId);
        console.log(`QA ${q.passed ? 'passed' : 'FAILED'}${q.loudnessLufs !== null ? ` · ${q.loudnessLufs.toFixed(1)} LUFS` : ''}`);
        for (const i of q.issues) console.log(`  ${i.level === 'fail' ? '✖' : '·'} ${i.check}: ${i.detail}`);
      }),
    );

  program
    .command('auth <service>')
    .description('Connect a publishing account (youtube)')
    .action(
      action(async (service: string) => {
        if (service !== 'youtube') throw new Error(`Unknown service "${service}". Only youtube is supported.`);
        const { authYoutube } = await import('../publish/youtube');
        await authYoutube();
      }),
    );

  const tiktok = program.command('tiktok').description('Connect TikTok and upload a clip to the TikTok inbox draft');

  tiktok
    .command('auth')
    .description('Connect a TikTok account (desktop Login Kit + PKCE; needs tiktok_secrets.json)')
    .action(
      action(async () => {
        const { authTikTok } = await import('../publish/tiktok');
        const t = await authTikTok();
        console.log(`TikTok connected · open_id ${t.open_id} · scope ${t.scope}`);
      }),
    );

  tiktok
    .command('upload <clipId>')
    .description('Upload the export to the TikTok inbox as a draft; finish the post inside TikTok')
    .option('--force', 'upload again even if a TikTok record exists')
    .action(
      action(async (clipId: string, o: { force?: boolean }) => {
        const { uploadTikTokInbox } = await import('../publish/tiktok');
        const rec = await uploadTikTokInbox(clipId, { force: !!o.force, log: console.log });
        console.log(`TikTok inbox: ${rec.publishId} · ${rec.status}`);
      }),
    );

  tiktok
    .command('post <clipId>')
    .description('Direct Post as a private post (SELF_ONLY); needs video.publish and a private TikTok account')
    .option('--force', 'post again even if a direct-post record exists')
    .action(
      action(async (clipId: string, o: { force?: boolean }) => {
        const { directPostTikTok } = await import('../publish/tiktok');
        const rec = await directPostTikTok(clipId, { force: !!o.force, log: console.log });
        console.log(`TikTok direct: ${rec.publishId} · ${rec.status} · ${rec.privacy}`);
      }),
    );

  tiktok
    .command('status <publishId>')
    .description('Check a TikTok upload status')
    .action(
      action(async (publishId: string) => {
        const { tiktokStatus } = await import('../publish/tiktok');
        const r = await tiktokStatus(publishId);
        console.log(`${r.status}${r.fail ? ` · ${r.fail}` : ''}`);
      }),
    );

  program
    .command('publish <clipId>')
    .description('Publish an exported post-verdict clip to YouTube (scheduled private: +5 min, then +10, +15…)')
    .option('--privacy <status>', 'public, unlisted or private (only with --now)', 'unlisted')
    .option('--publish-at <iso>', 'schedule at this exact time instead of the next slot')
    .option('--now', 'upload immediately instead of scheduling')
    .option('--category <id>', 'YouTube category id', '20')
    .option('--force', 'publish even if the verdict or QA says not to')
    .option('--age-restricted', '18+: age-restricted on YouTube (default: the review decision)')
    .option('--no-age-restricted', 'not 18+, whatever the review decided')
    .action(
      action(async (clipId: string, o: { privacy: string; publishAt?: string; now?: boolean; category: string; force?: boolean; ageRestricted?: boolean }) => {
        const { publishYoutube } = await import('../publish/youtube');
        const rec = await publishYoutube(clipId, {
          privacy: o.privacy as 'public' | 'unlisted' | 'private',
          publishAt: o.publishAt,
          immediate: !!o.now,
          categoryId: o.category,
          force: !!o.force,
          ageRestricted: o.ageRestricted,
          log: console.log,
        });
        console.log(
          rec.heldPrivate
            ? `uploaded ${rec.url} private (18+): ${rec.heldPrivate}`
            : rec.publishAt
              ? `scheduled ${rec.url} for ${new Date(rec.publishAt).toLocaleString()} (private until then${rec.ageRestricted ? ', age-restricted' : ''})`
              : `posted ${rec.url} (${rec.privacy}${rec.ageRestricted ? ', age-restricted' : ''})`,
        );
      }),
    );

  program
    .command('analytics')
    .description('Import YouTube Analytics for published clips into the performance log')
    .option('--days <n>', 'date range ending today', '28')
    .option('--clip <id>', 'only this clip')
    .action(
      action(async (o: { days: string; clip?: string }) => {
        const { fetchPublishedAnalytics } = await import('../publish/analytics');
        const { appendPerformance } = await import('../review');
        const rows = await fetchPublishedAnalytics({ days: Number(o.days), clipId: o.clip });
        if (!rows.length) {
          console.log('no published clips yet; run `./clip publish <clipId>` first');
          return;
        }
        const usable = rows.filter((r) => r.views > 0);
        appendPerformance(
          usable.map((r) => ({
            clipId: r.clipId!,
            platform: 'youtube',
            views: r.views,
            engagedViews: r.engagedViews,
            avgViewPct: r.avgViewPct,
            avgViewDurationS: r.avgViewDurationS,
            likes: r.likes,
            comments: r.comments,
            shares: r.shares,
            subscribersGained: r.subscribersGained,
            stayedProxy: r.stayedProxy,
            outcome: r.outcome,
            importedAt: new Date().toISOString(),
          })),
        );
        for (const r of rows)
          console.log(
            r.views
              ? `${r.clipId}  views ${r.views} · engaged ${r.engagedViews} (${Math.round(r.stayedProxy * 100)}%) · avg ${r.avgViewPct.toFixed(1)}% · shares ${r.shares} · subs ${r.subscribersGained} · outcome ${r.outcome}`
              : `${r.clipId}  no analytics yet (YouTube lags 2–3 days)`,
          );
      }),
    );

  program
    .command('qa <clipId>')
    .description('Check an export: length, loudness, dead air, black frames, caption overflow, content risk')
    .action(
      action(async (clipId: string) => {
        const { qaClip } = await import('../qa');
        const q = await qaClip(clipId);
        console.log(`QA ${q.passed ? 'passed' : 'FAILED'} · ${q.durationS.toFixed(1)} s${q.loudnessLufs !== null ? ` · ${q.loudnessLufs.toFixed(1)} LUFS` : ''}`);
        for (const i of q.issues) console.log(`  ${i.level === 'fail' ? '✖' : '·'} ${i.check}: ${i.detail}`);
      }),
    );
}
