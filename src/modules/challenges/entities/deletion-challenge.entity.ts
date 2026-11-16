import { PrimaryGeneratedColumn } from 'typeorm';

import { ChallengeBase, ChallengeEntity } from './challenge-base.entity';

@ChallengeEntity('deletion_challenges')
export class DeletionChallenge extends ChallengeBase {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_deletion_challenges',
  })
  id: string;
}
