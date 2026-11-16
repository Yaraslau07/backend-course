import { Check, Column, PrimaryGeneratedColumn } from 'typeorm';

import { ChallengeBase, ChallengeEntity } from './challenge-base.entity';

@ChallengeEntity('email_change_challenges')
@Check(
  'ck_email_change_challenges_new_email',
  `"new_email" !~ '^\\s|\\s$' AND char_length("new_email") BETWEEN 3 AND 254`,
)
export class EmailChangeChallenge extends ChallengeBase {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_email_change_challenges',
  })
  id: string;

  /** The normalized target address; the secret is mailed here, and resend never changes it. */
  @Column({ name: 'new_email', type: 'text' })
  newEmail: string;
}
