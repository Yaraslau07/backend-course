/* eslint-disable @typescript-eslint/no-unused-vars -- stub, replaced by the implementation commit */
export type ChallengeScenario =
  | 'registration'
  | 'login'
  | 'email_change'
  | 'deletion';

export type ChallengeMailInput =
  | { scenario: ChallengeScenario; method: 'otp'; code: string }
  | { scenario: ChallengeScenario; method: 'magic_link'; token: string };

export interface RenderedMail {
  template: string;
  subject: string;
  text: string;
  html: string;
}

export const MAGIC_LINK_PATHS = {} as Record<ChallengeScenario, string>;

export function renderChallengeMail(
  _input: ChallengeMailInput,
  _frontendUrl: string,
): RenderedMail {
  throw new Error('not implemented');
}
