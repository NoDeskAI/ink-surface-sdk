import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CLASSROOM_FILES = new Set(['teacher-classroom.html', 'student-classroom.html']);
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function launcher(): string {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>InkLoop 双 Web 课堂</title><style>body{font:16px/1.6 system-ui;background:#f4efe5;color:#183a36;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:36rem;padding:2.5rem}a{display:block;margin:.75rem 0;padding:1rem 1.25rem;border:1px solid #2a6f66;border-radius:.6rem;color:inherit;text-decoration:none;background:#fff}small{color:#64726e}</style><main><h1>InkLoop 双 Web 课堂</h1><p>请选择当前设备角色。教师端会在你点击开始声音后请求麦克风；学生端只接收声音。</p><a href="/teacher-classroom.html"><b>教师讲课端</b><br><small>课本、板书、单向音频与录音</small></a><a href="/student-classroom.html"><b>学生学习端</b><br><small>跟随课本、同步板书与接收老师声音</small></a></main></html>';
}

export function createClassroomStaticHandler(distRoot: string): (req: IncomingMessage, res: ServerResponse) => boolean {
  const root = resolve(distRoot);
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://classroom.local').pathname); } catch { return false; }
    if (pathname === '/classroom' || pathname === '/classroom/') {
      const body = launcher(); res.statusCode = 200; res.setHeader('content-type', CONTENT_TYPES['.html']); res.setHeader('cache-control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : body); return true;
    }
    const relative = normalize(pathname).replace(/^[/\\]+/, '');
    const allowed = CLASSROOM_FILES.has(relative) || relative.startsWith('assets/') || relative.startsWith('cmaps/') || relative.startsWith('standard_fonts/');
    if (!allowed || relative.includes('..')) return false;
    const path = resolve(join(root, relative));
    if (!path.startsWith(`${root}/`) || !existsSync(path) || !statSync(path).isFile()) return false;
    res.statusCode = 200; res.setHeader('content-type', CONTENT_TYPES[extname(path)] || 'application/octet-stream'); res.setHeader('cache-control', CLASSROOM_FILES.has(relative) ? 'no-store' : 'public, max-age=31536000, immutable');
    if (req.method === 'HEAD') res.end(); else createReadStream(path).pipe(res);
    return true;
  };
}
