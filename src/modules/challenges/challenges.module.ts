import { Module } from '@nestjs/common';

import { ChallengeEngine } from './challenge-engine.service';

@Module({
  providers: [ChallengeEngine],
  exports: [ChallengeEngine],
})
export class ChallengesModule {}
