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
