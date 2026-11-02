/**
 * One paced HTTP request to a weather service, retried while the service says it is busy.
 *
 * SMHI and Open-Meteo are free services with no key, so requests to either go out at most once a
 * second per host, shared by every caller in the process, and a 429 or 503 holds every caller
 * back. A service on loopback (a test stub) is not paced.
 */
import { retryAfterMs } from '@archive/location/geocode';

const USER_AGENT = 'EiN/1.0';
const MIN_INTERVAL_MS = 1000;
const BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 4;
/** Long enough for a station's whole history from SMHI, which can be tens of megabytes. */
const REQUEST_TIMEOUT_MS = 180_000;

/** When the next request to each host may go out. A slot is reserved when asked for, so callers queue rather than burst. */
const nextSlot = new Map<string, number>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isLoopback = (url: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

const throttle = async (url: URL): Promise<void> => {
  if (isLoopback(url)) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(url.host) ?? 0);
  nextSlot.set(url.host, slot + MIN_INTERVAL_MS);
  if (slot > now) await sleep(slot - now);
};

const hold = (url: URL, ms: number): void => {
  if (isLoopback(url)) return;
  nextSlot.set(url.host, Math.max(nextSlot.get(url.host) ?? 0, Date.now() + ms));
};

/**
 * The service's answer to `url`: an OK one, or a 404, which SMHI gives for a station and period
 * with no data. Throws on anything else once the attempts are spent, with the status in the message.
 */
export const weatherFetch = async (url: URL): Promise<Response> => {
  let backoff = BACKOFF_MS;
  for (let attempt = 1;; attempt++) {
    await throttle(url);
    let response: Response;
    try {
      response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`${url.host}: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }
    if (response.ok || response.status === 404) return response;
    await response.body?.cancel();
    if ((response.status !== 429 && response.status !== 503) || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${url.host} returned ${response.status}`);
    }
    hold(url, retryAfterMs(response.headers.get('retry-after'), backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
};
