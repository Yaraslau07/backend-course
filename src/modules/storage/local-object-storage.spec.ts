import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@/core/config/config.service';

import { LocalObjectStorage } from './local-object-storage';

describe('development opaque object storage', () => {
  let root: string;
  let storage: LocalObjectStorage;
  let env: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'c12-storage-'));
    env = 'test';
    storage = new LocalObjectStorage({
      get: (key: string) => (key === 'NODE_ENV' ? env : root),
    } as ConfigService);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('streams an object and deletes it idempotently', async () => {
    const bytes = Buffer.from('opaque image bytes');
    await writeFile(join(root, 'photo-123.webp'), bytes);
    const result = await storage.read('photo-123.webp');
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('expected stream');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(await storage.delete('photo-123.webp')).toBe('deleted');
    expect(await storage.delete('photo-123.webp')).toBe('not_found');
    expect(await storage.read('photo-123.webp')).toEqual({ kind: 'not_found' });
  });

  it.each([
    '../escape',
    '/tmp/outside',
    'nested/key',
    '.',
    '..',
    '',
    'key\\file',
    'photo\n',
    'photo.webp\n',
    'a'.repeat(129),
  ])('rejects an unsafe opaque key %s', async (key) => {
    expect(await storage.read(key)).toEqual({ kind: 'unavailable' });
    expect(await storage.delete(key)).toBe('unavailable');
  });

  it('refuses directories and symlinks and leaves their contents untouched', async () => {
    await mkdir(join(root, 'directory'));
    await writeFile(join(root, 'target'), 'private');
    await symlink(join(root, 'target'), join(root, 'link'));
    for (const key of ['directory', 'link']) {
      expect(await storage.read(key)).toEqual({ kind: 'unavailable' });
      expect(await storage.delete(key)).toBe('unavailable');
    }
    expect(await readFile(join(root, 'target'), 'utf8')).toBe('private');
  });

  it('disables local reads and deletes in production', async () => {
    await writeFile(join(root, 'photo'), 'private');
    env = 'production';
    expect(await storage.read('photo')).toEqual({ kind: 'unavailable' });
    expect(await storage.delete('photo')).toBe('unavailable');
    expect(await storage.write('new', Buffer.from('private'))).toBe(
      'unavailable',
    );
    expect(await storage.list()).toEqual({ kind: 'unavailable' });
    expect(await readFile(join(root, 'photo'), 'utf8')).toBe('private');
  });

  it('writes without overwriting, repeats the same write, and lists regular files with pagination', async () => {
    expect(await storage.write('opaque.webp', Buffer.from('first'))).toBe(
      'stored',
    );
    expect(await storage.write('opaque.webp', Buffer.from('second'))).toBe(
      'unavailable',
    );
    // The same bytes under the same key are the same write again (spec 2.4 §1.3.1).
    expect(await storage.write('opaque.webp', Buffer.from('first'))).toBe(
      'stored',
    );
    expect(await storage.write('../escape', Buffer.alloc(1))).toBe(
      'unavailable',
    );
    expect(await readFile(join(root, 'opaque.webp'), 'utf8')).toBe('first');
    await Promise.all(
      Array.from({ length: 101 }, (_, n) =>
        writeFile(
          join(root, `photo-${String(n).padStart(3, '0')}.webp`),
          'photo',
        ),
      ),
    );
    const first = await storage.list();
    expect(first.kind).toBe('listed');
    if (first.kind !== 'listed') throw new Error('expected listing');
    expect(first.objects).toHaveLength(100);
    expect(first.cursor).toBeDefined();
    const last = await storage.list(first.cursor);
    expect(last.kind).toBe('listed');
    if (last.kind !== 'listed') throw new Error('expected listing');
    expect(last.objects).toHaveLength(2);
    expect(last.cursor).toBeUndefined();
    expect(Number.isFinite(first.objects[0].modifiedAt.getTime())).toBe(true);
  });

  it('returns unavailable when the storage root is not a directory', async () => {
    await writeFile(join(root, 'not-a-directory'), 'private');
    storage = new LocalObjectStorage({
      get: (key: string) =>
        key === 'NODE_ENV' ? 'test' : join(root, 'not-a-directory'),
    } as ConfigService);
    expect(await storage.read('photo')).toEqual({ kind: 'unavailable' });
    expect(await storage.delete('photo')).toBe('unavailable');
  });

  it('writes through a private temporary name and leaves nothing beside the object', async () => {
    expect(await storage.write('atomic', Buffer.from('whole'))).toBe('stored');
    expect(await readdir(root)).toContain('atomic');
    expect((await readdir(root)).filter((n) => n.includes('.part-'))).toEqual(
      [],
    );
    // A stray temporary name (a crash) is not an object and never listed.
    await writeFile(join(root, 'atomic.part-deadbeef'), 'torn');
    const listing = await storage.list();
    if (listing.kind !== 'listed') throw new Error('expected listing');
    expect(listing.objects.map((o) => o.key)).toContain('atomic');
    expect(listing.objects.map((o) => o.key)).not.toContain(
      'atomic.part-deadbeef',
    );
  });
});
