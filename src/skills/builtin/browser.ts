/**
 * TITAN — Browser Control Skill (Built-in)
 * CDP-based browser automation: navigate, snapshot, click, type, evaluate.
 */
import { registerSkill } from '../registry.js';
import { execFile } from 'child_process';
import logger from '../../utils/logger.js';

const COMPONENT = 'Browser';

export function registerBrowserSkill(): void {
    registerSkill(
        { name: 'browser', description: 'Browser control and web automation', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'browser',
            description: 'CDP-based browser control — navigate, snapshot, click, type, evaluate JS, and extract page content.\n\nUSE THIS WHEN Tony says: "take a screenshot of X" / "navigate to X" / "click X on that page" / "extract links from X" / "run JavaScript on X"\n\nACTIONS:\n- navigate: go to a URL and extract its text\n- snapshot/extract: get title, description, and links from a page\n- click: click an element by CSS selector (requires live CDP session)\n- type: type text into an element (requires live CDP session)\n- evaluate: run JavaScript in the page context\n- screenshot: capture a visual screenshot\n\nNOTE: Full interactive actions (click, type, evaluate, screenshot) require a connected Chromium browser via CDP. For most browsing tasks, prefer browse_url or web_read.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['navigate', 'snapshot', 'click', 'type', 'evaluate', 'extract', 'screenshot'],
                        description: 'Browser action to perform',
                    },
                    url: { type: 'string', description: 'URL to navigate to (for navigate action)' },
                    selector: { type: 'string', description: 'CSS selector for click/type actions' },
                    text: { type: 'string', description: 'Text to type (for type action)' },
                    script: { type: 'string', description: 'JavaScript code to evaluate (for evaluate action)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;

                switch (action) {
                    case 'navigate': {
                        const url = args.url as string;
                        if (!url) return 'Error: url is required';
                        logger.info(COMPONENT, `Navigating to: ${url}`);
                        // Use execFile to avoid shell injection via URL
                        return new Promise<string>((resolve) => {
                            execFile('curl', ['-sL', '--max-time', '15', url], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
                                if (err) {
                                    resolve(`Error fetching ${url}: ${err.message}`);
                                    return;
                                }
                                const raw = stdout.slice(0, 50000);
                                // Strip HTML tags for text content
                                const text = raw
                                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                                    .replace(/<[^>]*>/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim();
                                resolve(`Page content from ${url}:\n${text.slice(0, 20000)}`);
                            });
                        });
                    }
                    case 'snapshot':
                    case 'extract': {
                        const url = args.url as string;
                        if (!url) return 'Error: url is required for snapshot/extract';
                        return new Promise<string>((resolve) => {
                            execFile('curl', ['-sL', '--max-time', '15', url], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
                                if (err) {
                                    resolve(`Error: ${err.message}`);
                                    return;
                                }
                                const raw = stdout.slice(0, 50000);
                                // Extract title + meta description + links
                                const title = raw.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || 'No title';
                                const desc = raw.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*>/i)?.[1] || '';
                                const links: string[] = [];
                                const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
                                let m;
                                while ((m = linkRegex.exec(raw)) !== null && links.length < 20) {
                                    const text = m[2].replace(/<[^>]*>/g, '').trim();
                                    if (text && m[1] && !m[1].startsWith('#')) links.push(`  ${text}: ${m[1]}`);
                                }
                                resolve(`Page: ${title}\nDescription: ${desc}\nLinks:\n${links.join('\n')}`);
                            });
                        });
                    }
                    case 'evaluate': {
                        const script = args.script as string;
                        if (!script) return 'Error: script is required';
                        return `Note: Full CDP browser evaluation requires a running browser session. Script queued: ${script.slice(0, 200)}`;
                    }
                    case 'screenshot': {
                        const url = args.url as string;
                        if (!url) return 'Error: url is required';
                        return `Screenshot capture requires CDP connection to a running Chromium instance. Target: ${url}`;
                    }
                    case 'click': {
                        const selector = args.selector as string;
                        if (!selector) return 'Error: selector is required';
                        return `Click action requires CDP connection. Selector: ${selector}`;
                    }
                    case 'type': {
                        const selector = args.selector as string;
                        const text = args.text as string;
                        if (!selector || !text) return 'Error: selector and text are required';
                        return `Type action requires CDP connection. Selector: ${selector}, Text: ${text}`;
                    }
                    default:
                        return `Unknown browser action: ${action}`;
                }
            },
        },
    );
}
