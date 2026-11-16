/** The four email-challenge scenarios (specs 1.0, 1.2, 1.5, 1.6). */
export type ChallengeScenario =
  | 'registration'
  | 'login'
  | 'email_change'
  | 'deletion';

export type ChallengeMailInput =
  | { scenario: ChallengeScenario; method: 'otp'; code: string }
  | { scenario: ChallengeScenario; method: 'magic_link'; token: string };

export interface RenderedMail {
  /** For logs: `<scenario>_<method>`. The only thing about a mail that is ever logged. */
  template: string;
  subject: string;
  text: string;
  html: string;
}

/** Spec: a challenge is valid for 10 minutes from when it was sent. */
const VALID_MINUTES = 10;

/**
 * Frontend pages a magic link opens. Opening one changes nothing (spec 1.0, 1.2): the page reads
 * the token from the fragment and POSTs it to the API. There is no frontend in this project, so
 * these are the agreed paths a frontend would serve.
 */
export const MAGIC_LINK_PATHS = {
  registration: '/auth/register/confirm',
  login: '/auth/login/confirm',
  email_change: '/account/email/confirm',
  deletion: '/account/deletion/confirm',
} as const satisfies Record<ChallengeScenario, string>;

const COPY: Record<ChallengeScenario, { subject: string; action: string }> = {
  registration: {
    subject: 'Confirm your registration',
    action: 'confirm your registration',
  },
  login: { subject: 'Confirm your sign-in', action: 'finish signing in' },
  email_change: {
    subject: 'Confirm your new email address',
    action: 'confirm your new email address',
  },
  deletion: {
    subject: 'Confirm deleting your account',
    action: 'confirm deleting your account',
  },
};

const IGNORE = 'If you did not ask for this, ignore this email.';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The secret goes only into the body: an OTP as text, a magic-link token in the URL **fragment**,
 * which browsers never send to a server, so it can't end up in access logs or a Referer header.
 */
export function renderChallengeMail(
  input: ChallengeMailInput,
  frontendUrl: string,
): RenderedMail {
  const { subject, action } = COPY[input.scenario];
  const template = `${input.scenario}_${input.method}`;

  if (input.method === 'otp') {
    return {
      template,
      subject,
      text: [
        `Your code to ${action} is: ${input.code}`,
        '',
        `It is valid for ${VALID_MINUTES} minutes. ${IGNORE}`,
      ].join('\n'),
      html: [
        `<p>Your code to ${escapeHtml(action)} is:</p>`,
        `<p style="font-size:24px;letter-spacing:4px"><strong>${escapeHtml(input.code)}</strong></p>`,
        `<p>It is valid for ${VALID_MINUTES} minutes. ${escapeHtml(IGNORE)}</p>`,
      ].join('\n'),
    };
  }

  const link = `${frontendUrl.replace(/\/+$/, '')}${MAGIC_LINK_PATHS[input.scenario]}#token=${encodeURIComponent(input.token)}`;
  return {
    template,
    subject,
    text: [
      `Open this link to ${action}:`,
      link,
      '',
      `It is valid for ${VALID_MINUTES} minutes and works once. ${IGNORE}`,
    ].join('\n'),
    html: [
      `<p>Open this link to ${escapeHtml(action)}:</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
      `<p>It is valid for ${VALID_MINUTES} minutes and works once. ${escapeHtml(IGNORE)}</p>`,
    ].join('\n'),
  };
}
