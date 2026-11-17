export interface ProfilePatch {
  displayName?: string | null;
  email?: string;
  status?: 'active' | 'blocked';
}

export function patchFields(raw: unknown): Record<string, unknown> {
  void raw;
  throw new Error('not implemented');
}

export function normalizePatch(raw: Record<string, unknown>): ProfilePatch {
  void raw;
  throw new Error('not implemented');
}

export function emailInput(raw: unknown): string {
  void raw;
  throw new Error('not implemented');
}

export function challengeInput(
  raw: unknown,
  resend = false,
): { challengeId: string; code?: string } | { token: string } {
  void raw;
  void resend;
  throw new Error('not implemented');
}
