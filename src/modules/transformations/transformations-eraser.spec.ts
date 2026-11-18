import type { DataSource } from 'typeorm';

import { TransformationsEraser } from './transformations-eraser';

describe('TransformationsEraser (spec 2.0 §1.3.4)', () => {
  it("deletes the user's rows in batches until none are left", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([[], 1000])
      .mockResolvedValueOnce([[], 3])
      .mockResolvedValueOnce([[], 0]);
    const eraser = new TransformationsEraser({
      query,
    } as unknown as DataSource);
    expect(await eraser.eraseUserData('u')).toEqual({ result: 'succeeded' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining('DELETE FROM transformations'),
      ['u', 1000],
    ]);
  });

  it('a database failure is retryable with a safe code', async () => {
    const query = jest.fn().mockRejectedValue(new Error('down'));
    const eraser = new TransformationsEraser({
      query,
    } as unknown as DataSource);
    expect(await eraser.eraseUserData('u')).toEqual({
      result: 'retryable_failure',
      code: 'history_unavailable',
    });
  });
});
