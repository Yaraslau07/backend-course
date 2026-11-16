import { PrimaryGeneratedColumn } from 'typeorm';

import { ChallengeBase, ChallengeEntity } from './challenge-base.entity';

@ChallengeEntity('login_challenges')
export class LoginChallenge extends ChallengeBase {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_login_challenges',
  })
  id: string;
}
