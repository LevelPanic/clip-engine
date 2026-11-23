// A tiny local file server (with Range support) so the renderer's browser can load media.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

/** routes: URL prefix → file or directory. */
export function serveFiles(routes: Record<string, string>): Promise<{ base: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const prefix = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((p) => url === p || url.startsWith(p.endsWith('/') ? p : p + '/'));
    if (!prefix) return void res.writeHead(404).end();
    const target = routes[prefix];
    const file = fs.statSync(target).isDirectory() ? path.join(target, url.slice(prefix.length)) : target;
    if (!file.startsWith(target) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.writeHead(404).end();
    const size = fs.statSync(file).size;
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size });
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}
