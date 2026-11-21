import { assert } from '../run-tests.js';
import { parseEbirdData, labelLists, regionContains, sortLists, LIST_LEVEL } from '../../js/services/region-lists.js';

const HEADER = 'Submission ID,Common Name,Scientific Name,Taxonomic Order,Count,State/Province,County,Location ID,Location';
const CSV = [
    HEADER,
    'S1,Blue Jay,Cyanocitta cristata,1,1,US-NY,Albany,L1,"Five Rivers, Delmar"',
    'S2,Northern Cardinal,Cardinalis cardinalis,2,1,US-NY,Schenectady,L2,Park',
    'S3,Gray Jay,Perisoreus canadensis,3,1,CA-ON,Algoma,L3,Trail',
    'S4,gull sp.,Larus sp.,4,1,US-NY,Albany,L1,Five Rivers',
    'S5,Great Tit,Parus major,5,1,GB-ENG,Kent,L4,Wood'
].join('\n');

const TAXONOMY = [
    { comName: 'Blue Jay', sciName: 'Cyanocitta cristata', speciesCode: 'blujay', category: 'species' },
    { comName: 'Northern Cardinal', sciName: 'Cardinalis cardinalis', speciesCode: 'norcar', category: 'species' },
    { comName: 'Gray Jay', sciName: 'Perisoreus canadensis', speciesCode: 'gryjay', category: 'species' },
    { comName: 'gull sp.', sciName: 'Larus sp.', speciesCode: 'gull1', category: 'spuh' },
    { comName: 'Great Tit', sciName: 'Parus major', speciesCode: 'gretit1', category: 'species' }
];

export async function testBuildsEveryLevel() {
    const { lists, rows } = parseEbirdData(CSV, TAXONOMY);
    assert(rows === 4, `spuh row should be skipped, got ${rows} rows`);
    assert(lists.get('world').codes.size === 4, 'world has all 4 species');
    assert(lists.get('aba').codes.size === 3, 'ABA excludes the UK bird');
    assert(lists.get('US-NY').codes.size === 2, 'NY has jay and cardinal');
    assert([...lists.get('US-NY|Albany').codes].join() === 'blujay', 'Albany has only Blue Jay');
}

export async function testRejectsNonDataFile() {
    const { error } = parseEbirdData('Species,Count\nBlue Jay,1', TAXONOMY);
    assert(error, 'a life-list CSV without State/Province must be rejected');
}

export async function testLabelsResolveCountyCodes() {
    const { lists } = parseEbirdData(CSV, TAXONOMY);
    const fake = async (type, parent) => {
        if (type === 'subnational1' && parent === 'US') { return [{ code: 'US-NY', name: 'New York' }]; }
        if (type === 'subnational2' && parent === 'US-NY') { return [{ code: 'US-NY-001', name: 'Albany' }]; }
        return [];
    };
    const labeled = await labelLists(lists, fake);
    const albany = labeled.find(l => l.key === 'US-NY-001');
    assert(albany && albany.label === 'Albany County, New York', `got ${albany?.label}`);
    assert(sortLists(labeled)[0].level === LIST_LEVEL.WORLD, 'world sorts first');
}

export async function testRegionContainsHotspot() {
    const county = { level: LIST_LEVEL.COUNTY, key: 'US-NY-001' };
    const aba = { level: LIST_LEVEL.ABA, key: 'aba' };
    const inAlbany = { countryCode: 'US', subnational1Code: 'US-NY', subnational2Code: 'US-NY-001' };
    const inSchenectady = { countryCode: 'US', subnational1Code: 'US-NY', subnational2Code: 'US-NY-093' };
    assert(regionContains(county, inAlbany), 'Albany hotspot is in Albany');
    assert(!regionContains(county, inSchenectady), 'Schenectady hotspot is not in Albany');
    assert(regionContains(aba, inSchenectady), 'NY is in the ABA Area');
}

// eBird counts "Rock Pigeon (Feral Pigeon)" as Rock Pigeon; other domestic types never count
export async function testFeralPigeonCountsAsRockPigeon() {
    const csv = [
        HEADER,
        'S9,Rock Pigeon (Feral Pigeon),Columba livia (Feral Pigeon),1,1,US-NY,Albany,L1,Downtown',
        'S10,Mallard (Domestic type),Anas platyrhynchos (Domestic type),2,1,US-NY,Albany,L1,Pond'
    ].join('\n');
    const taxonomy = [
        { comName: 'Rock Pigeon (Feral Pigeon)', sciName: 'Columba livia (Feral Pigeon)', speciesCode: 'rocpig1', category: 'domestic', reportAs: 'rocpig' },
        { comName: 'Mallard (Domestic type)', sciName: 'Anas platyrhynchos (Domestic type)', speciesCode: 'mallar2', category: 'domestic', reportAs: 'mallar3' }
    ];
    const { lists } = parseEbirdData(csv, taxonomy);
    const world = lists.get('world');
    assert(world && world.codes.has('rocpig'), 'Feral Pigeon sighting should put Rock Pigeon on the list');
    assert(!world.codes.has('mallar3'), 'Domestic Mallard must not count as Mallard');
}
