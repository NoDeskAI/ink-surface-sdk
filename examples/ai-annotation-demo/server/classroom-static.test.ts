import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createClassroomStaticHandler } from './classroom-static';

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve())); server = null;
});

describe('secure classroom static handler', () => {
  it('serves only the built teacher/student classroom and their assets from the API origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'classroom-static-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'teacher-classroom.html'), '<main>teacher</main>');
    await writeFile(join(root, 'student-classroom.html'), '<main>student</main>');
    await writeFile(join(root, 'assets', 'classroom.js'), 'export {};');
    await writeFile(join(root, 'index.html'), '<main>unrelated app</main>');
    const handler = createClassroomStaticHandler(root);
    server = createServer((req, res) => { if (!handler(req, res)) { res.statusCode = 404; res.end('not found'); } });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    const base = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${base}/classroom`)).text()).toContain('teacher-classroom.html');
    expect(await (await fetch(`${base}/teacher-classroom.html`)).text()).toContain('teacher');
    expect((await fetch(`${base}/assets/classroom.js`)).headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
  });
});
