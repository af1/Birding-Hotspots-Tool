/**
 * Region lists: which species you've seen worldwide, in the ABA Area,
 * per country, per state and per county, derived from one eBird
 * "Download My Data" export (MyEBirdData.csv).
 *
 *   MyEBirdData.csv ──parse──> { world, aba, US, US-NY, US-NY-001, ... }
 *                                   │
 *   hotspot (countryCode, subnational1Code, subnational2Code)
 *                                   │
 *   listForHotspot(target) ──> species already seen there, or null when
 *                              the hotspot is outside the target region
 *                              (nothing there counts as new for that list)
 */

import { CONFIG } from '../utils/constants.js';

const { STORAGE_KEYS } = CONFIG;

export const LIST_LEVEL = Object.freeze({
    WORLD: 'world',
    ABA: 'aba',
    COUNTRY: 'country',
    STATE: 'state',
    COUNTY: 'county'
});

const WORLD_KEY = 'world';
const ABA_KEY = 'aba';

// ABA Area: US (including Hawaii since 2016), Canada, St. Pierre et Miquelon
const ABA_COUNTRIES = new Set(['US', 'CA', 'PM']);

// Taxa that never count toward a list (e.g. "gull sp.", "Mallard x Black Duck")
const UNCOUNTABLE_CATEGORIES = new Set(['spuh', 'slash', 'hybrid', 'domestic']);

const COLUMN = Object.freeze({
    COMMON: 'common name',
    SCIENTIFIC: 'scientific name',
    STATE: 'state/province',
    COUNTY: 'county'
});

/**
 * Split one CSV line, honoring quotes and doubled quotes.
 * Example: 'a,"b, c",d' -> ['a', 'b, c', 'd']
 */
function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' && inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
            continue;
        }
        if (char === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (char === ',' && !inQuotes) {
            values.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    values.push(current);
    return values;
}

/**
 * Resolve a CSV row to the species code it counts as, or null when uncountable.
 * Subspecies/forms count as their parent species via taxonomy `reportAs`.
 */
function resolveSpecies(commonName, sciName, byCommon, bySci) {
    const taxon = byCommon.get(commonName.toLowerCase()) || bySci.get(sciName.toLowerCase());
    if (!taxon) {
        return { code: null, name: commonName.toLowerCase() };
    }
    if (UNCOUNTABLE_CATEGORIES.has(taxon.category)) {
        return null;
    }
    return { code: taxon.reportAs || taxon.speciesCode, name: taxon.comName.toLowerCase() };
}

function addTo(lists, key, level, species) {
    if (!lists.has(key)) {
        lists.set(key, { key, level, codes: new Set(), names: new Set() });
    }
    const list = lists.get(key);
    if (species.code) {
        list.codes.add(species.code);
    }
    list.names.add(species.name);
}

/**
 * Build every list from a MyEBirdData.csv string.
 * County keys are provisional ("US-NY|Albany") until resolveCountyCodes runs.
 * @returns {{lists: Map, rows: number, error: string|null}}
 */
export function parseEbirdData(csv, taxonomy = []) {
    const lists = new Map();
    const lines = csv.split(/\r?\n/);
    const header = parseCSVLine(lines[0] || '').map(h => h.trim().toLowerCase());
    const idx = {
        common: header.indexOf(COLUMN.COMMON),
        sci: header.indexOf(COLUMN.SCIENTIFIC),
        state: header.indexOf(COLUMN.STATE),
        county: header.indexOf(COLUMN.COUNTY)
    };

    if (idx.common === -1 || idx.state === -1) {
        return {
            lists, rows: 0,
            error: 'This is not an eBird "Download My Data" file (missing "Common Name" or "State/Province" columns).'
        };
    }

    // Taxonomy lookups, so forms and subspecies roll up to species codes
    const byCommon = new Map();
    const bySci = new Map();
    for (const t of taxonomy) {
        if (t.comName) { byCommon.set(t.comName.toLowerCase(), t); }
        if (t.sciName) { bySci.set(t.sciName.toLowerCase(), t); }
    }

    let rows = 0;
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) {
            continue;
        }
        const v = parseCSVLine(lines[i]);
        const species = resolveSpecies(v[idx.common] || '', v[idx.sci] || '', byCommon, bySci);
        if (!species) {
            continue;
        }
        rows++;

        // Every sighting feeds world, then the narrower lists it falls in
        const state = (v[idx.state] || '').trim();
        const country = state.split('-')[0];
        const county = idx.county === -1 ? '' : (v[idx.county] || '').trim();

        addTo(lists, WORLD_KEY, LIST_LEVEL.WORLD, species);
        if (ABA_COUNTRIES.has(country)) { addTo(lists, ABA_KEY, LIST_LEVEL.ABA, species); }
        if (country) { addTo(lists, country, LIST_LEVEL.COUNTRY, species); }
        if (state.includes('-')) { addTo(lists, state, LIST_LEVEL.STATE, species); }
        if (state && county) { addTo(lists, `${state}|${county}`, LIST_LEVEL.COUNTY, species); }
    }

    return { lists, rows, error: null };
}

/**
 * Replace provisional county keys with eBird codes and attach display labels.
 * `fetchSubregions(type, parent)` returns eBird [{code, name}] lists.
 * Lookup failures keep the provisional key and code-based label.
 */
export async function labelLists(lists, fetchSubregions) {
    const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const states = [...lists.values()].filter(l => l.level === LIST_LEVEL.STATE).map(l => l.key);
    const countries = [...new Set(states.map(s => s.split('-')[0]))];

    // State names per country, county codes per state (one API call each)
    const stateNames = new Map();
    for (const country of countries) {
        const regions = await fetchSubregions('subnational1', country).catch(() => []);
        regions.forEach(r => stateNames.set(r.code, r.name));
    }
    const countyCodes = new Map();
    for (const state of states) {
        const regions = await fetchSubregions('subnational2', state).catch(() => []);
        regions.forEach(r => countyCodes.set(`${state}|${r.name}`, r.code));
    }

    const labeled = [];
    for (const list of lists.values()) {
        labeled.push(labelOne(list, countryNames, stateNames, countyCodes));
    }
    return labeled;
}

function labelOne(list, countryNames, stateNames, countyCodes) {
    const out = { ...list };
    if (list.level === LIST_LEVEL.WORLD) {
        out.label = 'Worldwide (life list)';
    } else if (list.level === LIST_LEVEL.ABA) {
        out.label = 'ABA Area';
    } else if (list.level === LIST_LEVEL.COUNTRY) {
        out.label = countryNames.of(list.key) || list.key;
    } else if (list.level === LIST_LEVEL.STATE) {
        out.label = stateNames.get(list.key) || list.key;
    } else {
        const [state, county] = list.key.split('|');
        out.key = countyCodes.get(list.key) || list.key;
        out.label = `${county} County, ${stateNames.get(state) || state}`;
    }
    return out;
}

/**
 * Does a hotspot lie inside the list's region?
 * Example: Albany County list (US-NY-001) contains hotspots whose subnational2Code is US-NY-001.
 */
export function regionContains(list, hotspot) {
    switch (list.level) {
        case LIST_LEVEL.WORLD: return true;
        case LIST_LEVEL.ABA: return ABA_COUNTRIES.has(hotspot.countryCode);
        case LIST_LEVEL.COUNTRY: return hotspot.countryCode === list.key;
        case LIST_LEVEL.STATE: return hotspot.subnational1Code === list.key;
        default: return hotspot.subnational2Code === list.key;
    }
}

const LEVEL_ORDER = [LIST_LEVEL.WORLD, LIST_LEVEL.ABA, LIST_LEVEL.COUNTRY, LIST_LEVEL.STATE, LIST_LEVEL.COUNTY];

/** Order for the picker: broad to narrow, then alphabetical. */
export function sortLists(lists) {
    return [...lists].sort((a, b) =>
        LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.label.localeCompare(b.label));
}

/** Persist labeled lists (Sets serialized as arrays). */
export function saveRegionLists(lists) {
    const plain = lists.map(l => ({ key: l.key, level: l.level, label: l.label, codes: [...l.codes], names: [...l.names] }));
    localStorage.setItem(STORAGE_KEYS.REGION_LISTS, JSON.stringify(plain));
}

/** Load lists with Sets restored; [] when absent or unreadable. */
export function loadRegionLists() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.REGION_LISTS) || '[]');
        return raw.map(l => ({ ...l, codes: new Set(l.codes), names: new Set(l.names) }));
    } catch (e) {
        console.warn('Could not read region lists:', e);
        return [];
    }
}

export function clearRegionLists() {
    try {
        localStorage.removeItem(STORAGE_KEYS.REGION_LISTS);
    } catch (e) {
        console.warn('Could not clear region lists:', e);
    }
}
