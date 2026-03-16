/**
 * TITAN — Web Search Skill (Built-in)
 * Search the web and retrieve information.
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'WebSearch';

/** Detect weather queries and extract the location */
function extractWeatherLocation(query: string): string | null {
    const q = query.toLowerCase();
    // Must contain a weather keyword
    if (!/\b(weather|forecast|temperature|temp\b|rain|snow|humidity|wind speed|uv index|sunrise|sunset)\b/.test(q)) return null;
    // Strip weather keywords and common filler to get the location
    const location = q
        .replace(/\b(weather|forecast|temperature|temp|today|tonight|tomorrow|this week|current|right now|conditions|for|in|at|the|what|is|whats|what's|check|get|show|me|please|how|hot|cold|rain|snow|humidity|wind)\b/g, '')
        .replace(/[?,!.]/g, '')
        .trim()
        .replace(/\s+/g, ' ');
    return location.length >= 2 ? location : null;
}

/** Fetch weather from wttr.in and format it */
async function fetchWeather(location: string): Promise<string | null> {
    try {
        const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'TITAN/1.0' },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return null;
        const data = await response.json() as Record<string, unknown>;
        const current = (data.current_condition as Array<Record<string, unknown>>)?.[0];
        const area = (data.nearest_area as Array<Record<string, unknown>>)?.[0];
        const weather = (data.weather as Array<Record<string, unknown>>)?.[0];
        if (!current) return null;

        const areaName = area
            ? `${(area.areaName as Array<{value: string}>)?.[0]?.value}, ${(area.region as Array<{value: string}>)?.[0]?.value}`
            : location;
        const desc = (current.weatherDesc as Array<{value: string}>)?.[0]?.value || 'Unknown';
        const astro = (weather?.astronomy as Array<Record<string, string>>)?.[0];

        const lines = [
            `**Current Weather for ${areaName}**`,
            `Temperature: ${current.temp_F}°F (${current.temp_C}°C) — Feels like ${current.FeelsLikeF}°F`,
            `Conditions: ${desc}`,
            `Humidity: ${current.humidity}%`,
            `Wind: ${current.windspeedMiles} mph ${current.winddir16Point}`,
            `UV Index: ${current.uvIndex}`,
            `Cloud Cover: ${current.cloudcover}%`,
            `Visibility: ${current.visibility} miles`,
        ];
        if (weather) {
            lines.push('', `**Today's Forecast**`);
            lines.push(`High: ${weather.maxtempF}°F | Low: ${weather.mintempF}°F`);
            if (astro) {
                lines.push(`Sunrise: ${astro.sunrise} | Sunset: ${astro.sunset}`);
            }
            // Hourly periods
            const hourly = weather.hourly as Array<Record<string, unknown>> | undefined;
            if (hourly) {
                const periods = [
                    { name: 'Morning', time: '900' },
                    { name: 'Afternoon', time: '1500' },
                    { name: 'Evening', time: '1800' },
                    { name: 'Tonight', time: '2100' },
                ];
                for (const p of periods) {
                    const h = hourly.find(hr => hr.time === p.time);
                    if (h) {
                        const hDesc = (h.weatherDesc as Array<{value: string}>)?.[0]?.value || '';
                        lines.push(`  ${p.name}: ${h.tempF}°F, ${hDesc}, Wind ${h.windspeedMiles} mph ${h.winddir16Point}, ${h.chanceofrain}% rain`);
                    }
                }
            }
        }
        return lines.join('\n');
    } catch {
        return null;
    }
}

export function registerWebSearchSkill(): void {
    registerSkill(
        { name: 'web_search', description: 'Search the web', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'web_search',
            description: 'Search the web and return the top results with titles, URLs, and snippets.\n\nUSE THIS WHEN Tony says: "search for X" / "look up X" / "find info on X" / "what is X" / "latest news on X" / "google X" / "who is X" / "how do I X"\n\nWORKFLOW:\n1. Call web_search with the query\n2. ALWAYS follow up by calling web_fetch on the most relevant result URL(s) to get the full content — snippets alone are not enough\n3. Synthesize the full content into an answer\n\nNEVER just return snippets as the final answer — always fetch the full page.\nFor weather queries ("what\'s the weather in X"), this tool auto-detects and returns real-time weather data directly.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query' },
                    maxResults: { type: 'number', description: 'Maximum results to return (default: 5)' },
                },
                required: ['query'],
            },
            execute: async (args) => {
                const query = args.query as string;
                const maxResults = (args.maxResults as number) || 5;
                logger.info(COMPONENT, `Searching: ${query}`);

                // Smart detect: weather queries get real-time data from wttr.in
                const weatherLocation = extractWeatherLocation(query);
                if (weatherLocation) {
                    logger.info(COMPONENT, `Weather query detected → fetching real-time data for: ${weatherLocation}`);
                    const weatherResult = await fetchWeather(weatherLocation);
                    if (weatherResult) return weatherResult;
                    // Fall through to web search if wttr.in fails
                }

                try {
                    // Use DuckDuckGo HTML search as a fallback (no API key required)
                    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
                    const response = await fetch(url, {
                        headers: {
                            'User-Agent': 'TITAN/1.0 (Autonomous AI Agent)',
                        },
                    });

                    if (!response.ok) {
                        return `Search failed with status ${response.status}`;
                    }

                    const html = await response.text();

                    // Parse results from DuckDuckGo HTML
                    const results: Array<{ title: string; url: string; snippet: string }> = [];
                    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;
                    let match;

                    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
                        const rawUrl = match[1];
                        const title = match[2].replace(/<[^>]*>/g, '').trim();
                        const snippet = match[3].replace(/<[^>]*>/g, '').trim();

                        // Decode DuckDuckGo redirect URL
                        const urlMatch = rawUrl.match(/uddg=([^&]*)/);
                        const decodedUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : rawUrl;

                        if (title && decodedUrl) {
                            results.push({ title, url: decodedUrl, snippet });
                        }
                    }

                    if (results.length === 0) {
                        return `No results found for: "${query}"`;
                    }

                    return results
                        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
                        .join('\n\n');
                } catch (error) {
                    return `Search error: ${(error as Error).message}`;
                }
            },
        },
    );
}
