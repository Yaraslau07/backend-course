import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';

import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DataSource } from 'typeorm';

import { AppException } from '@/core/errors/app.exception';

import { ConverterRegistry } from './converter-registry';
import { TempArea } from './temp-area';
import { TransformationPool } from './transformation-pool';
import {
  CONVERSION_ERRORS,
  type TransformationType,
} from './transformation.types';
import {
  readUpload,
  type Upload,
  type UploadedFile,
  type UploadRules,
} from './upload-intake';
import type { TransformResult } from './worker/transform.worker';

export interface ConversionRequest {
  userId: string;
  type: TransformationType;
  source: string;
  target: string;
  params: Record<string, unknown>;
  input: UploadedFile;
}

export interface ConversionResult {
  transformationId: string;
  path: string;
  contentType: string;
  extension: string;
  size: number;
}

/** What an endpoint (specs 2.1, 2.2) supplies: its upload rules and how to read the request. */
export interface ConversionOperation extends UploadRules {
  type: TransformationType;
  /** Source, target and verified parameters, or throws 400/415. */
  resolve(upload: Upload): {
    source: string;
    target: string;
    params: Record<string, unknown>;
    /** `save=true` (spec 2.4 §1.3.1); a missing field is false. */
    save?: boolean;
  };
}

/**
 * The shared procedure of spec 2.0 §1.3.2. The guard has already run steps 1–3 (access, active,
 * CSRF, the operation's permission), so nothing here reads the body before RBAC allowed it.
 */
@Injectable()
export class TransformationService {
  private readonly logger = new Logger('Transformations');

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly registry: ConverterRegistry,
    private readonly pool: TransformationPool,
    private readonly temp: TempArea,
  ) {}

  /** Steps 4–9 for one request; the input is removed whatever happens. */
  async handle(
    userId: string,
    request: FastifyRequest,
    reply: FastifyReply,
    operation: ConversionOperation,
  ): Promise<StreamableFile> {
    const upload = await readUpload(request, this.temp, operation);
    try {
      const { source, target, params } = operation.resolve(upload);
      const result = await this.convert({
        userId,
        type: operation.type,
        source,
        target,
        params,
        input: upload.file,
      });
      return await this.respond(reply, result);
    } finally {
      await this.temp.remove(upload.file.path).catch(() => undefined);
    }
  }

  /**
   * Steps 5–8: the registered pair (or 415), its input limit (413), the converter in the pool, then
   * one history row. Refusals before the pair is known write nothing (D65). A failed history write
   * returns no result (503). On an error the output is removed and the mapped status thrown.
   */
  async convert(request: ConversionRequest): Promise<ConversionResult> {
    const { userId, type, source, target, input } = request;
    const definition = this.registry.find(type, source, target);
    if (!definition) throw new AppException('unsupported_media_type');
    if (input.size > definition.limits.inputBytes)
      throw new AppException('payload_too_large');

    const outputPath = this.temp.path();
    const started = performance.now();
    let result: TransformResult;
    try {
      result = await this.pool.run(
        {
          module: definition.module,
          inputPath: input.path,
          outputPath,
          params: request.params,
          outputLimit: definition.limits.outputBytes,
        },
        definition.limits.timeoutMs,
      );
    } catch {
      result = { ok: false, code: 'converter_failed' };
    }
    const durationMs = Math.round(performance.now() - started);
    const outputSize = result.ok ? result.size : null;
    const errorCode = result.ok ? null : result.code;
    const fields = {
      userId,
      type,
      sourceFormat: source,
      targetFormat: target,
      inputSize: input.size,
      outputSize,
      errorCode,
      durationMs,
    };

    let transformationId: string;
    try {
      const [row] = await this.db.query<{ id: string }[]>(
        `INSERT INTO transformations
           (user_id, type, source_format, target_format, status, input_size, output_size, duration_ms, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          userId,
          type,
          source,
          target,
          result.ok ? 'success' : 'error',
          input.size,
          outputSize,
          durationMs,
          errorCode,
        ],
      );
      transformationId = row.id;
    } catch {
      await this.temp.remove(outputPath).catch(() => undefined);
      this.logger.error(
        { event: 'transformation', ...fields, result: 'history_unavailable' },
        'transformation history write failed',
      );
      throw new AppException('service_unavailable');
    }

    this.logger.log(
      {
        event: 'transformation',
        transformationId,
        ...fields,
        result: result.ok ? 'success' : 'error',
      },
      'transformation finished',
    );
    if (!result.ok) {
      await this.temp.remove(outputPath).catch(() => undefined);
      throw new AppException(CONVERSION_ERRORS[result.code]);
    }
    return {
      transformationId,
      path: outputPath,
      contentType: result.contentType,
      extension: result.extension,
      size: result.size,
    };
  }

  /**
   * The whole result, as an attachment. The file is opened first and its name removed at once:
   * the open descriptor keeps the bytes readable until the response is sent (POSIX), so nothing is
   * left in the temporary area even if the client disconnects.
   */
  private async respond(
    reply: FastifyReply,
    result: ConversionResult,
  ): Promise<StreamableFile> {
    const stream = createReadStream(result.path);
    try {
      await once(stream, 'open');
    } catch {
      // The temporary area failed under us: no partial answer, a 503 (spec 2.0 §1.4).
      stream.destroy();
      throw new AppException('service_unavailable');
    } finally {
      await this.temp.remove(result.path).catch(() => undefined);
    }
    void reply
      .header('X-Transformation-Id', result.transformationId)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store');
    return new StreamableFile(stream, {
      type: result.contentType,
      disposition: `attachment; filename="converted.${result.extension}"`,
      length: result.size,
    });
  }
}
