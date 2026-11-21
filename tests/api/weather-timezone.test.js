import { assert } from '../run-tests.js';

// Mock localStorage (weather.js persists a cache there) before importing
const _store = {};
global.localStorage = {
    getItem: (k) => _store[k] ?? null,
    setItem: (k, v) => { _store[k] = v; },
    removeItem: (k) => { delete _store[k]; }
};

const { getWeatherForLocation, getGoldenHourStatus } = await import('../../js/api/weather.js');

/**
 * Build a canned Open-Meteo response for a location `utcOffsetSeconds` away
 * from UTC, with sunrise/sunset given as the hotspot's own local wall clock
 * (exactly how Open-Meteo's timezone=auto mode returns them).
 */
function mockOpenMeteoResponse({ utcOffsetSeconds, currentTimeLocal, sunriseLocal, sunsetLocal }) {
    return {
        utc_offset_seconds: utcOffsetSeconds,
        current: {
            time: `2026-08-20T${currentTimeLocal}`,
            temperature_2m: 20,
            relative_humidity_2m: 50,
            precipitation: 0,
            weather_code: 1,
            wind_speed_10m: 10,
            wind_direction_10m: 180
        },
        hourly: {
            precipitation_probability: Array.from({ length: 24 }, (_, h) => h) // index === hour, for easy assertion
        },
        daily: {
            sunrise: [`2026-08-20T${sunriseLocal}`],
            sunset: [`2026-08-20T${sunsetLocal}`]
        }
    };
}

function installFetchMock(response) {
    global.fetch = async () => ({ ok: true, json: async () => response });
}

export async function testSunriseSunsetDisplayIsHotspotLocalTime() {
    // A traveler whose own device is far from this hotspot's timezone (UTC-4)
    // should still see the hotspot's own 6:15 AM / 8:00 PM wall-clock times.
    installFetchMock(mockOpenMeteoResponse({
        utcOffsetSeconds: -4 * 3600,
        currentTimeLocal: '14:00',
        sunriseLocal: '06:15',
        sunsetLocal: '20:00'
    }));

    const weather = await getWeatherForLocation(40.71, -74.00);
    assert(weather.sunrise === '6:15 AM', `Expected sunrise "6:15 AM", got "${weather.sunrise}"`);
    assert(weather.sunset === '8:00 PM', `Expected sunset "8:00 PM", got "${weather.sunset}"`);
}

export async function testSunriseDateIsTrueUtcInstantNotBrowserLocal() {
    const utcOffsetSeconds = -4 * 3600; // UTC-4
    installFetchMock(mockOpenMeteoResponse({
        utcOffsetSeconds,
        currentTimeLocal: '14:00',
        sunriseLocal: '06:15',
        sunsetLocal: '20:00'
    }));

    const weather = await getWeatherForLocation(40.71, -74.00);
    // 06:15 local at UTC-4 is 10:15 UTC, regardless of what timezone this
    // test happens to run in.
    const expected = Date.parse('2026-08-20T10:15:00Z');
    assert(weather.sunriseDate.getTime() === expected,
        `Expected true UTC instant ${new Date(expected).toISOString()}, got ${weather.sunriseDate.toISOString()}`);
}

export async function testPrecipitationProbabilityUsesHotspotLocalHourNotBrowserHour() {
    installFetchMock(mockOpenMeteoResponse({
        utcOffsetSeconds: -4 * 3600,
        currentTimeLocal: '09:00', // hotspot's local "now" hour is 9am
        sunriseLocal: '06:15',
        sunsetLocal: '20:00'
    }));

    const weather = await getWeatherForLocation(40.71, -74.00);
    // The mocked hourly array is `index === hour`, so hour 9 should read back as 9,
    // proving the lookup used the hotspot's local hour (from current.time) and not
    // whatever hour it happens to be for the machine running this test.
    assert(weather.precipitationProbability === 9,
        `Expected precipitation probability for local hour 9, got ${weather.precipitationProbability}`);
}

export async function testGoldenHourStatusMorning() {
    const now = Date.now();
    const status = getGoldenHourStatus({
        sunriseDate: new Date(now - 30 * 60 * 1000), // sunrise 30 min ago
        sunsetDate: new Date(now + 8 * 60 * 60 * 1000)
    });
    assert(status === 'morning', `Expected 'morning', got '${status}'`);
}

export async function testGoldenHourStatusEvening() {
    const now = Date.now();
    const status = getGoldenHourStatus({
        sunriseDate: new Date(now - 8 * 60 * 60 * 1000),
        sunsetDate: new Date(now + 30 * 60 * 1000) // sunset in 30 min
    });
    assert(status === 'evening', `Expected 'evening', got '${status}'`);
}

export async function testGoldenHourStatusMidday() {
    const now = Date.now();
    const status = getGoldenHourStatus({
        sunriseDate: new Date(now - 4 * 60 * 60 * 1000),
        sunsetDate: new Date(now + 4 * 60 * 60 * 1000)
    });
    assert(status === null, `Expected null (midday), got '${status}'`);
}

// After sunset, weather describes tomorrow morning (the next time anyone goes birding)
function twoDayResponse(currentTimeLocal) {
    const hours = Array.from({ length: 48 }, (_, i) => i);
    return {
        utc_offset_seconds: -5 * 3600,
        current: { time: `2026-11-19T${currentTimeLocal}`, temperature_2m: 2, relative_humidity_2m: 80, precipitation: 0, weather_code: 3, wind_speed_10m: 20, wind_direction_10m: 0 },
        hourly: {
            time: hours.map(i => `2026-11-${i < 24 ? 19 : 20}T${String(i % 24).padStart(2, '0')}:00`),
            temperature_2m: hours.map(i => i),               // value === index, for easy assertion
            relative_humidity_2m: hours.map(() => 60),
            precipitation_probability: hours.map(i => i),
            weather_code: hours.map(() => 0),
            wind_speed_10m: hours.map(() => 8),
            wind_direction_10m: hours.map(() => 270)
        },
        daily: {
            sunrise: ['2026-11-19T06:49', '2026-11-20T06:50'],
            sunset: ['2026-11-19T16:30', '2026-11-20T16:29']
        }
    };
}

export async function testAfterSunsetShowsTomorrowMorning() {
    for (const k of Object.keys(_store)) delete _store[k];
    installFetchMock(twoDayResponse('19:00'));
    const weather = await getWeatherForLocation(42.65, -73.75);
    assert(weather.forTomorrow === true, 'After sunset the forecast should be for tomorrow');
    assert(weather.sunrise === '6:50 AM', `Expected tomorrow's sunrise, got ${weather.sunrise}`);
    // First full hour after tomorrow's 6:50 sunrise is 07:00 = hourly index 31
    assert(weather.temperatureC === 31, `Expected tomorrow 7 AM temperature (31), got ${weather.temperatureC}`);
    assert(weather.forecastLabel === 'Tomorrow morning', `Unexpected label ${weather.forecastLabel}`);
}

export async function testBeforeSunsetShowsNow() {
    for (const k of Object.keys(_store)) delete _store[k];
    installFetchMock(twoDayResponse('11:00'));
    const weather = await getWeatherForLocation(42.66, -73.76);
    assert(!weather.forTomorrow, 'Daytime forecast should describe now');
    assert(weather.temperatureC === 2, `Expected current temperature 2, got ${weather.temperatureC}`);
}
