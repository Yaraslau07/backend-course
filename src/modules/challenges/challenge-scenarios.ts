import type { AppConfig } from '@/core/config/config.types';
import type { ChallengeScenario } from '@/core/mail/templates';

export interface ChallengeScenarioConfig {
  table: string;
  hmacKey: keyof AppConfig;
  idField: 'attemptId' | 'challengeId';
  tokenCarriesId: boolean;
  logIds: boolean;
}

// Stub: filled in by the implementation commit.
export const CHALLENGE_SCENARIOS = {} as Record<
  ChallengeScenario,
  ChallengeScenarioConfig
>;
