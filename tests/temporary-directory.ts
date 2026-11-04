import type { TestContext } from 'node:test';
import { mkdir, mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export async function temporaryDirectory(t: TestContext) {
  const base = resolve(root, '.artifacts/tests');
  let directory: string | undefined;
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const fn of cleanup.reverse()) try { await fn(); } catch (e) { errors.push(e); }
    if (directory) {
      if (dirname(resolve(directory)) !== base || resolve(await realpath(base)) !== base || (await lstat(directory)).isSymbolicLink())
        throw Error('Unsafe test cleanup target');
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
  });
  await mkdir(base, { recursive: true });
  if ((await lstat(base)).isSymbolicLink() || resolve(await realpath(base)) !== base) throw Error('Unsafe test root');
  directory = await mkdtemp(join(base, 'vision-'));
  return { dir: directory, cleanup };
}
