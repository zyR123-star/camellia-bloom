/**
 * 零依赖静态服务器
 * ---------------------------------------------------------------
 * 摄像头 API 只在「安全上下文」可用：https 或 localhost。
 * 所以必须走 HTTP 服务，直接双击 index.html（file://）是不行的。
 *
 *   node serve.mjs           → http://localhost:5173
 *   node serve.mjs 8080      → 指定端口
 *   node serve.mjs 8080 lan  → 绑定 0.0.0.0，手机同网段可访问
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const HOST = process.argv[3] === 'lan' ? '0.0.0.0' : '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // 防目录穿越
    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    const filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && filePath !== ROOT) {
      res.writeHead(403).end('403 Forbidden');
      return;
    }

    let target = filePath;
    const info = await stat(target).catch(() => null);
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    if (info.isDirectory()) target = join(target, 'index.html');

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
      // 摄像头在 localhost 已属安全上下文；如需局域网手机调试可用 https 反代
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`500 ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  const lines = [`  白山茶 · 手控绽放 已启动`, ``, `  本机   http://localhost:${PORT}`];
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) {
          lines.push(`  局域网 http://${net.address}:${PORT}`);
        }
      }
    }
    lines.push(``, `  注意：手机通过局域网 IP 访问时不是安全上下文，`);
    lines.push(`        部分浏览器会禁用摄像头，建议用 localhost 或 https。`);
  }
  lines.push(``, `  Ctrl+C 停止`);
  console.log(lines.join('\n'));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用，换一个：node serve.mjs ${PORT + 1}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
