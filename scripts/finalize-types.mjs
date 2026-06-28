import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const source = path.resolve('dist', 'src', 'index.d.ts');
const target = path.resolve('dist', 'index.d.ts');

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);

console.log('wrote dist/index.d.ts');
