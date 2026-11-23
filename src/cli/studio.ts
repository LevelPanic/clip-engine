// The Studio: open it on a page, or serve it.
import fs from 'node:fs';
import type { Command } from 'commander';
import { STUDIO, type Action } from './shared';

export function register(program: Command, action: Action) {
  program
    .command('open [target]')
    .description('Open the Studio in the browser (starting it if needed): a video id → its candidates, a clip id → the editor, "review" → the review queue')
    .option('--no-browser', 'just make sure the Studio is running and print the link')
    .action(
      action(async (target: string | undefined, o: { browser: boolean }) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { spawn } = await import('node:child_process');
        const { paths } = await import('../core/paths');
        const up = () => fetch(`${STUDIO}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
        if (!(await up())) {
          fs.mkdirSync(paths.cache, { recursive: true });
          const logFile = path.join(paths.cache, 'studio.log');
          const out = fs.openSync(logFile, 'a');
          spawn(path.join(paths.root, 'clip'), ['studio'], { cwd: paths.root, detached: true, stdio: ['ignore', out, out] }).unref();
          process.stdout.write('starting the Studio');
          const until = Date.now() + 30_000;
          while (!(await up())) {
            if (Date.now() > until) throw new Error(`the Studio didn't start; see ${logFile}`);
            process.stdout.write('.');
            await new Promise((r) => setTimeout(r, 500));
          }
          console.log(` (log: ${path.relative(process.cwd(), logFile)})`);
        }
        const hash = !target
          ? ''
          : target === 'review' || target === 'jobs'
            ? `#/${target}`
            : fs.existsSync(paths.project(target))
              ? `#/clip/${target}`
              : fs.existsSync(paths.video(target))
                ? `#/video/${target}`
                : (() => {
                    throw new Error(`"${target}" is not a video id, a clip id, "review" or "jobs"`);
                  })();
        const url = `${STUDIO}/${hash}`;
        console.log(url);
        if (o.browser) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
      }),
    );

  program
    .command('studio')
    .description('Start the Studio (candidate review + editor) on http://localhost:4400')
    .option('--port <port>', 'port', '4400')
    .action(
      action(async (o: { port: string }) => {
        const { startStudio } = await import('../studio/server');
        await startStudio(Number(o.port));
      }),
    );
}
