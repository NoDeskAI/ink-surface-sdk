import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const host = process.env.INKLOOP_DEMO_HOST || '127.0.0.1';
const preferredPort = Number.parseInt(process.env.INKLOOP_DEMO_PORT || '8765', 10);
const maxPort = preferredPort + 24;

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function choosePort() {
  for (let port = preferredPort; port <= maxPort; port += 1) {
    if (await canListen(port)) return port;
  }
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('failed to allocate a demo port'));
      });
    });
  });
}

const port = await choosePort();
const url = `http://${host}:${port}/ai-pen-demo.html`;

console.log(`InkLoop AI Pen V1 demo: ${url}`);
if (port !== preferredPort) {
  console.log(`Port ${preferredPort} is in use; using ${port} for this run.`);
}

const child = spawn('npm', [
  '--workspace',
  './examples/ai-annotation-demo',
  'run',
  'dev',
  '--',
  '--host',
  host,
  '--port',
  String(port),
  '--strictPort',
], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

function stop(signal) {
  if (!child.killed) child.kill(signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
