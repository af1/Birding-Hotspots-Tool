import { assert } from '../run-tests.js';
import { scheduledFetch, setHostPolicy } from '../../js/api/request-scheduler.js';

const HOST = 'scheduler.test';
const URL_ = `https://${HOST}/x`;

function fakeFetch(responder) {
    const log = { starts: [], inFlight: 0, maxInFlight: 0, calls: 0 };
    globalThis.fetch = async () => {
        log.calls++;
        log.starts.push(Date.now());
        log.inFlight++;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        await new Promise(r => setTimeout(r, 5));
        log.inFlight--;
        return responder(log.calls);
    };
    return log;
}

const ok = () => ({ ok: true, status: 200, headers: { get: () => null } });

export async function testSpacesRequestsByInterval() {
    setHostPolicy(HOST, { maxConcurrent: 4, intervalMs: 40 });
    const log = fakeFetch(ok);
    await Promise.all([1, 2, 3].map(() => scheduledFetch(URL_)));
    const gaps = log.starts.slice(1).map((t, i) => t - log.starts[i]);
    assert(gaps.every(g => g >= 35), `Starts should be >= 40ms apart, got ${gaps.join(', ')}`);
}

export async function testCapsConcurrency() {
    setHostPolicy(HOST, { maxConcurrent: 2, intervalMs: 0 });
    const log = fakeFetch(ok);
    await Promise.all(Array.from({ length: 8 }, () => scheduledFetch(URL_)));
    assert(log.maxInFlight <= 2, `At most 2 in flight, saw ${log.maxInFlight}`);
}

export async function testRetriesAfter429WithRetryAfter() {
    setHostPolicy(HOST, { maxConcurrent: 1, intervalMs: 0 });
    const log = fakeFetch(n => n === 1
        ? { ok: false, status: 429, headers: { get: h => (h === 'Retry-After' ? '0.05' : null) } }
        : ok());
    const t = Date.now();
    const res = await scheduledFetch(URL_);
    assert(res.ok, 'Request should succeed after the 429 retry');
    assert(log.calls === 2, `Expected 2 attempts, got ${log.calls}`);
    assert(Date.now() - t >= 45, 'Retry should wait for Retry-After');
}

export async function testAbortedRequestIsNotSent() {
    setHostPolicy(HOST, { maxConcurrent: 1, intervalMs: 0 });
    const log = fakeFetch(ok);
    const controller = new AbortController();
    controller.abort();
    let name = null;
    try {
        await scheduledFetch(URL_, { signal: controller.signal });
    } catch (e) {
        name = e.name;
    }
    assert(name === 'AbortError' && log.calls === 0, 'Aborted request must reject without fetching');
}
