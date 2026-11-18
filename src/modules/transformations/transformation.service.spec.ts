import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';

import type {
  ConverterDefinition,
  ConverterRegistry,
} from './converter-registry';
import type { TempArea } from './temp-area';
import type { TransformationPool } from './transformation-pool';
import {
  type ConversionRequest,
  TransformationService,
} from './transformation.service';
import type { TransformResult } from './worker/transform.worker';

const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const definition: ConverterDefinition = {
  type: 'file',
  source: 'csv',
  target: 'json',
  module: '/converters/csv-json.js',
  limits: { inputBytes: 100, outputBytes: 200, timeoutMs: 1000 },
};
const request = (
  fields: Partial<ConversionRequest> = {},
): ConversionRequest => ({
  userId: USER,
  type: 'file',
  source: 'csv',
  target: 'json',
  params: { a: 1 },
  input: { path: '/tmp/area/in', size: 10, extension: 'csv', mime: 'text/csv' },
  ...fields,
});

function setup(
  result: TransformResult | Error = {
    ok: true,
    contentType: 'application/json',
    extension: 'json',
    size: 42,
  },
) {
  const query = jest.fn().mockResolvedValue([{ id: ID }]);
  const run = jest.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  const remove = jest.fn().mockResolvedValue(undefined);
  const registry = {
    find: jest.fn((type: string, source: string, target: string) =>
      type === 'file' && source === 'csv' && target === 'json'
        ? definition
        : undefined,
    ),
  };
  const service = new TransformationService(
    { query } as unknown as DataSource,
    registry as unknown as ConverterRegistry,
    { run } as unknown as TransformationPool,
    { path: () => '/tmp/area/out', remove } as unknown as TempArea,
  );
  return { service, query, run, remove };
}
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppException ? error.code : 'other';
  }
  return 'none';
};

describe('TransformationService.convert() (spec 2.0 §1.3.2 steps 5–9)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs the registered converter with its limits and writes a success row', async () => {
    const s = setup();
    expect(await s.service.convert(request())).toEqual({
      transformationId: ID,
      path: '/tmp/area/out',
      contentType: 'application/json',
      extension: 'json',
      size: 42,
    });
    expect(s.run).toHaveBeenCalledWith(
      {
        module: definition.module,
        inputPath: '/tmp/area/in',
        outputPath: '/tmp/area/out',
        params: { a: 1 },
        outputLimit: 200,
      },
      1000,
    );
    const [sql, params] = s.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO transformations');
    expect(params.slice(0, 7)).toEqual([
      USER,
      'file',
      'csv',
      'json',
      'success',
      10,
      42,
    ]);
    expect(params[8]).toBeNull();
    expect(s.remove).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_input', 'invalid_file'],
    ['structure_mismatch', 'invalid_file'],
    ['unsafe_input', 'invalid_file'],
    ['content_mismatch', 'unsupported_media_type'],
    ['result_too_large', 'payload_too_large'],
    ['timeout', 'gateway_timeout'],
    ['converter_failed', 'service_unavailable'],
  ] as const)(
    'a converter result %s is recorded and answered as %s, and the output removed',
    async (errorCode, httpCode) => {
      const s = setup({ ok: false, code: errorCode });
      expect(await codeOf(() => s.service.convert(request()))).toBe(httpCode);
      const [, params] = s.query.mock.calls[0] as [string, unknown[]];
      expect(params[4]).toBe('error');
      expect(params[6]).toBeNull();
      expect(params[8]).toBe(errorCode);
      expect(s.remove).toHaveBeenCalledWith('/tmp/area/out');
    },
  );

  it('a pool that rejects is a converter failure', async () => {
    const s = setup(new Error('queue full'));
    expect(await codeOf(() => s.service.convert(request()))).toBe(
      'service_unavailable',
    );
    expect((s.query.mock.calls[0] as [string, unknown[]])[1][8]).toBe(
      'converter_failed',
    );
  });

  it('an unregistered pair is 415 and an input over its limit 413, neither recorded', async () => {
    const s = setup();
    expect(
      await codeOf(() => s.service.convert(request({ target: 'xml' }))),
    ).toBe('unsupported_media_type');
    expect(
      await codeOf(() =>
        s.service.convert(
          request({ input: { ...request().input, size: 101 } }),
        ),
      ),
    ).toBe('payload_too_large');
    expect(s.run).not.toHaveBeenCalled();
    expect(s.query).not.toHaveBeenCalled();
  });

  it('a failed history write returns no result: 503 and the output removed', async () => {
    const s = setup();
    s.query.mockRejectedValueOnce(new Error('db down'));
    expect(await codeOf(() => s.service.convert(request()))).toBe(
      'service_unavailable',
    );
    expect(s.remove).toHaveBeenCalledWith('/tmp/area/out');
  });
});
