/**
 * TITAN — Universal Web Browser
 * Set-and-forget web browsing for TITAN. No configuration needed.
 *
 * HOW IT WORKS:
 * ─────────────────────────────────────────────────────────────────
 * 1. Fast path: tries a plain fetch() first — instant, zero cost
 * 2. If the page needs JavaScript (React/Vue/SPAs), falls back to
 *    Playwright with a persistent local Chromium browser session
 * 3. Extracts clean readable text (not raw HTML) so the LLM gets
 *    signal, not noise
 * 4. Can screenshot pages for visual tasks
 * 5. Session cookies persist between calls — stay logged in
 *
 * WHY PLAYWRIGHT + PERSISTANCE:
 * ─────────────────────────────────────────────────────────────────
 * Unlike single-use headless browsers, TITAN keeps one browser
 * session alive for the lifetime of the gateway. This means:
 * - No cold-start cost on every request (~500ms saved per call)
 * - You can log into sites once and TITAN stays logged in
 * - Cookies and localStorage persist across page visits
 * - "Set and forget" — just works, no Docker, no config
 *
 * AUTO-INSTALL: Playwright chromium is auto-installed on first use.
 */
import { registerSkill } from '../registry.js';
import { z } from 'zod';
import logger from '../../utils/logger.js';
import { TITAN_VERSION } from '../../utils/constants.js';
import { getPage, releasePage, closeBrowser as closePoolBrowser } from '../../browsing/browserPool.js';

const COMPONENT = 'WebBrowser';

// ─── Types ────────────────────────────────────────────────────────
interface BrowseResult {
    url: string;
    title: string;
    content: string;
    screenshot?: string; // base64
    loadedWithJs: boolean;
    extractedLinks?: string[];
}

interface DomElement { tag: string; id: string; name: string; cls: string; text: string; type?: string }

/** Extract clean readable text from HTML */
function extractText(html: string, maxChars = 8000): string {
    // Remove scripts, styles, nav, footer
    const clean = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{3,}/g, '\n\n')
        .trim();
    return clean.slice(0, maxChars);
}

/** Try a plain fetch — fast path for simple pages */
async function fetchSimple(url: string): Promise<BrowseResult | null> {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': `Mozilla/5.0 TITAN-Agent/${TITAN_VERSION}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const html = await res.text();

        // Heuristic: if page has very little text but lots of JS, it needs a real browser
        const textContent = extractText(html, 200);
        const hasContent = textContent.trim().length > 100;
        if (!hasContent) return null; // Needs JS rendering

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        return {
            url,
            title: titleMatch?.[1]?.trim() ?? url,
            content: extractText(html, 8000),
            loadedWithJs: false,
        };
    } catch { return null; }
}

/** Full browser render with Playwright (uses shared browser pool) */
async function fetchWithBrowser(url: string, screenshot: boolean): Promise<BrowseResult> {
    const page = await getPage();
    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

        const title = await page.title();
        const bodyText = await page.evaluate(() => {
            // Note: this runs in browser context — globalThis is the browser window
            const win = globalThis as unknown as Record<string, unknown>;
            const doc = win.document as unknown as { querySelector: (s: string) => { textContent?: string } | null; body?: { innerText?: string } };
            const selectors = ['article', 'main', '[role="main"]', '.content', '#content', 'body'];
            for (const sel of selectors) {
                const el = doc.querySelector(sel);
                if (el && el.textContent && el.textContent.trim().length > 200) {
                    return el.textContent.trim().replace(/\s{3,}/g, '\n\n').slice(0, 8000);
                }
            }
            return doc.body?.innerText?.slice(0, 8000) ?? '';
        }) as string;

        // Optionally grab visible links
        const links = await page.evaluate(() => {
            const win = globalThis as unknown as Record<string, unknown>;
            const doc = win.document as unknown as { querySelectorAll: (s: string) => ArrayLike<{ href: string }> };
            return Array.from(doc.querySelectorAll('a[href]'))
                .map((el: { href: string }) => el.href)
                .filter((href: string) => href.startsWith('http'))
                .slice(0, 20);
        }) as string[];

        let screenshotData: string | undefined;
        if (screenshot) {
            const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
            screenshotData = buf.toString('base64');
        }

        return { url, title, content: bodyText, loadedWithJs: true, extractedLinks: links, screenshot: screenshotData };
    } finally {
        await releasePage(page);
    }
}

// ─── Schema ───────────────────────────────────────────────────────
const BrowseSchema = z.object({
    url: z.string().url().describe('The URL to browse'),
    screenshot: z.boolean().optional().default(false).describe('Whether to take a screenshot'),
    extractLinks: z.boolean().optional().default(false).describe('Whether to extract all links from the page'),
});

const SearchSchema = z.object({
    query: z.string().describe('The search query'),
    numResults: z.number().optional().default(5).describe('Number of results to return (1-10)'),
});

// ─── Register tools ────────────────────────────────────────────────
export function initWebBrowserTool(): void {
    // Browse any URL
    registerSkill({
        name: 'browse_url',
        description: 'Browse any webpage and extract its content as clean text. Uses a real browser with JavaScript support for dynamic sites.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'browse_url',
        description: 'Browse any URL using a real Playwright browser and return clean extracted text.\n\nUSE THIS WHEN:\n- Tony gives a URL that needs JavaScript to render (SPAs, React/Vue apps, dashboards)\n- web_fetch or web_read returned empty or minimal content\n- Tony says "open X in browser" / "check X" / "load X" / "browse to X"\n\nVS OTHER TOOLS:\n- Use web_fetch for simple static pages (faster, no browser overhead)\n- Use web_read for clean article/doc extraction\n- Use browser_auto_nav for multi-step form or click workflows\n\nAuto-detects JS-heavy pages and uses Playwright; falls back to fast fetch for simple pages.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The full URL to browse (must start with https://)' },
                screenshot: { type: 'boolean', description: 'Take a visual screenshot of the page (optional)', default: false },
                extractLinks: { type: 'boolean', description: 'Also return links found on the page', default: false },
            },
            required: ['url'],
        },
        execute: async (args) => {
            const { url, screenshot, extractLinks } = BrowseSchema.parse(args);
            logger.info(COMPONENT, `Browsing: ${url}`);

            // Try fast path first
            let result = await fetchSimple(url);

            // Fall back to real browser if needed
            if (!result) {
                logger.info(COMPONENT, `Switching to Playwright for JS-heavy page: ${url}`);
                result = await fetchWithBrowser(url, screenshot ?? false);
            }

            const lines = [
                `🌐 **${result.title}**`,
                `URL: ${result.url}`,
                `Loaded with: ${result.loadedWithJs ? 'Browser (JavaScript enabled)' : 'Direct fetch (fast)'}`,
                '',
                result.content,
            ];

            if (extractLinks && result.extractedLinks && result.extractedLinks.length > 0) {
                lines.push('', '🔗 **Links found:**');
                result.extractedLinks.slice(0, 10).forEach((l) => lines.push(`  - ${l}`));
            }

            if (result.screenshot) {
                lines.push('', `📷 Screenshot captured (${result.screenshot.length} bytes)`);
            }

            return lines.join('\n');
        },
    });

    // Web search using DuckDuckGo (no API key needed)
    registerSkill({
        name: 'browser_search',
        description: 'Search the internet for current information using a real browser. Returns real search results with titles, URLs, and snippets.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'browser_search',
        description: 'Search the internet using a real Playwright browser — bypasses bot detection that blocks plain HTTP fetches.\n\nUSE THIS WHEN:\n- web_search fails or returns no results\n- Tony says "search for X" and the query needs JS rendering\n- Searching for current events, prices, or real-time info\n\nWORKFLOW: Call browser_search → review results → call browse_url on the best result for full content\nNo API key needed.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to search for on the internet' },
                numResults: { type: 'number', description: 'Number of results to return (1-10)', default: 5 },
            },
            required: ['query'],
        },
        execute: async (args) => {
            const { query } = SearchSchema.parse(args);
            logger.info(COMPONENT, `Searching: ${query}`);

            // Use DuckDuckGo Lite — no API key, no rate limit for reasonable use
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const res = await fetchWithBrowser(searchUrl, false);

            // The results page content already has the search results as text
            const lines = [
                `🔍 **Search results for: "${query}"**`,
                '',
                res.content.slice(0, 4000),
            ];

            return lines.join('\n');
        },
    });

    // Ultra-Fast Bulk Web Navigation
    registerSkill({
        name: 'browser_auto_nav',
        description: 'Navigate a website blazingly fast by executing a bulk sequence of actions in a single tool call.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'browser_auto_nav',
        description: 'Execute a bulk sequence of browser actions (click, fill, wait, evaluate) in one call — machine-speed navigation.\n\nUSE THIS WHEN Tony says: "log in to X" / "click X then fill Y" / "submit that form" / "go through the steps on X" / "automate X website"\n\nWORKFLOW: Provide the URL + an array of step actions → get back the final page state (smart DOM map, text, or screenshot)\n\nBEST FOR: logins, multi-step forms, pagination, any sequence of clicks and inputs\nFor single-call form filling, smart_form_fill is even simpler.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Starting URL (if you are already on the page, just provide the current URL)' },
                actions: {
                    type: 'array',
                    description: 'Sequential array of actions to perform at near-instant machine speed.',
                    items: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', enum: ['click', 'fill', 'wait', 'evaluate'], description: 'Action to perform' },
                            selector: { type: 'string', description: 'CSS selector (e.g. #login-btn, input[name="user"])' },
                            value: { type: 'string', description: 'Text to fill if action is "fill"' },
                            delayMs: { type: 'number', description: 'Milliseconds to wait if action is "wait"' },
                            script: { type: 'string', description: 'JavaScript to run if action is "evaluate"' }
                        },
                        required: ['action']
                    }
                },
                returnType: { type: 'string', enum: ['text', 'smart_dom', 'screenshot'], description: 'What to return after the actions finish: raw text, a mapping of interactive elements, or a base64 screenshot. Default: smart_dom', default: 'smart_dom' }
            },
            required: ['url', 'actions'],
        },
        execute: async (args: Record<string, unknown>) => {
            const { url, actions, returnType = 'smart_dom' } = args as { url: string; actions: Record<string, unknown>[]; returnType?: string };
            const page = await getPage();

            try {
                // Check if we are already on this URL (saves navigation time)
                if (page.url() !== url && url !== 'current') {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                }

                const results: string[] = [];
                for (const step of actions) {
                    try {
                        if (step.action === 'click' && step.selector) {
                            await page.locator(step.selector as string).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
                            await page.click(step.selector as string);
                            results.push(`✅ Clicked: ${step.selector}`);
                        } else if (step.action === 'fill' && step.selector && step.value !== undefined) {
                            await page.locator(step.selector as string).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
                            await page.fill(step.selector as string, step.value as string);
                            results.push(`✅ Filled: ${step.selector} -> *****`);
                        } else if (step.action === 'wait' && step.delayMs) {
                            await page.waitForTimeout(step.delayMs as number);
                            results.push(`✅ Waited: ${step.delayMs}ms`);
                        } else if (step.action === 'evaluate' && step.script) {
                            await page.evaluate(step.script as string & (() => unknown));
                            results.push(`✅ Evaluated custom script`);
                        }
                    } catch (e: unknown) {
                        results.push(`❌ Failed Step: ${step.action} on ${step.selector} - ${(e as Error).message.split('\\n')[0]}`);
                        break; // Stop execution on first failure to prevent chaos
                    }
                }

                // Wait a moment for dynamic page updates after the last action
                await page.waitForTimeout(1000);

                const title = await page.title();
                const finalUrl = page.url();

                let output = `Workflow Results:\n${results.join('\\n')}\n\nFinal URL: ${finalUrl} (Title: ${title})\n\n`;

                if (returnType === 'smart_dom') {
                    const domMap = await page.evaluate(() => {
                        const win = globalThis as unknown as Record<string, unknown>;
                        const doc = win.document as unknown as { querySelectorAll: (s: string) => ArrayLike<Record<string, unknown>> };
                        const elements: { tag: string; id: string; name: string; cls: string; text: string; type?: string }[] = [];
                        const interactive = doc.querySelectorAll('button, a[href], input, select, textarea');
                        Array.from(interactive).forEach((el: Record<string, unknown>) => {
                            const bounds = (el.getBoundingClientRect as () => { width: number; height: number })();
                            if (bounds.width === 0 || bounds.height === 0) return; // Skip invisible elements

                            elements.push({
                                tag: ((el.tagName as string) || '').toLowerCase(),
                                id: (el.id as string) || '',
                                name: (el.name as string) || '',
                                cls: String(el.className || ''),
                                text: (el.innerText as string)?.slice(0, 50) || (el.value as string)?.slice(0, 50) || '',
                                type: (el.type as string) || ''
                            });
                        });
                        return elements;
                    }) as DomElement[];

                    let domString = "--- Smart DOM Map (Interactive Elements) ---\n";
                    domMap.slice(0, 100).forEach((e: DomElement) => {
                        let sel = e.tag;
                        if (e.id) sel += `#${e.id}`;
                        else if (e.name) sel += `[name="${e.name}"]`;
                        else if (e.cls) sel += `.${e.cls.split(' ')[0]}`;

                        domString += `[${sel}] `;
                        if (e.tag === 'input' || e.tag === 'textarea') domString += `type="${e.type}" `;
                        if (e.text) domString += `-> "${e.text.trim()}"`;
                        domString += '\n';
                    });
                    output += domString;
                } else if (returnType === 'text') {
                    output += "--- Page Text ---\n";
                    const bodyText = await page.evaluate(() => {
                        const win = globalThis as unknown as Record<string, unknown>;
                        const doc = win.document as unknown as { body?: { innerText?: string } };
                        return doc.body?.innerText?.slice(0, 8000) ?? '';
                    }) as string;
                    output += bodyText;
                } else if (returnType === 'screenshot') {
                    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
                    output += `--- Screenshot attached: ${buf.length} bytes ---\n`;
                    // In a real multi-modal environment we'd attach the buffer, returning string for now.
                }

                return output;
            } finally {
                await releasePage(page);
            }
        },
    });

    // Standalone screenshot — capture current page (or a fresh URL) without running an action sequence.
    registerSkill({
        name: 'browser_screenshot',
        description: 'Capture a screenshot of a web page using the shared Playwright browser. Returns a base64 JPEG.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'browser_screenshot',
        description: 'Take a screenshot of a web page. If `url` is omitted, screenshots the page already loaded in the shared browser.\n\nUSE THIS WHEN Tony says: "screenshot X" / "take a picture of X" / "verify X visually" / sub-agents that need to confirm the visual state of a page they just acted on.\n\nReturns base64-encoded JPEG (quality 70). For full-page screenshots set `fullPage: true`.\n\nVS OTHER TOOLS:\n- Use the desktop `screenshot` tool when you want the whole macOS screen (computer-use)\n- Use this when you only need the browser viewport / page',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Optional URL to navigate to before screenshotting. Omit to capture the current page.' },
                fullPage: { type: 'boolean', description: 'Capture the entire scrollable page rather than just the viewport. Default false.', default: false },
                quality: { type: 'number', description: 'JPEG quality 1–100. Default 70.', default: 70 },
            },
            required: [],
        },
        execute: async (args: Record<string, unknown>) => {
            const { url, fullPage = false, quality = 70 } = args as { url?: string; fullPage?: boolean; quality?: number };
            const page = await getPage();
            try {
                if (url && page.url() !== url) {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                }
                const buf = await page.screenshot({ type: 'jpeg', quality, fullPage });
                const b64 = buf.toString('base64');
                const title = await page.title().catch(() => '');
                const finalUrl = page.url();
                return `Screenshot captured (${buf.length} bytes, ${fullPage ? 'full page' : 'viewport'})\nURL: ${finalUrl}${title ? `\nTitle: ${title}` : ''}\n\n[base64 JPEG]\ndata:image/jpeg;base64,${b64}`;
            } finally {
                await releasePage(page);
            }
        },
    });

    logger.info(COMPONENT, 'Web browser tools registered (browse_url, browser_search, browser_auto_nav, browser_screenshot)');
}

/** Gracefully close the browser session on gateway shutdown */
export async function closeBrowser(): Promise<void> {
    await closePoolBrowser();
}
