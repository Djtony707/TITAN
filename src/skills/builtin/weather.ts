/**
 * TITAN — Weather Skill (Built-in)
 * Real-time weather data via wttr.in (free, no API key required).
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Weather';

interface WttrCurrent {
    temp_F: string;
    temp_C: string;
    FeelsLikeF: string;
    FeelsLikeC: string;
    humidity: string;
    weatherDesc: Array<{ value: string }>;
    windspeedMiles: string;
    winddir16Point: string;
    uvIndex: string;
    visibility: string;
    pressureInches: string;
    cloudcover: string;
    precipInches: string;
}

interface WttrHourly {
    time: string;
    tempF: string;
    tempC: string;
    FeelsLikeF: string;
    weatherDesc: Array<{ value: string }>;
    windspeedMiles: string;
    winddir16Point: string;
    humidity: string;
    chanceofrain: string;
    uvIndex: string;
}

interface WttrDay {
    date: string;
    maxtempF: string;
    mintempF: string;
    maxtempC: string;
    mintempC: string;
    totalSnow_cm: string;
    sunHour: string;
    astronomy: Array<{
        sunrise: string;
        sunset: string;
        moon_phase: string;
        moon_illumination: string;
    }>;
    hourly: WttrHourly[];
}

interface WttrResponse {
    current_condition: WttrCurrent[];
    weather: WttrDay[];
    nearest_area: Array<{
        areaName: Array<{ value: string }>;
        region: Array<{ value: string }>;
        country: Array<{ value: string }>;
    }>;
}

function formatCurrent(c: WttrCurrent, area: string): string {
    return [
        `**Current Weather for ${area}**`,
        `Temperature: ${c.temp_F}°F (${c.temp_C}°C) — Feels like ${c.FeelsLikeF}°F`,
        `Conditions: ${c.weatherDesc?.[0]?.value || 'Unknown'}`,
        `Humidity: ${c.humidity}%`,
        `Wind: ${c.windspeedMiles} mph ${c.winddir16Point}`,
        `UV Index: ${c.uvIndex}`,
        `Cloud Cover: ${c.cloudcover}%`,
        `Visibility: ${c.visibility} miles`,
        c.precipInches !== '0' ? `Precipitation: ${c.precipInches} in` : null,
    ].filter(Boolean).join('\n');
}

function formatForecast(day: WttrDay, label: string): string {
    const astro = day.astronomy?.[0];
    const lines = [
        `**${label} (${day.date})**`,
        `High: ${day.maxtempF}°F (${day.maxtempC}°C) | Low: ${day.mintempF}°F (${day.mintempC}°C)`,
        `Sun Hours: ${day.sunHour}`,
    ];
    if (astro) {
        lines.push(`Sunrise: ${astro.sunrise} | Sunset: ${astro.sunset}`);
        lines.push(`Moon: ${astro.moon_phase} (${astro.moon_illumination}% illumination)`);
    }
    if (parseFloat(day.totalSnow_cm) > 0) {
        lines.push(`Snow: ${day.totalSnow_cm} cm`);
    }

    // Summarize key hourly periods
    const periods = [
        { name: 'Morning', hours: ['600', '900'] },
        { name: 'Afternoon', hours: ['1200', '1500'] },
        { name: 'Evening', hours: ['1800', '2100'] },
    ];
    for (const p of periods) {
        const matching = day.hourly.filter(h => p.hours.includes(h.time));
        if (matching.length > 0) {
            const h = matching[matching.length - 1]; // use later hour
            lines.push(`  ${p.name}: ${h.tempF}°F, ${h.weatherDesc?.[0]?.value || ''}, Wind ${h.windspeedMiles} mph ${h.winddir16Point}, ${h.chanceofrain}% rain chance`);
        }
    }

    return lines.join('\n');
}

export function registerWeatherSkill(): void {
    registerSkill(
        { name: 'weather', description: 'Get real-time weather', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'weather',
            description: 'Get real-time weather conditions and multi-day forecast for any location.\n\nUSE THIS WHEN Tony says: "what\'s the weather" / "weather in X" / "temperature in X" / "will it rain in X" / "how hot is it in X" / "forecast for X" / "what\'s it like outside in X"\n\nRULES:\n- Call this tool directly — do NOT ask Tony for location if he already mentioned it\n- Infer the location from context if Tony just says "what\'s the weather" (ask only if truly no location is available)\n- Accepts city names, zip codes, coordinates, or airport codes\n- Use days:3 for multi-day forecasts',
            parameters: {
                type: 'object',
                properties: {
                    location: {
                        type: 'string',
                        description: 'Location to get weather for (city name, zip code, coordinates, or airport code). Examples: "San Francisco", "95451", "48.8566,2.3522", "JFK"',
                    },
                    days: {
                        type: 'number',
                        description: 'Number of forecast days (1-3, default: 1)',
                    },
                },
                required: ['location'],
            },
            execute: async (args) => {
                const location = args.location as string;
                const days = Math.min(Math.max((args.days as number) || 1, 1), 3);
                logger.info(COMPONENT, `Weather lookup: ${location} (${days} day forecast)`);

                try {
                    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
                    const response = await fetch(url, {
                        headers: { 'User-Agent': 'TITAN/1.0' },
                        signal: AbortSignal.timeout(10000),
                    });

                    if (!response.ok) {
                        return `Weather lookup failed (HTTP ${response.status}). Try a different location format — city name, zip code, or coordinates.`;
                    }

                    const data = await response.json() as WttrResponse;

                    if (!data.current_condition?.length) {
                        return `No weather data available for "${location}". Try a different location.`;
                    }

                    const area = data.nearest_area?.[0];
                    const areaName = area
                        ? `${area.areaName?.[0]?.value}, ${area.region?.[0]?.value}`
                        : location;

                    const sections: string[] = [];

                    // Current conditions
                    sections.push(formatCurrent(data.current_condition[0], areaName));

                    // Forecast days
                    const dayLabels = ['Today', 'Tomorrow', 'Day After Tomorrow'];
                    for (let i = 0; i < days && i < data.weather.length; i++) {
                        sections.push(formatForecast(data.weather[i], dayLabels[i] || `Day ${i + 1}`));
                    }

                    return sections.join('\n\n');
                } catch (error) {
                    return `Weather error: ${(error as Error).message}`;
                }
            },
        },
    );
}
