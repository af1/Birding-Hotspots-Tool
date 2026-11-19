/**
 * Drive-time hotspot search.
 *
 * eBird's geo endpoint caps at 50 km, but a 60 min drive can reach ~120 km.
 * So we tile the reachable disc with 50 km search circles, merge results,
 * then keep only hotspots whose real OSRM drive time fits the limit.
 *
 *          .  o  .          o = eBird search circle center (hex grid)
 *       o     o     o       X = origin
 *          o  X  o          disc radius = minutes x MAX_SPEED
 *       o     o     o
 *          .  o  .
 */

import { CONFIG } from '../utils/constants.js';
import { calculateDistance } from '../utils/formatters.js';
import { getDriveDurations } from '../api/routing.js';
import { dedupeHotspotsById } from './route-hotspot-search.js';

const KM_PER_DEG_LAT = 111;
const SECONDS_PER_MINUTE = 60;

/**
 * Upper bound on how far (km) a car can get in `minutes`.
 * Example: 60 min at 120 km/h -> 120 km.
 */
export function maxReachKm(minutes) {
    return minutes * CONFIG.DRIVE_TIME.MAX_SPEED_KMH / SECONDS_PER_MINUTE;
}

/**
 * Hex-grid centers covering a disc of `radiusKm` around origin.
 * Spacing below 50 km x sqrt(3) guarantees full coverage by 50 km circles.
 */
export function buildDriveSamplePoints(origin, radiusKm) {
    const { SEARCH_RADIUS_KM, GRID_SPACING_KM } = CONFIG.DRIVE_TIME;

    // Small disc: a single eBird call covers it
    if (radiusKm <= SEARCH_RADIUS_KM) {
        return [{ lat: origin.lat, lng: origin.lng }];
    }

    const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(origin.lat * Math.PI / 180);
    const rowHeight = GRID_SPACING_KM * Math.sqrt(3) / 2;
    const rows = Math.ceil(radiusKm / rowHeight);
    const cols = Math.ceil(radiusKm / GRID_SPACING_KM) + 1;
    // Any disc point is within spacing/sqrt(3) of some grid center
    const keepWithinKm = radiusKm + GRID_SPACING_KM / Math.sqrt(3);
    const points = [];

    // Walk hex rows; keep centers that may be nearest to some disc point
    for (let r = -rows; r <= rows; r++) {
        const offset = (Math.abs(r) % 2) * GRID_SPACING_KM / 2;
        for (let c = -cols; c <= cols; c++) {
            const dx = c * GRID_SPACING_KM + offset;
            const dy = r * rowHeight;
            if (Math.hypot(dx, dy) > keepWithinKm) {
                continue;
            }
            points.push({
                lat: origin.lat + dy / KM_PER_DEG_LAT,
                lng: origin.lng + dx / kmPerDegLng
            });
        }
    }

    return points;
}

/**
 * Find eBird hotspots reachable within `minutes` of driving.
 * Returns hotspots richest-first, each with `driveDuration` (s) and `driveDistance` (km).
 */
export async function findDriveHotspots(ebirdApi, origin, minutes, signal) {
    const radiusKm = maxReachKm(minutes);
    const points = buildDriveSamplePoints(origin, radiusKm);

    // Fan out eBird geo searches in small batches (avoid 429s);
    // one failed tile shouldn't sink the search
    const { SEARCH_RADIUS_KM, QUERY_CONCURRENCY } = CONFIG.DRIVE_TIME;
    const results = [];
    for (let i = 0; i < points.length; i += QUERY_CONCURRENCY) {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        const batch = points.slice(i, i + QUERY_CONCURRENCY);
        results.push(...await Promise.allSettled(batch.map(p =>
            ebirdApi.getNearbyHotspots(p.lat, p.lng, SEARCH_RADIUS_KM, CONFIG.DEFAULT_DAYS_BACK)
        )));
    }
    const tiles = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (tiles.length === 0) {
        throw results[0].reason;
    }

    // Straight-line prefilter, then cap OSRM work to the richest candidates
    const candidates = dedupeHotspotsById(tiles)
        .filter(h => calculateDistance(origin.lat, origin.lng, h.lat, h.lng) <= radiusKm)
        .sort((a, b) => (b.numSpeciesAllTime || 0) - (a.numSpeciesAllTime || 0))
        .slice(0, CONFIG.DRIVE_TIME.MAX_CANDIDATES);

    // Real drive times decide membership
    const routes = await getDriveDurations(origin, candidates, signal);
    const limitSeconds = minutes * SECONDS_PER_MINUTE;

    return candidates
        .map((h, i) => ({ hotspot: h, route: routes[i] }))
        .filter(({ route }) => route && route.duration <= limitSeconds)
        .map(({ hotspot, route }) => ({
            ...hotspot,
            driveDuration: route.duration,
            driveDistance: route.distance
        }));
}
