import { Index, PrimaryGeneratedColumn } from 'typeorm';

import { ChallengeBase, ChallengeEntity } from './challenge-base.entity';

@ChallengeEntity('registration_challenges')
// A registration magic link carries only the token (spec 1.0), so the challenge is found by its HMAC.
@Index('idx_registration_challenges_secret_hash', ['secretHash'], {
  where: `"consumed_at" IS NULL`,
})
export class RegistrationChallenge extends ChallengeBase {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_registration_challenges',
  })
  id: string;
}
