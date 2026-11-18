import { Injectable } from '@nestjs/common';

import type {
  TransformationStatus,
  TransformationType,
} from '@/modules/transformations/transformation.types';

/** Spec 2.3 §1.3.4 (storage fields fixed until spec 2.4). */
export interface TransformationHistoryItem {
  id: string;
  type: TransformationType;
  sourceFormat: string;
  targetFormat: string;
  status: TransformationStatus;
  inputSize: number;
  outputSize: number | null;
  durationMs: number;
  errorCode: string | null;
  createdAt: string;
  storageStatus: 'not_requested' | 'pending' | 'available' | 'error';
  hasStoredFile: boolean;
  fileExpiresAt: string | null;
}

export interface HistoryPage {
  items: TransformationHistoryItem[];
  nextCursor: string | null;
}

@Injectable()
export class TransformationHistoryService {
  /** Own history: the user id comes from the verified session (spec 2.3 §1.3.2 step 3). */
  own(actor: string, rawQuery: unknown): Promise<HistoryPage> {
    void [actor, rawQuery];
    throw new Error('not implemented');
  }

  /** Someone's history, after `transformations@history_any` (spec 2.3 §1.3.3). */
  ofUser(
    actor: string,
    target: string,
    rawQuery: unknown,
  ): Promise<HistoryPage> {
    void [actor, target, rawQuery];
    throw new Error('not implemented');
  }
}
