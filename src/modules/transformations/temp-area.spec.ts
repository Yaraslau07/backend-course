import {
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ConfigService } from '@/core/config/config.service';
import type {
  ReadinessCheck,
  ReadinessRegistry,
} from '@/core/health/readiness.registry';

import { TempArea } from './temp-area';

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'c15-temp-'));
});
afterAll(() => rm(base, { recursive: true, force: true }));

function area(root: string) {
  const checks = new Map<string, ReadinessCheck>();
  const instance = new TempArea(
    { get: () => root } as unknown as ConfigService,
    {
      register: (name: string, check: ReadinessCheck) =>
        checks.set(name, check),
    } as unknown as ReadinessRegistry,
  );
  return { instance, check: () => checks.get('transformation_temp')!() };
}

describe('TempArea (spec 2.0 §1.3.4)', () => {
  it('creates a private root, hands out random names inside it, and is ready', async () => {
    const root = join(base, 'a');
    const { instance, check } = area(root);
    await instance.onModuleInit();
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const a = instance.path();
    const b = instance.path();
    expect(dirname(a)).toBe(root);
    expect(a).not.toBe(b);
    expect(a.slice(root.length + 1)).toMatch(/^[0-9a-f]{32}$/);
    expect(await check()).toBe('up');
  });

  it('removes files idempotently', async () => {
    const { instance } = area(join(base, 'b'));
    await instance.onModuleInit();
    const path = instance.path();
    await writeFile(path, 'x');
    await instance.remove(path);
    await instance.remove(path);
    await expect(stat(path)).rejects.toThrow();
  });

  it('never removes a path outside its root', async () => {
    const { instance } = area(join(base, 'c'));
    await instance.onModuleInit();
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'keep');
    await expect(instance.remove(outside)).rejects.toThrow();
    expect((await stat(outside)).isFile()).toBe(true);
  });

  it('sweeps leftovers older than an hour at start, keeping recent files', async () => {
    const root = join(base, 'd');
    const first = area(root);
    await first.instance.onModuleInit();
    const old = first.instance.path();
    const fresh = first.instance.path();
    await writeFile(old, 'old');
    await writeFile(fresh, 'fresh');
    const past = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(old, past, past);
    await area(root).instance.onModuleInit();
    expect(await readdir(root)).toEqual([fresh.slice(root.length + 1)]);
  });

  it('defaults to a directory under the OS temp dir, and reports down when unusable', async () => {
    const { instance } = area('');
    expect(instance.root).toBe(
      join(tmpdir(), 'backend-course-transformations'),
    );
    const file = join(base, 'not-a-dir');
    await writeFile(file, 'x');
    const broken = area(file);
    await expect(broken.instance.onModuleInit()).rejects.toThrow();
    expect(await broken.check()).toEqual({ down: 'unavailable' });
  });
});

describe('TempArea pending copies (spec 2.4 §1.3.1)', () => {
  it('keeps a private copy under a random 128-bit key, reads it and removes it', async () => {
    const root = join(base, 'keep');
    const { instance } = area(root);
    await instance.onModuleInit();
    const source = instance.path();
    await writeFile(source, 'result bytes');

    const key = await instance.keep(source);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(await readdir(join(root, 'pending'))).toEqual([key]);
    expect((await stat(join(root, 'pending'))).mode & 0o777).toBe(0o700);
    expect((await instance.readPending(key as string))?.toString()).toBe(
      'result bytes',
    );

    await instance.removePending(key as string);
    expect(await instance.readPending(key as string)).toBeNull();
    await instance.removePending(key as string); // idempotent
  });

  it('refuses names that are not its own, and reports a failed copy as null', async () => {
    const { instance } = area(join(base, 'bad'));
    await instance.onModuleInit();
    expect(await instance.readPending('../escape')).toBeNull();
    await expect(instance.removePending('../escape')).resolves.toBeUndefined();
    expect(await instance.keep(join(base, 'missing-source'))).toBeNull();
    expect(await readdir(join(base, 'bad', 'pending'))).toEqual([]);
  });

  it('sweeps copies a day old at start and leaves recent ones', async () => {
    const root = join(base, 'sweep');
    const first = area(root).instance;
    await first.onModuleInit();
    const source = first.path();
    await writeFile(source, 'x');
    const old = (await first.keep(source)) as string;
    const recent = (await first.keep(source)) as string;
    const past = new Date(Date.now() - 25 * 3600 * 1000);
    await utimes(join(root, 'pending', old), past, past);

    await area(root).instance.onModuleInit();
    expect(await readdir(join(root, 'pending'))).toEqual([recent]);
  });
});
