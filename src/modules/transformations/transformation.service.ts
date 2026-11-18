import { Injectable, type StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ConverterRegistry } from './converter-registry';
import { TempArea } from './temp-area';
import { TransformationPool } from './transformation-pool';
import type { TransformationType } from './transformation.types';
import type { UploadRules, Upload, UploadedFile } from './upload-intake';

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
  };
}

@Injectable()
export class TransformationService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly registry: ConverterRegistry,
    private readonly pool: TransformationPool,
    private readonly temp: TempArea,
  ) {}

  /** The whole procedure of spec 2.0 §1.3.2 steps 4–9 for one request. */
  handle(
    userId: string,
    request: FastifyRequest,
    reply: FastifyReply,
    operation: ConversionOperation,
  ): Promise<StreamableFile> {
    void [
      userId,
      request,
      reply,
      operation,
      this.db,
      this.registry,
      this.pool,
      this.temp,
    ];
    throw new Error('not implemented');
  }

  /** Steps 5–8: find the pair, convert in the pool, write history. */
  convert(request: ConversionRequest): Promise<ConversionResult> {
    void request;
    throw new Error('not implemented');
  }
}
