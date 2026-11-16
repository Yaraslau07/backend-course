/**
 * Reads mail caught by Mailpit (docker-compose locally, a service container in CI) through its API.
 * Tests use a unique recipient each time, so nothing needs deleting between runs.
 */
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export interface CaughtMail {
  subject: string;
  from: string;
  to: string[];
  text: string;
  html: string;
}

interface SearchResult {
  messages: { ID: string }[];
}

interface Message {
  Subject: string;
  From: { Name: string; Address: string };
  To: { Address: string }[];
  Text: string;
  HTML: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${MAILPIT_URL}${path}`);
  if (!res.ok) throw new Error(`Mailpit ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Waits for the newest message to `address` (SMTP delivery is asynchronous on Mailpit's side). */
export async function waitForMail(
  address: string,
  timeoutMs = 5000,
): Promise<CaughtMail> {
  const deadline = Date.now() + timeoutMs;
  const query = encodeURIComponent(`to:"${address}"`);
  for (;;) {
    const found = await getJson<SearchResult>(`/api/v1/search?query=${query}`);
    if (found.messages.length > 0) {
      const message = await getJson<Message>(
        `/api/v1/message/${found.messages[0].ID}`,
      );
      return {
        subject: message.Subject,
        from: message.From.Address,
        to: message.To.map((to) => to.Address),
        text: message.Text,
        html: message.HTML,
      };
    }
    if (Date.now() > deadline) throw new Error('No mail arrived in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Whether any message to `address` exists right now. */
export async function hasMail(address: string): Promise<boolean> {
  const query = encodeURIComponent(`to:"${address}"`);
  return (
    (await getJson<SearchResult>(`/api/v1/search?query=${query}`)).messages
      .length > 0
  );
}
