// The creators the watchlist follows: `channels.json` next to the code (copy `channels.example.json` to
// start). It is the operator's own list, so it is not in the repo; without it the watchlist follows no
// creators (only topics.json) instead of crashing or picking someone to clip. Node only.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths';

export type Creator = {
  name: string;
  platform: 'twitch' | 'youtube';
  handle: string;
  /** YouTube only: watch the /streams tab (live + past broadcasts) instead of uploads. */
  source?: 'streams' | 'videos';
  /** What the channel is. Edited channels are skipped unless AUTO_EDITED=1. */
  content?: 'stream' | 'podcast' | 'edited';
  /** YouTube uploads shorter than this are edited clips/Shorts. */
  minMinutes?: number;
};

export const creatorsFile = () => path.join(paths.root, 'channels.json');

/** The creator list, or an empty one when there is no channels.json (`onMissing` hears why). */
export function loadCreators(onMissing: (why: string) => void = () => {}, file = creatorsFile()): Creator[] {
  if (!fs.existsSync(file)) {
    onMissing(`no ${path.basename(file)}: following no creators (copy channels.example.json to channels.json to add some)`);
    return [];
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Creator[];
}
