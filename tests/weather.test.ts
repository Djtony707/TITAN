/**
 * TITAN -- Weather Skill Tests
 * Tests src/skills/builtin/weather.ts: weather tool registration and execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture registered skills/tools
let registeredTool: { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> } | null = null;

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, tool: unknown) => {
        registeredTool = tool as typeof registeredTool;
    },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { registerWeatherSkill } from '../src/skills/builtin/weather.js';

// ─── Sample API response ─────────────────────────────────────────

const sampleWttrResponse = {
    current_condition: [{
        temp_F: '72',
        temp_C: '22',
        FeelsLikeF: '74',
        FeelsLikeC: '23',
        humidity: '55',
        weatherDesc: [{ value: 'Partly cloudy' }],
        windspeedMiles: '8',
        winddir16Point: 'NW',
        uvIndex: '5',
        visibility: '10',
        pressureInches: '30',
        cloudcover: '40',
        precipInches: '0',
    }],
    weather: [
        {
            date: '2026-03-16',
            maxtempF: '78',
            mintempF: '62',
            maxtempC: '26',
            mintempC: '17',
            totalSnow_cm: '0',
            sunHour: '10.5',
            astronomy: [{
                sunrise: '06:45 AM',
                sunset: '07:15 PM',
                moon_phase: 'Waxing Crescent',
                moon_illumination: '25',
            }],
            hourly: [
                { time: '600', tempF: '64', tempC: '18', FeelsLikeF: '63', weatherDesc: [{ value: 'Clear' }], windspeedMiles: '5', winddir16Point: 'N', humidity: '70', chanceofrain: '5', uvIndex: '1' },
                { time: '900', tempF: '68', tempC: '20', FeelsLikeF: '67', weatherDesc: [{ value: 'Sunny' }], windspeedMiles: '7', winddir16Point: 'NW', humidity: '60', chanceofrain: '5', uvIndex: '3' },
                { time: '1200', tempF: '74', tempC: '23', FeelsLikeF: '75', weatherDesc: [{ value: 'Partly cloudy' }], windspeedMiles: '10', winddir16Point: 'W', humidity: '50', chanceofrain: '10', uvIndex: '6' },
                { time: '1500', tempF: '78', tempC: '26', FeelsLikeF: '79', weatherDesc: [{ value: 'Sunny' }], windspeedMiles: '8', winddir16Point: 'NW', humidity: '45', chanceofrain: '5', uvIndex: '5' },
                { time: '1800', tempF: '73', tempC: '23', FeelsLikeF: '74', weatherDesc: [{ value: 'Clear' }], windspeedMiles: '6', winddir16Point: 'NW', humidity: '55', chanceofrain: '0', uvIndex: '2' },
                { time: '2100', tempF: '67', tempC: '19', FeelsLikeF: '66', weatherDesc: [{ value: 'Clear' }], windspeedMiles: '4', winddir16Point: 'N', humidity: '65', chanceofrain: '0', uvIndex: '0' },
            ],
        },
        {
            date: '2026-03-17',
            maxtempF: '80',
            mintempF: '63',
            maxtempC: '27',
            mintempC: '17',
            totalSnow_cm: '0',
            sunHour: '10.6',
            astronomy: [{
                sunrise: '06:44 AM',
                sunset: '07:16 PM',
                moon_phase: 'Waxing Crescent',
                moon_illumination: '35',
            }],
            hourly: [],
        },
        {
            date: '2026-03-18',
            maxtempF: '75',
            mintempF: '60',
            maxtempC: '24',
            mintempC: '16',
            totalSnow_cm: '0',
            sunHour: '8.2',
            astronomy: [{
                sunrise: '06:43 AM',
                sunset: '07:17 PM',
                moon_phase: 'First Quarter',
                moon_illumination: '50',
            }],
            hourly: [],
        },
    ],
    nearest_area: [{
        areaName: [{ value: 'San Francisco' }],
        region: [{ value: 'California' }],
        country: [{ value: 'United States of America' }],
    }],
};

beforeEach(() => {
    vi.clearAllMocks();
    registeredTool = null;
    registerWeatherSkill();
});

// ─── Registration ────────────────────────────────────────────────

describe('Weather Skill - Registration', () => {
    it('should register a tool named "weather"', () => {
        expect(registeredTool).not.toBeNull();
        expect(registeredTool!.name).toBe('weather');
    });

    it('should have a description', () => {
        expect(registeredTool!.description).toBeTruthy();
        expect(registeredTool!.description.length).toBeGreaterThan(10);
    });

    it('should require location parameter', () => {
        const params = registeredTool!.parameters as { required: string[] };
        expect(params.required).toContain('location');
    });

    it('should accept optional days parameter', () => {
        const params = registeredTool!.parameters as { properties: Record<string, unknown> };
        expect(params.properties).toHaveProperty('days');
    });
});

// ─── Execution — successful responses ────────────────────────────

describe('Weather Skill - Execution', () => {
    it('should return current weather for a location', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco' });
        expect(result).toContain('San Francisco');
        expect(result).toContain('72°F');
        expect(result).toContain('Partly cloudy');
        expect(result).toContain('Humidity: 55%');
    });

    it('should include wind information', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco' });
        expect(result).toContain('8 mph NW');
    });

    it('should include UV index', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco' });
        expect(result).toContain('UV Index: 5');
    });

    it('should include forecast with high/low temps', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco', days: 1 });
        expect(result).toContain('High: 78°F');
        expect(result).toContain('Low: 62°F');
    });

    it('should include sunrise/sunset', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco' });
        expect(result).toContain('Sunrise: 06:45 AM');
        expect(result).toContain('Sunset: 07:15 PM');
    });

    it('should include moon phase', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco' });
        expect(result).toContain('Waxing Crescent');
    });

    it('should include hourly period summaries', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco' });
        expect(result).toContain('Morning');
        expect(result).toContain('Afternoon');
        expect(result).toContain('Evening');
    });
});

// ─── Multi-day forecast ──────────────────────────────────────────

describe('Weather Skill - Multi-day forecast', () => {
    it('should return 3-day forecast when days=3', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco', days: 3 });
        expect(result).toContain('Today');
        expect(result).toContain('Tomorrow');
        expect(result).toContain('Day After Tomorrow');
    });

    it('should default to 1 day forecast', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco' });
        expect(result).toContain('Today');
        expect(result).not.toContain('Day After Tomorrow');
    });

    it('should clamp days to maximum of 3', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco', days: 10 });
        // Should still work — clamped to 3
        expect(result).toContain('Today');
        expect(result).toContain('Tomorrow');
        expect(result).toContain('Day After Tomorrow');
    });

    it('should clamp days to minimum of 1', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'San Francisco', days: 0 });
        expect(result).toContain('Today');
    });
});

// ─── Error handling ──────────────────────────────────────────────

describe('Weather Skill - Error handling', () => {
    it('should handle HTTP errors gracefully', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 404,
        });

        const result = await registeredTool!.execute({ location: 'NonexistentPlace' });
        expect(result).toContain('failed');
        expect(result).toContain('404');
    });

    it('should handle network errors gracefully', async () => {
        mockFetch.mockRejectedValue(new Error('Network timeout'));

        const result = await registeredTool!.execute({ location: 'San Francisco' });
        expect(result).toContain('Weather error');
        expect(result).toContain('Network timeout');
    });

    it('should handle empty current conditions', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ current_condition: [], weather: [], nearest_area: [] }),
        });

        const result = await registeredTool!.execute({ location: 'Nowhere' });
        expect(result).toContain('No weather data');
    });

    it('should handle missing nearest_area gracefully', async () => {
        const responseWithoutArea = {
            ...sampleWttrResponse,
            nearest_area: [],
        };
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => responseWithoutArea,
        });

        const result = await registeredTool!.execute({ location: '95451' });
        // Should still return data, just use the input location
        expect(result).toContain('95451');
    });
});

// ─── Location formats ────────────────────────────────────────────

describe('Weather Skill - Location formats', () => {
    it('should encode city names in URL', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        await registeredTool!.execute({ location: 'New York City' });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('New%20York%20City'),
            expect.any(Object),
        );
    });

    it('should accept zip codes', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        await registeredTool!.execute({ location: '95451' });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('95451'),
            expect.any(Object),
        );
    });

    it('should accept coordinates', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        await registeredTool!.execute({ location: '48.8566,2.3522' });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('48.8566'),
            expect.any(Object),
        );
    });

    it('should send request to wttr.in with json format', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        await registeredTool!.execute({ location: 'London' });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining('wttr.in/London?format=j1'),
            expect.any(Object),
        );
    });

    it('should set User-Agent header', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        await registeredTool!.execute({ location: 'London' });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({ 'User-Agent': 'TITAN/1.0' }),
            }),
        );
    });
});

// ─── Precipitation display ───────────────────────────────────────

describe('Weather Skill - Precipitation', () => {
    it('should show precipitation when non-zero', async () => {
        const rainyResponse = JSON.parse(JSON.stringify(sampleWttrResponse));
        rainyResponse.current_condition[0].precipInches = '0.5';
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => rainyResponse,
        });

        const result = await registeredTool!.execute({ location: 'Seattle' });
        expect(result).toContain('Precipitation: 0.5 in');
    });

    it('should not show precipitation when zero', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => sampleWttrResponse,
        });

        const result = await registeredTool!.execute({ location: 'Phoenix' });
        expect(result).not.toContain('Precipitation');
    });
});

// ─── Snow display ────────────────────────────────────────────────

describe('Weather Skill - Snow', () => {
    it('should show snow when present in forecast', async () => {
        const snowyResponse = JSON.parse(JSON.stringify(sampleWttrResponse));
        snowyResponse.weather[0].totalSnow_cm = '15.2';
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => snowyResponse,
        });

        const result = await registeredTool!.execute({ location: 'Denver' });
        expect(result).toContain('Snow: 15.2 cm');
    });
});
