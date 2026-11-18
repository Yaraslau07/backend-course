import { afterFailure, DELETION_MAX_ATTEMPTS } from './deletion-worker.service';

describe('afterFailure() (spec 1.6 §1.3.5 steps 4–5)', () => {
  const retryable = { result: 'retryable_failure', code: 'x' } as const;
  const permanent = { result: 'permanent_failure', code: 'x' } as const;

  it('queues a retryable failure again while attempts are left', () => {
    for (let attempts = 1; attempts < DELETION_MAX_ATTEMPTS; attempts++) {
      expect(afterFailure(retryable, attempts)).toBe('queued');
    }
  });

  it('fails the job at the 5th start', () => {
    expect(afterFailure(retryable, DELETION_MAX_ATTEMPTS)).toBe('failed');
  });

  it('fails a permanent failure at once', () => {
    expect(afterFailure(permanent, 1)).toBe('failed');
  });
});
