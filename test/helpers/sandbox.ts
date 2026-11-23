// A throwaway data folder (library/, clips/, exports/) for tests. Must be imported before any module
// that reads paths, because paths are fixed at import time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-engine-test-'));
process.env.CLIP_DATA = DATA;
process.on('exit', () => fs.rmSync(DATA, { recursive: true, force: true }));
