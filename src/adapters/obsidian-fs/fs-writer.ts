import { appendFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.inkloop.tmp`;
  const bak = `${filePath}.inkloop.bak`;
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, filePath);
  } catch (error) {
    const current = await readTextIfExists(filePath);
    if (current !== null) await writeFile(bak, current, 'utf8');
    try {
      await unlink(filePath);
    } catch {
      // File may not exist on the create path.
    }
    try {
      await rename(tmp, filePath);
      await rm(bak, { force: true });
    } catch (innerError) {
      if (current !== null) await writeFile(filePath, current, 'utf8');
      throw innerError instanceof Error ? innerError : error;
    }
  }
}

export async function readJsonIfExists<T>(filePath: string, fallback: T): Promise<T> {
  const text = await readTextIfExists(filePath);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}
