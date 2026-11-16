import {
  type ChallengeScenario,
  MAGIC_LINK_PATHS,
  renderChallengeMail,
} from './templates';

const FRONTEND = 'https://app.example.test';
const SCENARIOS: ChallengeScenario[] = [
  'registration',
  'login',
  'email_change',
  'deletion',
];
const TOKEN = 'b0d6b9f0-attempt.Qm9va3NoZWxmLXRva2VuLXdpdGgtMzItYnl0ZXM';

describe('renderChallengeMail()', () => {
  describe.each(SCENARIOS)('%s', (scenario) => {
    it('puts the OTP in the body, never in the subject, and states the 10-minute validity', () => {
      const mail = renderChallengeMail(
        { scenario, method: 'otp', code: '048213' },
        FRONTEND,
      );

      expect(mail.template).toBe(`${scenario}_otp`);
      expect(mail.subject).not.toContain('048213');
      expect(mail.text).toContain('048213');
      expect(mail.html).toContain('048213');
      expect(mail.text).toMatch(/10 minutes/);
      expect(mail.text).not.toMatch(/https?:\/\//);
    });

    it('sends a magic link with the token in the URL fragment, never in the path or query', () => {
      const mail = renderChallengeMail(
        { scenario, method: 'magic_link', token: TOKEN },
        FRONTEND,
      );
      const link = `${FRONTEND}${MAGIC_LINK_PATHS[scenario]}#token=${encodeURIComponent(TOKEN)}`;

      expect(mail.template).toBe(`${scenario}_magic_link`);
      expect(mail.text).toContain(link);
      expect(mail.html).toContain(`href="${link}"`);
      expect(mail.subject).not.toContain(TOKEN);
      const url = new URL(link);
      expect(url.search).toBe('');
      expect(url.pathname).not.toContain(TOKEN);
      expect(mail.text).toMatch(/10 minutes/);
    });
  });

  it('gives every scenario its own subject and link path', () => {
    const subjects = SCENARIOS.map(
      (scenario) =>
        renderChallengeMail({ scenario, method: 'otp', code: '1' }, FRONTEND)
          .subject,
    );

    expect(new Set(subjects).size).toBe(SCENARIOS.length);
    expect(new Set(Object.values(MAGIC_LINK_PATHS)).size).toBe(
      SCENARIOS.length,
    );
  });

  it('keeps a FRONTEND_URL path prefix and tolerates a trailing slash', () => {
    const mail = renderChallengeMail(
      { scenario: 'login', method: 'magic_link', token: 'abc' },
      'https://app.example.test/portal/',
    );

    expect(mail.text).toContain(
      `https://app.example.test/portal${MAGIC_LINK_PATHS.login}#token=abc`,
    );
  });

  it('escapes HTML in everything it interpolates', () => {
    const mail = renderChallengeMail(
      { scenario: 'login', method: 'otp', code: '<b>"&' },
      FRONTEND,
    );

    expect(mail.html).toContain('&lt;b&gt;&quot;&amp;');
    expect(mail.html).not.toContain('<b>"&');
  });
});
