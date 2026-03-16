/**
 * TITAN — Skyvern Browser Automation Skills (Built-in)
 * Native REST API tools for Skyvern: task execution, data extraction, and session management.
 * Uses fetch against Skyvern's API — no @skyvern/client SDK needed.
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Skyvern';

function getConfig() {
    return {
        apiKey: process.env.SKYVERN_API_KEY || 'local',
        baseUrl: (process.env.SKYVERN_BASE_URL || 'http://localhost:8000').replace(/\/$/, ''),
    };
}

function headers(): Record<string, string> {
    const { apiKey } = getConfig();
    return {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
    };
}

async function skyvernFetch(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
    const { baseUrl } = getConfig();
    const url = `${baseUrl}${path}`;
    const response = await fetch(url, { ...options, headers: { ...headers(), ...options.headers as Record<string, string> } });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Skyvern API error (${response.status}): ${text}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
}

async function pollTask(taskId: string, maxWaitMs: number = 120_000): Promise<Record<string, unknown>> {
    const startTime = Date.now();
    const pollInterval = 3000;
    while (Date.now() - startTime < maxWaitMs) {
        const result = await skyvernFetch(`/api/v1/tasks/${taskId}`);
        const status = result.status as string;
        if (status === 'completed' || status === 'failed' || status === 'terminated') {
            return result;
        }
        await new Promise(r => setTimeout(r, pollInterval));
    }
    return { status: 'timeout', task_id: taskId, error: `Task did not complete within ${maxWaitMs / 1000}s` };
}

export function registerSkyvernSkill(): void {
    // Tool 1: skyvern_task — Run browser automation with natural language
    registerSkill(
        { name: 'skyvern_task', description: 'Use this when asked to "automate this website", "fill out this form for me", "click X on that site", "do this thing on the web", or any task that requires interacting with a browser. Skyvern uses vision + AI to control web pages without selectors.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'skyvern_task',
            description: 'Automate any browser task using natural language. Use this when asked to "automate this website", "fill out this form for me", "click X on that site", "log in and do Y", "submit this application", or any task that involves navigating and interacting with a web page. Skyvern uses computer vision + LLMs so it works on any site without fragile selectors.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Natural language description of what to do on the website' },
                    url: { type: 'string', description: 'Starting URL (optional — Skyvern can navigate on its own)' },
                    extraction_schema: { type: 'object', description: 'JSON Schema for structured data to extract from the page (optional)' },
                },
                required: ['prompt'],
            },
            execute: async (args) => {
                try {
                    const body: Record<string, unknown> = {
                        navigation_goal: args.prompt as string,
                    };
                    if (args.url) body.url = args.url;
                    if (args.extraction_schema) body.data_extraction_goal = args.prompt;
                    if (args.extraction_schema) body.extracted_information_schema = args.extraction_schema;

                    const task = await skyvernFetch('/api/v1/tasks', {
                        method: 'POST',
                        body: JSON.stringify(body),
                    });

                    const taskId = task.task_id as string;
                    logger.info(COMPONENT, `Task created: ${taskId}`);

                    const result = await pollTask(taskId);
                    return JSON.stringify({
                        task_id: taskId,
                        status: result.status,
                        extracted_data: result.extracted_information ?? null,
                        screenshot_url: result.screenshot_url ?? null,
                        failure_reason: result.failure_reason ?? null,
                    }, null, 2);
                } catch (e) {
                    return `Error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 2: skyvern_extract — Extract structured data from a webpage
    registerSkill(
        { name: 'skyvern_extract', description: 'Use this when asked to "scrape this page", "pull data from this site", "extract the prices from X", "get the table on this page", or any task that needs structured data pulled from a website.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'skyvern_extract',
            description: 'Scrape and extract structured data from any webpage using natural language. Use this when asked to "scrape this page", "pull data from this site", "extract the prices from X", "get the table on this URL", or "collect the listings from this page". Returns the data in a structured format.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL of the page to extract data from' },
                    prompt: { type: 'string', description: 'What data to extract, in natural language (e.g., "all product names and prices")' },
                    schema: { type: 'object', description: 'Optional JSON Schema defining the structure you want the extracted data in' },
                },
                required: ['url', 'prompt'],
            },
            execute: async (args) => {
                try {
                    const body: Record<string, unknown> = {
                        url: args.url as string,
                        data_extraction_goal: args.prompt as string,
                    };
                    if (args.schema) body.extracted_information_schema = args.schema;

                    const task = await skyvernFetch('/api/v1/tasks', {
                        method: 'POST',
                        body: JSON.stringify(body),
                    });

                    const taskId = task.task_id as string;
                    logger.info(COMPONENT, `Extract task created: ${taskId}`);

                    const result = await pollTask(taskId);
                    return JSON.stringify({
                        task_id: taskId,
                        status: result.status,
                        extracted_data: result.extracted_information ?? null,
                        failure_reason: result.failure_reason ?? null,
                    }, null, 2);
                } catch (e) {
                    return `Error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Tool 3: skyvern_sessions — Manage persistent browser sessions
    registerSkill(
        { name: 'skyvern_sessions', description: 'Use this to manage persistent browser sessions for multi-step web automation — "start a browser session", "keep the browser open", "end the session". Useful when automating multi-page workflows that need to stay logged in.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'skyvern_sessions',
            description: 'Manage persistent browser sessions for multi-step web automation. Use this when a web task needs to stay logged in across multiple steps, or when asked to "start a browser session", "keep the browser open", "reuse the same session", or "end the browser session". Sessions persist cookies and state across tasks.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['create', 'list', 'close'], description: 'What to do: create a new session, list existing sessions, or close one' },
                    session_id: { type: 'string', description: 'Session ID — required when action is "close"' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                try {
                    const action = args.action as string;
                    if (action === 'create') {
                        const session = await skyvernFetch('/v1/browser_sessions', {
                            method: 'POST',
                            body: JSON.stringify({}),
                        });
                        return JSON.stringify({ session_id: session.browser_session_id, status: 'created' }, null, 2);
                    } else if (action === 'list') {
                        const sessions = await skyvernFetch('/v1/browser_sessions/history/');
                        return JSON.stringify(sessions, null, 2);
                    } else if (action === 'close') {
                        if (!args.session_id) return 'Error: session_id is required for close action';
                        await skyvernFetch(`/v1/browser_sessions/${args.session_id}/close`, { method: 'POST' });
                        return JSON.stringify({ session_id: args.session_id, status: 'closed' }, null, 2);
                    }
                    return `Error: Unknown action "${action}". Use create, list, or close.`;
                } catch (e) {
                    return `Error: ${(e as Error).message}`;
                }
            },
        },
    );

    logger.info(COMPONENT, 'Registered 3 native Skyvern tools');
}
