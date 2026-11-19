import { assert } from '../run-tests.js';
import { maxReachKm, buildDriveSamplePoints } from '../../js/services/drive-time-search.js';
import { calculateDistance } from '../../js/utils/formatters.js';

const ORIGIN = { lat: 42.65, lng: -73.75 };
const EBIRD_RADIUS_KM = 50;

export async function testMaxReachScalesWithMinutes() {
    assert(maxReachKm(60) === 120, `Expected 120 km for 60 min, got ${maxReachKm(60)}`);
}

export async function testSmallDiscUsesSingleQuery() {
    const points = buildDriveSamplePoints(ORIGIN, 40);
    assert(points.length === 1, `Expected 1 point, got ${points.length}`);
}

export async function testGridCoversWholeDisc() {
    const radiusKm = maxReachKm(60);
    const points = buildDriveSamplePoints(ORIGIN, radiusKm);
    assert(points.length <= 25, `Too many eBird calls: ${points.length}`);

    // Probe a ring of disc points; each must fall inside some 50 km circle
    for (let deg = 0; deg < 360; deg += 10) {
        for (const frac of [0.3, 0.7, 1]) {
            const rad = deg * Math.PI / 180;
            const lat = ORIGIN.lat + (radiusKm * frac * Math.sin(rad)) / 111;
            const lng = ORIGIN.lng + (radiusKm * frac * Math.cos(rad)) / (111 * Math.cos(ORIGIN.lat * Math.PI / 180));
            const covered = points.some(p => calculateDistance(p.lat, p.lng, lat, lng) <= EBIRD_RADIUS_KM);
            assert(covered, `Uncovered point at ${deg}deg, ${frac}R`);
        }
    }
}

import { CONFIG } from '../../js/utils/constants.js';
import { findDriveHotspots } from '../../js/services/drive-time-search.js';

// Fake OSRM table: every destination is 10 min away, except index 0 of each chunk at 4 h
function fakeOsrm({ failFirst = false } = {}) {
    let calls = 0;
    globalThis.fetch = async (url) => {
        calls++;
        if (failFirst && calls === 1) {
            return { ok: false, status: 503 };
        }
        const n = String(url).split('?')[0].split('/').pop().split(';').length - 1;
        const durations = [0, ...Array.from({ length: n }, (_, i) => (i === 0 ? 4 * 3600 : 600))];
        return { ok: true, json: async () => ({ code: 'Ok', durations: [durations], distances: [durations.map(d => d * 10)] }) };
    };
    return () => calls;
}

// 500 hotspots scattered near the origin, more than the old 396 cap
function fakeEbird() {
    const hotspots = Array.from({ length: 500 }, (_, i) => ({
        locId: `L${i}`, lat: ORIGIN.lat + (i % 25) * 0.01, lng: ORIGIN.lng + Math.floor(i / 25) * 0.01, numSpeciesAllTime: i
    }));
    return { getNearbyHotspots: async () => hotspots };
}

export async function testEveryCandidateGetsADriveTime() {
    CONFIG.OSRM.TABLE_PACE_MS = 0;
    const calls = fakeOsrm();
    const { hotspots, unroutable } = await findDriveHotspots(fakeEbird(), ORIGIN, 60);
    const chunks = Math.ceil(500 / CONFIG.OSRM.TABLE_CHUNK_SIZE);
    assert(calls() === chunks, `Expected ${chunks} OSRM calls for 500 hotspots, got ${calls()}`);
    assert(hotspots.length === 500 - chunks, `Expected all but the ${chunks} 4h-away hotspots, got ${hotspots.length}`);
    assert(unroutable === 0, 'No hotspot should be unroutable');
}

export async function testFailedRouteChunkIsRetried() {
    CONFIG.OSRM.TABLE_PACE_MS = 0;
    CONFIG.OSRM.RETRY_DELAY_MS = 0;
    fakeOsrm({ failFirst: true });
    const { unroutable } = await findDriveHotspots(fakeEbird(), ORIGIN, 60);
    assert(unroutable === 0, `A chunk that fails once should succeed on retry, got ${unroutable} unroutable`);
}

export async function testThreeHourGridStillCoversDisc() {
    const radiusKm = maxReachKm(180);
    const points = buildDriveSamplePoints(ORIGIN, radiusKm);
    for (let deg = 0; deg < 360; deg += 15) {
        const rad = deg * Math.PI / 180;
        const lat = ORIGIN.lat + (radiusKm * Math.sin(rad)) / 111;
        const lng = ORIGIN.lng + (radiusKm * Math.cos(rad)) / (111 * Math.cos(ORIGIN.lat * Math.PI / 180));
        assert(points.some(p => calculateDistance(p.lat, p.lng, lat, lng) <= EBIRD_RADIUS_KM), `Edge uncovered at ${deg}deg`);
    }
}
