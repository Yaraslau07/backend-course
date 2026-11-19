import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';
import type { ConverterRegistry } from '@/modules/transformations/converter-registry';

import { decodeHistoryCursor } from './history-cursor';
import { TransformationHistoryService } from './transformation-history.service';

const USER = '11111111-1111-4111-8111-111111111111';
const row = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  type: 'file',
  source_format: 'csv',
  target_format: 'json',
  status: 'success',
  input_size: '10',
  output_size: n % 2 ? null : '20',
  duration_ms: 3,
  error_code: null,
  created_at: new Date(Date.UTC(2026, 10, 10 - n)),
  storage_status: 'not_requested' as const,
  stored_file_until: null,
  live: false,
});

function setup(rows: unknown[], user: unknown[] = [{ id: USER }]) {
  const manager = {
    query: jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(rows),
  };
  const db = {
    query: jest.fn().mockResolvedValue(user),
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  };
  const registry = {
    directions: (type: string) =>
      type === 'file'
        ? [{ source: 'csv', target: ['json'] }]
        : [{ source: 'svg', target: ['png'] }],
  };
  const service = new TransformationHistoryService(
    db as unknown as DataSource,
    registry as unknown as ConverterRegistry,
  );
  return { service, db, manager };
}
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return 'none';
};

describe('TransformationHistoryService (spec 2.3)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads limit + 1 rows under a 2 s timeout, binds every filter, and returns a cursor for more', async () => {
    const s = setup([row(1), row(2), row(3)]);
    const page = await s.service.own(USER, {
      limit: '2',
      type: 'file',
      sourceFormat: 'csv',
      targetFormat: 'json',
      status: 'success',
      createdAtFrom: '2026-11-01T00:00:00Z',
      createdAtTo: '2026-11-30T00:00:00Z',
    });
    expect((s.manager.query.mock.calls[0] as [string])[0]).toBe(
      `SET LOCAL statement_timeout = '2s'`,
    );
    const [sql, params] = s.manager.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(sql).not.toMatch(/OFFSET|count\(/i);
    expect(params).toEqual([
      USER,
      'file',
      'csv',
      'json',
      'success',
      '2026-11-01T00:00:00.000Z',
      '2026-11-30T00:00:00.000Z',
      3,
    ]);
    expect(page.items.map((i) => i.id)).toEqual([row(1).id, row(2).id]);
    expect(page.items[0]).toMatchObject({
      inputSize: 10,
      outputSize: null,
      storageStatus: 'not_requested',
    });
    expect(page.items[1]).toMatchObject({ outputSize: 20 });
    const filters = {
      limit: 2,
      type: 'file' as const,
      sourceFormat: 'csv',
      targetFormat: 'json',
      status: 'success' as const,
      createdAtFrom: '2026-11-01T00:00:00.000Z',
      createdAtTo: '2026-11-30T00:00:00.000Z',
    };
    expect(decodeHistoryCursor(page.nextCursor!, filters)).toEqual({
      createdAt: row(2).created_at.toISOString(),
      id: row(2).id,
    });
  });

  it('continues after the cursor position with a row-value comparison', async () => {
    const first = await setup([row(1), row(2)]).service.own(USER, {
      limit: '1',
    });
    const s = setup([row(2)]);
    const page = await s.service.own(USER, {
      limit: '1',
      cursor: first.nextCursor!,
    });
    const [sql, params] = s.manager.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('(created_at, id) < ($2::timestamptz, $3::uuid)');
    expect(params).toEqual([
      USER,
      row(1).created_at.toISOString(),
      row(1).id,
      2,
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('admin: validates the path, then the query, then looks the user up (404)', async () => {
    const s = setup([], []);
    expect(await codeOf(() => s.service.ofUser(USER, 'bad id', {}))).toBe(
      'bad_request',
    );
    expect(
      await codeOf(() => s.service.ofUser(USER, USER, { limit: '0' })),
    ).toBe('bad_request');
    expect(s.db.query).not.toHaveBeenCalled();
    expect(await codeOf(() => s.service.ofUser(USER, USER, {}))).toBe(
      'not_found',
    );
    expect(await codeOf(() => s.service.ofUser(USER, 'not-a-uuid', {}))).toBe(
      'not_found',
    );
    expect((s.db.query.mock.calls[1] as [string, unknown[]])[1]).toEqual([
      null,
    ]);
  });

  it('admin: returns the target history once found', async () => {
    const s = setup([row(1)]);
    expect(
      (await s.service.ofUser('22222222-2222-4222-8222-222222222222', USER, {}))
        .items,
    ).toHaveLength(1);
  });

  it('only registered formats are filterable', async () => {
    const s = setup([]);
    expect(
      await codeOf(() => s.service.own(USER, { sourceFormat: 'svg' })),
    ).toBe('none');
    expect(
      await codeOf(() => s.service.own(USER, { targetFormat: 'svg' })),
    ).toBe('bad_request');
  });

  it('logs a failure with its category, and a slow read as a warning', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const s = setup([]);
    s.db.transaction.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    );
    expect(await codeOf(() => s.service.own(USER, {}))).toBe('other');
    expect((warn.mock.calls[0] as unknown[])[0]).toMatchObject({
      result: 'failure',
      category: 'unavailable',
    });
  });
});
