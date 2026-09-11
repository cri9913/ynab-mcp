const BASE_URL = 'https://api.ynab.com/v1';

export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

export class YnabApi {
  #token;
  #fetch;
  #now;
  #requests = [];
  #blockedUntil = 0;

  constructor(token, { fetchImpl = fetch, now = Date.now, timeoutMs = 35_000 } = {}) {
    if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw new Error('Invalid YNAB credential');
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.timeoutMs = timeoutMs;
  }

  async request(operation, args, signal) {
    const now = this.#now();
    this.#requests = this.#requests.filter(time => time > now - 3_600_000);
    if (now < this.#blockedUntil || this.#requests.length >= 200) {
      throw new ApiError('YNAB rate limit: wait before retrying.', { status: 429 });
    }
    const path = operation.path.replace(/\{([^}]+)\}/g, (_, name) => {
      const value = args[name];
      if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\/\\?#\x00-\x20]/.test(value)) {
        throw new ApiError('Invalid API path parameter.');
      }
      return encodeURIComponent(value);
    });
    const url = new URL(`${BASE_URL}${path}`);
    if (url.origin !== 'https://api.ynab.com' || !url.pathname.startsWith('/v1/')) throw new ApiError('Invalid API destination.');
    for (const parameter of operation.parameters) {
      if (parameter.in === 'query' && args[parameter.name] !== undefined) url.searchParams.set(parameter.name, String(args[parameter.name]));
    }
    this.#requests.push(now);
    let response;
    let text;
    try {
      response = await this.#fetch(url, {
        method: operation.method,
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', ...(args.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 429) {
        const receivedAt = this.#now();
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
        const date = retryAfter ? Date.parse(retryAfter) : NaN;
        // Apply the cooldown from headers even if reading the response body fails.
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - receivedAt : 3_600_000;
        this.#blockedUntil = Math.max(this.#blockedUntil, receivedAt + Math.max(1000, delay));
      }
      text = await response.text();
    } catch {
      throw new ApiError(operation.write
        ? 'YNAB request failed or timed out. The mutation may have succeeded; read the affected data before retrying.'
        : 'YNAB request failed or timed out. Check connectivity and try again.');
    }
    const rateLimit = response.headers.get('x-rate-limit');
    const retryAfter = response.headers.get('retry-after');
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(`YNAB returned a non-JSON response (HTTP ${response.status}).${operation.write ? ' Verify state before retrying.' : ''}`, { status: response.status });
    }
    const redact = value => JSON.parse(JSON.stringify(value).split(this.#token).join('[REDACTED]'));
    if (!response.ok) {
      throw new ApiError(`YNAB API error (HTTP ${response.status}).${operation.write && response.status >= 500 ? ' Outcome uncertain; verify state before retrying.' : ''}`, redact({
        status: response.status,
        error: body?.error ?? null,
        ...(retryAfter ? { retry_after: retryAfter } : {}),
      }));
    }
    return redact({ status: response.status, ...(rateLimit ? { rate_limit: rateLimit } : {}), response: body });
  }
}
