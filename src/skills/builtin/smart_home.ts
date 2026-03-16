/**
 * TITAN — Smart Home Skill (Built-in)
 * Control and monitor Home Assistant devices via REST API.
 * 11 tools: setup, devices, control, status, automations, scenes, history, areas, call_service, dashboard, notify.
 */
import { registerSkill } from '../registry.js';
import { loadConfig, updateConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

interface HAEntity {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
    last_changed: string;
    last_updated: string;
}

interface HAStateResponse {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
    last_changed: string;
    last_updated: string;
}

/** Shared skill metadata — all tools share the same skill name */
const SKILL_META = {
    name: 'smart_home',
    description:
        'Use this for any home control, status, or setup request — "turn on the lights", "set thermostat to X", "lock the doors", "what\'s the temperature inside", "turn off everything", "show me my smart home devices", "run automation", "activate scene", "connect to Home Assistant", "here\'s my HA token". Also use when the user pastes a Home Assistant URL or access token (JWT starting with eyJ...). Controls Home Assistant via REST API.',
    version: '2.0.0',
    source: 'bundled' as const,
    enabled: true,
};

/**
 * Get Home Assistant URL from environment or config
 */
function getHAUrl(): string {
    if (process.env.HOME_ASSISTANT_URL) return process.env.HOME_ASSISTANT_URL;
    try {
        const config = loadConfig();
        return config.homeAssistant?.url || '';
    } catch {
        return '';
    }
}

/**
 * Get Home Assistant token from environment or config
 */
function getHAToken(): string {
    if (process.env.HOME_ASSISTANT_TOKEN) return process.env.HOME_ASSISTANT_TOKEN;
    try {
        const config = loadConfig();
        return config.homeAssistant?.token || '';
    } catch {
        return '';
    }
}

/**
 * Make an authenticated request to Home Assistant API
 */
async function haRequest(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, unknown>
): Promise<unknown> {
    const url = getHAUrl();
    const token = getHAToken();

    if (!url || !token) {
        throw new Error(
            'Home Assistant not configured. Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN environment variables, or configure via Settings → Home Assistant.'
        );
    }

    const fullUrl = `${url}${endpoint}`;
    const options: RequestInit = {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(fullUrl, options);
    if (!response.ok) {
        throw new Error(`Home Assistant API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

/**
 * Format device state info into readable output
 */
function formatStateInfo(entity: HAEntity): string {
    const lines: string[] = [];
    lines.push(`Entity: ${entity.entity_id}`);
    lines.push(`State: ${entity.state}`);

    if (Object.keys(entity.attributes).length > 0) {
        lines.push('Attributes:');
        for (const [key, value] of Object.entries(entity.attributes)) {
            lines.push(`  ${key}: ${JSON.stringify(value)}`);
        }
    }

    lines.push(`Last Updated: ${entity.last_updated}`);
    return lines.join('\n');
}

/**
 * Format a list of devices into a table
 */
function formatDeviceList(entities: HAEntity[]): string {
    if (entities.length === 0) {
        return 'No devices found.';
    }

    const lines: string[] = [];
    lines.push(`Found ${entities.length} device(s):\n`);

    for (const entity of entities) {
        const attrs = entity.attributes as Record<string, unknown>;
        const friendly_name = (attrs.friendly_name as string) || entity.entity_id;
        lines.push(`• ${friendly_name} (${entity.entity_id})`);
        lines.push(`  State: ${entity.state}`);
        if (attrs.temperature !== undefined) {
            lines.push(`  Temperature: ${attrs.temperature}°C`);
        }
        if (attrs.brightness !== undefined) {
            lines.push(`  Brightness: ${attrs.brightness}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

export function registerSmartHomeSkill(): void {
    // ── Tool 0: ha_setup ────────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_setup',
        description:
            'CRITICAL: You MUST call this tool IMMEDIATELY when the user provides a Home Assistant URL, access token (JWT starting with "eyJ..."), or says anything like "connect to Home Assistant", "set up smart home", "here\'s my HA token/key/URL". Do NOT tell the user to set environment variables or configure settings manually — this tool does it automatically. Also call with no args to check current connection status.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description:
                        'Home Assistant URL (e.g., "http://homeassistant.local:8123" or "http://192.168.1.50:8123")',
                },
                token: {
                    type: 'string',
                    description:
                        'Home Assistant long-lived access token (JWT starting with eyJ... or any string token the user provides)',
                },
                rawInput: {
                    type: 'string',
                    description:
                        'If the user pasted a URL or token in their message and you are unsure which field it belongs to, pass the full text here and the tool will auto-detect and extract the URL and token.',
                },
            },
            required: [],
        },
        execute: async (args) => {
            try {
                let url = args.url as string | undefined;
                let token = args.token as string | undefined;
                const rawInput = args.rawInput as string | undefined;

                // Auto-detect URL and token from raw input
                if (rawInput) {
                    // Extract URL: http(s)://...:<port> patterns
                    if (!url) {
                        const urlMatch = rawInput.match(/https?:\/\/[^\s,'"]+/i);
                        if (urlMatch) {
                            url = urlMatch[0].replace(/\/+$/, ''); // trim trailing slashes
                        }
                    }
                    // Extract JWT token: eyJ... pattern (base64url segments separated by dots)
                    if (!token) {
                        const jwtMatch = rawInput.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
                        if (jwtMatch) {
                            token = jwtMatch[0];
                        }
                    }
                    // Extract non-JWT long token (32+ alphanumeric chars that isn't a URL)
                    if (!token) {
                        const longTokenMatch = rawInput.match(/\b[A-Za-z0-9_-]{32,}\b/);
                        if (longTokenMatch && !longTokenMatch[0].match(/^https?/)) {
                            token = longTokenMatch[0];
                        }
                    }
                }

                logger.info('SmartHome', `ha_setup called with url=${url ? 'yes' : 'no'}, token=${token ? 'yes(' + token.length + ' chars)' : 'no'}, rawInput=${rawInput ? 'yes(' + rawInput.length + ' chars)' : 'no'}`);

                if (!url && !token) {
                    // Show current status
                    const currentUrl = getHAUrl();
                    const currentToken = getHAToken();
                    if (currentUrl && currentToken) {
                        // Test connection
                        try {
                            await haRequest('/api/');
                            return `✅ Home Assistant connected!\n  URL: ${currentUrl}\n  Token: ****${currentToken.slice(-8)}\n  Status: Connected`;
                        } catch (e) {
                            return `⚠️ Home Assistant configured but connection failed:\n  URL: ${currentUrl}\n  Token: ****${currentToken.slice(-8)}\n  Error: ${(e as Error).message}`;
                        }
                    }
                    return '❌ Home Assistant not configured.\n\nTo set up, provide:\n  1. Your HA URL (e.g., http://homeassistant.local:8123)\n  2. A long-lived access token (create in HA → Profile → Security → Long-Lived Access Tokens)';
                }

                // Save using updateConfig (atomic read-merge-validate-write)
                const haUpdate: Record<string, string> = {};
                if (url) haUpdate.url = url;
                if (token) haUpdate.token = token;
                updateConfig({ homeAssistant: haUpdate } as never);
                logger.info('SmartHome', `Home Assistant config saved: url=${url ? url : '(unchanged)'}, token=${token ? '****' + token.slice(-8) : '(unchanged)'}`);

                // Test the connection
                const testUrl = url || getHAUrl();
                const testToken = token || getHAToken();

                if (testUrl && testToken) {
                    try {
                        const response = await fetch(`${testUrl}/api/`, {
                            headers: { Authorization: `Bearer ${testToken}` },
                            signal: AbortSignal.timeout(10000),
                        });
                        if (response.ok) {
                            const data = (await response.json()) as { message?: string };
                            return `✅ Home Assistant connected successfully!\n  URL: ${testUrl}\n  API: ${data.message || 'OK'}\n\nYou can now use commands like "show me my devices", "turn on the lights", etc.`;
                        }
                        return `⚠️ Config saved but connection test returned HTTP ${response.status}. Check your URL and token.`;
                    } catch (e) {
                        return `⚠️ Config saved but connection test failed: ${(e as Error).message}\nThe URL/token are saved — you can fix them later.`;
                    }
                }

                return `Config saved. ${!testUrl ? 'Still need URL.' : ''} ${!testToken ? 'Still need token.' : ''}`.trim();
            } catch (e) {
                return `Error setting up Home Assistant: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 1: ha_devices ──────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_devices',
        description:
            'List all smart home devices and their current states. Use when asked "what smart home devices do you see?", "show me my lights", "list my switches", "what\'s connected to Home Assistant", or before controlling a device to find its entity ID. Optionally filter by type: light, switch, sensor, climate, media_player, etc.',
        parameters: {
            type: 'object',
            properties: {
                domain: {
                    type: 'string',
                    description:
                        'Device type to list (e.g., "light", "switch", "sensor", "climate") — omit for all devices',
                },
            },
            required: [],
        },
        execute: async (args) => {
            try {
                const domain = (args.domain as string) || '';
                const entities = (await haRequest('/api/states')) as HAEntity[];

                let filtered = entities;
                if (domain) {
                    filtered = entities.filter((e) => e.entity_id.startsWith(`${domain}.`));
                }

                return formatDeviceList(filtered);
            } catch (e) {
                return `Error listing Home Assistant devices: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 2: ha_control ──────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_control',
        description:
            'Control a smart home device — turn it on, off, toggle it, or set a value. Use when asked to "turn on the lights", "turn off the kitchen switch", "set brightness to 80%", "set thermostat to 72", "lock the front door", "toggle the fan", or any command to change a device\'s state.',
        parameters: {
            type: 'object',
            properties: {
                entityId: {
                    type: 'string',
                    description:
                        'The Home Assistant entity ID (e.g., "light.living_room", "switch.kitchen", "climate.thermostat")',
                },
                action: {
                    type: 'string',
                    enum: ['turn_on', 'turn_off', 'toggle', 'set'],
                    description: 'What to do: turn_on, turn_off, toggle, or set (for adjustments like brightness)',
                },
                data: {
                    type: 'object',
                    description:
                        'Optional parameters like brightness (0-255), temperature (kelvin), color_temp, hvac_mode, etc.',
                },
            },
            required: ['entityId', 'action'],
        },
        execute: async (args) => {
            try {
                const entityId = (args.entityId || args.entity_id || args.entity) as string;
                const action = args.action as string;
                const data = (args.data as Record<string, unknown>) || {};
                if (!entityId) return 'Error: entityId is required';

                // Extract domain from entity_id (e.g., "light" from "light.living_room")
                const [domain] = entityId.split('.');
                if (!domain) {
                    return `Error: Invalid entity ID format: ${entityId}`;
                }

                // Map actions to Home Assistant services
                let service = action;
                if (action === 'set') {
                    service = 'turn_on'; // Most set operations go through turn_on with data
                }

                const body = {
                    entity_id: entityId,
                    ...data,
                };

                await haRequest(`/api/services/${domain}/${service}`, 'POST', body);

                return `Successfully executed ${action} on ${entityId}`;
            } catch (e) {
                return `Error controlling Home Assistant device: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 3: ha_status ───────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_status',
        description:
            'Check the current state of a specific smart home device. Use when asked "what\'s the temperature inside?", "are the lights on?", "is the front door locked?", "what\'s the thermostat set to?", or any question about a device\'s current status.',
        parameters: {
            type: 'object',
            properties: {
                entityId: {
                    type: 'string',
                    description:
                        'The entity ID to check (e.g., "light.living_room", "sensor.temperature", "lock.front_door")',
                },
            },
            required: ['entityId'],
        },
        execute: async (args) => {
            try {
                // Accept both entityId and entity_id/sensor (models often use wrong param name)
                const entityId = (args.entityId || args.entity_id || args.sensor || args.entity) as string;
                if (!entityId) return 'Error: entityId is required (e.g., "sensor.temperature", "light.living_room")';
                const entity = (await haRequest(`/api/states/${entityId}`)) as HAStateResponse;
                return formatStateInfo(entity as HAEntity);
            } catch (e) {
                return `Error getting Home Assistant device status: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 4: ha_automations ──────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_automations',
        description:
            'List, trigger, enable, or disable Home Assistant automations. Use when asked "show me my automations", "run the night mode automation", "trigger morning routine", "disable the motion lights automation", or anything about managing automations.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'trigger', 'enable', 'disable'],
                    description: 'What to do: list all automations, trigger one, enable it, or disable it',
                },
                automationId: {
                    type: 'string',
                    description:
                        'The automation entity ID (e.g., "automation.night_mode") — required for trigger/enable/disable',
                },
            },
            required: ['action'],
        },
        execute: async (args) => {
            try {
                const action = args.action as string;
                const automationId = args.automationId as string | undefined;

                if (action === 'list') {
                    const entities = (await haRequest('/api/states')) as HAEntity[];
                    const automations = entities.filter((e) => e.entity_id.startsWith('automation.'));

                    if (automations.length === 0) return 'No automations found.';

                    const lines = [`Found ${automations.length} automation(s):\n`];
                    for (const a of automations) {
                        const name = (a.attributes.friendly_name as string) || a.entity_id;
                        const lastTriggered = (a.attributes.last_triggered as string) || 'never';
                        lines.push(`• ${name} (${a.entity_id})`);
                        lines.push(`  State: ${a.state} | Last triggered: ${lastTriggered}`);
                        lines.push('');
                    }
                    return lines.join('\n');
                }

                if (!automationId) {
                    return 'Error: automationId is required for trigger/enable/disable actions.';
                }

                if (action === 'trigger') {
                    await haRequest('/api/services/automation/trigger', 'POST', {
                        entity_id: automationId,
                    });
                    return `Triggered automation: ${automationId}`;
                }

                if (action === 'enable') {
                    await haRequest('/api/services/automation/turn_on', 'POST', {
                        entity_id: automationId,
                    });
                    return `Enabled automation: ${automationId}`;
                }

                if (action === 'disable') {
                    await haRequest('/api/services/automation/turn_off', 'POST', {
                        entity_id: automationId,
                    });
                    return `Disabled automation: ${automationId}`;
                }

                return `Unknown action: ${action}`;
            } catch (e) {
                return `Error managing automations: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 5: ha_scenes ───────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_scenes',
        description:
            'List or activate Home Assistant scenes. Use when asked "show me my scenes", "activate movie night", "turn on the party scene", "set the mood", or anything about activating predefined device states.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'activate'],
                    description: 'What to do: list all scenes, or activate one',
                },
                sceneId: {
                    type: 'string',
                    description: 'The scene entity ID (e.g., "scene.movie_night") — required for activate',
                },
            },
            required: ['action'],
        },
        execute: async (args) => {
            try {
                const action = args.action as string;
                const sceneId = args.sceneId as string | undefined;

                if (action === 'list') {
                    const entities = (await haRequest('/api/states')) as HAEntity[];
                    const scenes = entities.filter((e) => e.entity_id.startsWith('scene.'));

                    if (scenes.length === 0) return 'No scenes found.';

                    const lines = [`Found ${scenes.length} scene(s):\n`];
                    for (const s of scenes) {
                        const name = (s.attributes.friendly_name as string) || s.entity_id;
                        lines.push(`• ${name} (${s.entity_id})`);
                    }
                    return lines.join('\n');
                }

                if (action === 'activate') {
                    if (!sceneId) return 'Error: sceneId is required to activate a scene.';

                    await haRequest('/api/services/scene/turn_on', 'POST', {
                        entity_id: sceneId,
                    });
                    return `Activated scene: ${sceneId}`;
                }

                return `Unknown action: ${action}`;
            } catch (e) {
                return `Error managing scenes: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 6: ha_history ──────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_history',
        description:
            'Get the state history of a smart home device over the last N hours. Use when asked "what was the temperature overnight?", "when did the motion sensor last trigger?", "show me the light history", or any question about past device states.',
        parameters: {
            type: 'object',
            properties: {
                entityId: {
                    type: 'string',
                    description: 'The entity ID to check history for (e.g., "sensor.temperature", "light.living_room")',
                },
                hours: {
                    type: 'number',
                    description: 'How many hours of history to retrieve (default: 24, max: 168)',
                },
            },
            required: ['entityId'],
        },
        execute: async (args) => {
            try {
                const entityId = (args.entityId || args.entity_id || args.sensor || args.entity) as string;
                if (!entityId) return 'Error: entityId is required';
                const hours = Math.min(Math.max((args.hours as number) || 24, 1), 168);

                const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
                const endTime = new Date().toISOString();

                const history = (await haRequest(
                    `/api/history/period/${startTime}?filter_entity_id=${entityId}&end_time=${endTime}&minimal_response`
                )) as HAEntity[][];

                if (!history || history.length === 0 || history[0].length === 0) {
                    return `No history found for ${entityId} in the last ${hours} hours.`;
                }

                const states = history[0];
                const lines = [`History for ${entityId} (last ${hours}h):\n`];

                // Show up to 50 state changes
                const displayStates = states.slice(-50);
                for (const s of displayStates) {
                    const time = new Date(s.last_changed).toLocaleString();
                    lines.push(`  ${time} → ${s.state}`);
                }

                if (states.length > 50) {
                    lines.push(`\n  ... and ${states.length - 50} more entries`);
                }

                return lines.join('\n');
            } catch (e) {
                return `Error getting history: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 7: ha_areas ────────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_areas',
        description:
            'List all rooms/areas in Home Assistant and their assigned devices. Use when asked "what rooms do you see?", "show me devices by room", "what\'s in the living room?", or to understand the home layout.',
        parameters: {
            type: 'object',
            properties: {
                areaId: {
                    type: 'string',
                    description: 'Optional: specific area ID to list devices for (omit to list all areas)',
                },
            },
            required: [],
        },
        execute: async (args) => {
            try {
                const areaId = args.areaId as string | undefined;

                if (areaId) {
                    // Get entities for a specific area using template API
                    const result = (await haRequest('/api/template', 'POST', {
                        template: `{% set entities = area_entities('${areaId}') %}{% for e in entities %}{{ e }}\n{% endfor %}`,
                    })) as string;

                    const entityIds = result
                        .trim()
                        .split('\n')
                        .filter((e: string) => e.trim());
                    if (entityIds.length === 0) return `No devices found in area: ${areaId}`;

                    // Get states for these entities
                    const allEntities = (await haRequest('/api/states')) as HAEntity[];
                    const areaEntities = allEntities.filter((e) => entityIds.includes(e.entity_id));

                    return formatDeviceList(areaEntities);
                }

                // List all areas
                const result = (await haRequest('/api/template', 'POST', {
                    template:
                        '{% for area in areas() %}{{ area }}|{{ area_name(area) }}\n{% endfor %}',
                })) as string;

                const areas = result
                    .trim()
                    .split('\n')
                    .filter((a: string) => a.trim());
                if (areas.length === 0) return 'No areas configured in Home Assistant.';

                const lines = [`Found ${areas.length} area(s):\n`];
                for (const area of areas) {
                    const [id, name] = area.split('|');
                    lines.push(`• ${name || id} (${id})`);
                }

                return lines.join('\n');
            } catch (e) {
                return `Error listing areas: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 8: ha_call_service ──────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_call_service',
        description:
            'Call any Home Assistant service directly. Generic escape hatch for services not covered by other tools — media players (play/pause/volume), scripts, input helpers, covers (open/close), fans (speed), vacuums (start/dock), etc. Use when the specific action isn\'t available in ha_control.',
        parameters: {
            type: 'object',
            properties: {
                domain: {
                    type: 'string',
                    description:
                        'Service domain (e.g., "media_player", "script", "input_boolean", "cover", "fan", "vacuum")',
                },
                service: {
                    type: 'string',
                    description:
                        'Service name (e.g., "play_media", "volume_set", "open_cover", "start", "turn_on")',
                },
                data: {
                    type: 'object',
                    description:
                        'Service data payload — must include entity_id and any service-specific parameters',
                },
            },
            required: ['domain', 'service'],
        },
        execute: async (args) => {
            try {
                const domain = args.domain as string;
                const service = args.service as string;
                const data = (args.data as Record<string, unknown>) || {};

                await haRequest(`/api/services/${domain}/${service}`, 'POST', data);

                return `Successfully called ${domain}.${service}${data.entity_id ? ` on ${data.entity_id}` : ''}`;
            } catch (e) {
                return `Error calling service: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 9: ha_dashboard ────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_dashboard',
        description:
            'Get a full overview of all smart home devices grouped by type. Use when asked "what\'s going on at home?", "give me a home summary", "home dashboard", or for a quick glance at all device states.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
        execute: async () => {
            try {
                const entities = (await haRequest('/api/states')) as HAEntity[];

                // Group by domain
                const groups: Record<string, HAEntity[]> = {};
                for (const e of entities) {
                    const [domain] = e.entity_id.split('.');
                    if (!groups[domain]) groups[domain] = [];
                    groups[domain].push(e);
                }

                const lines: string[] = ['🏠 Home Dashboard\n'];

                // Priority domains first
                const priorityDomains = [
                    'light',
                    'switch',
                    'climate',
                    'lock',
                    'cover',
                    'media_player',
                    'sensor',
                    'binary_sensor',
                    'fan',
                    'vacuum',
                ];

                for (const domain of priorityDomains) {
                    const domainEntities = groups[domain];
                    if (!domainEntities || domainEntities.length === 0) continue;

                    const label = domain.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
                    lines.push(`── ${label} (${domainEntities.length}) ──`);

                    // For lights/switches: show on/off counts
                    if (['light', 'switch', 'fan'].includes(domain)) {
                        const on = domainEntities.filter((e) => e.state === 'on').length;
                        const off = domainEntities.filter((e) => e.state === 'off').length;
                        lines.push(`  ${on} on, ${off} off`);
                    }

                    // Show each entity (max 15 per domain to keep output manageable)
                    const display = domainEntities.slice(0, 15);
                    for (const e of display) {
                        const name = (e.attributes.friendly_name as string) || e.entity_id;
                        const extras: string[] = [];

                        if (e.attributes.temperature !== undefined) extras.push(`${e.attributes.temperature}°`);
                        if (e.attributes.current_temperature !== undefined)
                            extras.push(`current: ${e.attributes.current_temperature}°`);
                        if (e.attributes.brightness !== undefined)
                            extras.push(`brightness: ${Math.round((e.attributes.brightness as number) / 255 * 100)}%`);
                        if (e.attributes.unit_of_measurement)
                            extras.push(`${e.state} ${e.attributes.unit_of_measurement}`);

                        const extra = extras.length > 0 ? ` (${extras.join(', ')})` : '';
                        lines.push(`  • ${name}: ${e.state}${extra}`);
                    }

                    if (domainEntities.length > 15) {
                        lines.push(`  ... and ${domainEntities.length - 15} more`);
                    }
                    lines.push('');
                }

                // Count remaining domains
                const shownDomains = new Set(priorityDomains);
                const otherDomains = Object.keys(groups).filter((d) => !shownDomains.has(d));
                if (otherDomains.length > 0) {
                    const otherCount = otherDomains.reduce((sum, d) => sum + groups[d].length, 0);
                    lines.push(
                        `── Other (${otherCount} entities across ${otherDomains.length} domains) ──`
                    );
                    lines.push(`  Domains: ${otherDomains.join(', ')}`);
                }

                lines.push(`\nTotal: ${entities.length} entities`);

                return lines.join('\n');
            } catch (e) {
                return `Error getting dashboard: ${(e as Error).message}`;
            }
        },
    });

    // ── Tool 10: ha_notify ──────────────────────────────────────────────
    registerSkill(SKILL_META, {
        name: 'ha_notify',
        description:
            'Send a notification via Home Assistant. Use when asked to "send me a notification", "alert my phone", "notify about X", or to push messages to mobile devices or other notification targets.',
        parameters: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    description:
                        'Notification service target (e.g., "mobile_app_tonys_phone", "notify" for default). Omit "notify." prefix — just the target name.',
                },
                title: {
                    type: 'string',
                    description: 'Notification title',
                },
                message: {
                    type: 'string',
                    description: 'Notification body text',
                },
                data: {
                    type: 'object',
                    description:
                        'Optional extra data (e.g., image URL, actions, priority, channel)',
                },
            },
            required: ['message'],
        },
        execute: async (args) => {
            try {
                const target = (args.target as string) || 'notify';
                const title = (args.title as string) || 'TITAN';
                const message = args.message as string;
                const data = (args.data as Record<string, unknown>) || {};

                await haRequest(`/api/services/notify/${target}`, 'POST', {
                    title,
                    message,
                    ...data,
                });

                return `Notification sent via ${target}: "${title}" — ${message}`;
            } catch (e) {
                return `Error sending notification: ${(e as Error).message}`;
            }
        },
    });
}
