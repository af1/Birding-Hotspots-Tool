/**
 * Request scheduler: one queue per API host so no search can burst past a
 * provider's rate limit, and a 429 slows that host down instead of failing.
 *
 *   caller ──scheduledFetch(url)──> host queue ──(≤ maxConcurrent, ≥ interval apart)──> fetch
 *                                       ▲                                              │
 *                                       └── 429 / 503: pause host for Retry-After, ────┘
 *                                           double its interval, retry (up to 3x)
 *
 * The interval relaxes back toward the policy's base after successes.
 */

// Per-host limits. Published limits where they exist, conservative guesses otherwise.
const HOST_POLICIES = {
    'api.ebird.org': { maxConcurrent: 4, intervalMs: 100 },            // unpublished; ~10 req/s, 4 in flight
    'router.project-osrm.org': { maxConcurrent: 1, intervalMs: 1000 }, // demo server policy: ~1 req/s
    'us1.locationiq.com': { maxConcurrent: 1, intervalMs: 550 },       // free tier: 2 req/s
    'api.open-meteo.com': { maxConcurrent: 2, intervalMs: 100 }        // generous free tier
};
const DEFAULT_POLICY = { maxConcurrent: 4, intervalMs: 0 };

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const MAX_RETRIES = 3;
const MAX_INTERVAL_MS = 8000;
const DEFAULT_COOLDOWN_MS = 2000;
const RELAX_FACTOR = 0.9; // after each success, interval moves 10% back toward base

const hosts = new Map();

function hostState(host) {
    if (!hosts.has(host)) {
        const policy = HOST_POLICIES[host] || DEFAULT_POLICY;
        hosts.set(host, {
            policy,
            intervalMs: policy.intervalMs,
            inFlight: 0,
            nextStartAt: 0,
            pausedUntil: 0,
            queue: []
        });
    }
    return hosts.get(host);
}

/**
 * Retry-After is seconds or an HTTP date; fall back to a short cooldown.
 */
function retryAfterMs(response) {
    const header = response.headers?.get?.('Retry-After');
    if (!header) {
        return DEFAULT_COOLDOWN_MS;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return seconds * 1000;
    }
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : DEFAULT_COOLDOWN_MS;
}

function abortError() {
    return new DOMException('Aborted', 'AbortError');
}

/**
 * Start queued requests for a host while its limits allow.
 */
function pump(state) {
    while (state.queue.length > 0 && state.inFlight < state.policy.maxConcurrent) {
        const now = Date.now();
        const startAt = Math.max(state.nextStartAt, state.pausedUntil);
        if (startAt > now) {
            clearTimeout(state.timer);
            state.timer = setTimeout(() => pump(state), startAt - now);
            return;
        }

        const job = state.queue.shift();
        if (job.signal?.aborted) {
            job.reject(abortError());
            continue;
        }
        state.inFlight++;
        state.nextStartAt = now + state.intervalMs;
        run(state, job);
    }
}

async function run(state, job) {
    try {
        const response = await fetch(job.url, job.options);
        const throttled = response.status === HTTP_TOO_MANY_REQUESTS || response.status === HTTP_SERVICE_UNAVAILABLE;

        // Throttled: pause the whole host, slow it down, and requeue this request
        if (throttled && job.attempt < MAX_RETRIES) {
            state.pausedUntil = Date.now() + retryAfterMs(response);
            state.intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(250, state.intervalMs * 2));
            job.attempt++;
            state.queue.unshift(job);
            return;
        }

        // Success: drift back toward the base interval
        if (response.ok) {
            const base = state.policy.intervalMs;
            state.intervalMs = Math.max(base, Math.round(state.intervalMs * RELAX_FACTOR));
        }
        job.resolve(response);
    } catch (error) {
        job.reject(error);
    } finally {
        state.inFlight--;
        pump(state);
    }
}

/**
 * Drop-in replacement for fetch() that respects the host's rate policy.
 * @param {string|URL} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export function scheduledFetch(url, options = {}) {
    const host = new URL(String(url)).host;
    const state = hostState(host);

    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(abortError());
            return;
        }
        state.queue.push({ url, options, signal: options.signal, attempt: 0, resolve, reject });
        pump(state);
    });
}

/**
 * Test hook: override a host's policy and reset its state.
 */
export function setHostPolicy(host, policy) {
    HOST_POLICIES[host] = policy;
    hosts.delete(host);
}
