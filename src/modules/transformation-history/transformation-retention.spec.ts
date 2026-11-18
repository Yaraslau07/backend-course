import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { ConfigService } from '@/core/config/config.service';

import { TransformationRetention } from './transformation-retention.service';

function setup(deleted: number[], env = 'test') {
  const query = jest.fn();
  for (const n of deleted) query.mockResolvedValueOnce([[], n]);
  const retention = new TransformationRetention(
    { query } as unknown as DataSource,
    {
      get: (key: string) =>
        key === 'NODE_ENV'
          ? env
          : key === 'TRANSFORMATION_HISTORY_RETENTION_DAYS'
            ? 90
            : undefined,
    } as unknown as ConfigService,
  );
  return { retention, query };
}

describe('TransformationRetention (spec 2.3 §1.3.5, §1.6)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('deletes rows older than the period in small batches until a batch is short', async () => {
    const { retention, query } = setup([500, 500, 12]);
    expect(await retention.run()).toBe(1012);
    expect(query).toHaveBeenCalledTimes(3);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM transformations');
    expect(sql).toContain('LIMIT');
    expect(params).toEqual([90, 500]);
  });

  it('stops after its batch budget, leaving the rest for the next sweep', async () => {
    const { retention, query } = setup(Array<number>(30).fill(500));
    expect(await retention.run()).toBe(20 * 500);
    expect(query).toHaveBeenCalledTimes(20);
  });

  it('does not schedule itself in tests, and never overlaps', async () => {
    const { retention, query } = setup([0, 0]);
    retention.onModuleInit();
    const [a, b] = await Promise.all([retention.run(), retention.run()]);
    expect(a + b).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
    retention.onModuleDestroy();
  });

  it('schedules itself outside tests', () => {
    jest.useFakeTimers();
    const { retention } = setup([], 'production');
    retention.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    retention.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
