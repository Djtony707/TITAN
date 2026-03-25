/**
 * TITAN — Shared Browser Pool (Stealth Edition)
 * Single Chromium process shared across all browsing tools.
 *
 * Features:
 * - One Chromium process, multiple BrowserContexts
 * - Max 5 concurrent pages (configurable)
 * - Persistent browser state (cookies/localStorage saved to disk)
 * - Full stealth evasion: navigator.webdriver, chrome object, plugins, permissions, WebGL
 * - Human-like timing helpers (random delays, mouse jitter)
 * - reCAPTCHA v3 warm-up for higher trust scores
 * - 30-minute session TTL
 */
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import type * as PlaywrightModule from 'playwright';
import logger from '../utils/logger.js';

const COMPONENT = 'BrowserPool';
const BROWSER_STATE_DIR = join(homedir(), '.titan', 'browser-state');
const STORAGE_STATE_FILE = join(BROWSER_STATE_DIR, 'storage-state.json');
const MAX_PAGES = 5;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Realistic user agents — Chrome 131 across platforms
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

// ── Stealth evasion script injected into every page ──
// Covers: navigator.webdriver, chrome object, plugins, languages, permissions, WebGL, media codecs
const STEALTH_SCRIPT = `
// 1. Remove navigator.webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// 2. Fake chrome runtime object (missing = instant bot flag)
if (!window.chrome) {
    window.chrome = {
        runtime: {
            onMessage: { addListener: function() {}, removeListener: function() {} },
            sendMessage: function() {},
            connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {} }; },
        },
        loadTimes: function() { return {}; },
        csi: function() { return {}; },
    };
}

// 3. Fake plugins array (headless Chrome has 0 plugins = bot)
Object.defineProperty(navigator, 'plugins', {
    get: () => {
        const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
    },
});

// 4. Fake languages
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'language', { get: () => 'en-US' });

// 5. Fix permissions API (headless Chrome returns 'prompt' for everything = suspicious)
const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
if (originalQuery) {
    window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return originalQuery(parameters);
    };
}

// 6. Fake WebGL renderer (headless Chrome uses SwiftShader = instant detection)
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';           // UNMASKED_VENDOR_WEBGL
    if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return getParameter.call(this, parameter);
};
const getParameter2 = WebGL2RenderingContext?.prototype?.getParameter;
if (getParameter2) {
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.call(this, parameter);
    };
}

// 7. Fix media codecs (headless reports empty = suspicious)
if (navigator.mediaDevices) {
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
        { deviceId: 'default', groupId: 'default', kind: 'audioinput', label: '' },
        { deviceId: 'default', groupId: 'default', kind: 'videoinput', label: '' },
        { deviceId: 'default', groupId: 'default', kind: 'audiooutput', label: '' },
    ]);
}

// 8. Fix iframe contentWindow access (Playwright leaks here)
try {
    const elementDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (elementDescriptor) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
            get: function() {
                const result = elementDescriptor.get?.call(this);
                if (result && result.self !== result) {
                    try { Object.defineProperty(result, 'self', { get: () => result }); } catch {}
                }
                return result;
            },
        });
    }
} catch {}

// 9. Prevent stack trace fingerprinting (hide Playwright references in stack traces)
// NOTE: We patch Error.prepareStackTrace instead of replacing the Error constructor,
// because replacing Error breaks ES6 class inheritance on many sites
// (causes "Class constructor Error cannot be invoked without 'new'")
if (typeof Error.prepareStackTrace === 'undefined' || true) {
    const origPrepare = Error.prepareStackTrace;
    Error.prepareStackTrace = function(err, stack) {
        const result = origPrepare ? origPrepare(err, stack) : err.stack;
        return typeof result === 'string' ? result.replace(/__playwright/g, '__chrome') : result;
    };
}
`;

/** Lazy-loaded Playwright types */
let pw: typeof PlaywrightModule | null = null;
let browser: Browser | null = null;
let defaultContext: BrowserContext | null = null;
let launchPromise: Promise<void> | null = null;
let lastActivityMs = 0;
let pageCount = 0;
let sessionTimer: ReturnType<typeof setTimeout> | null = null;
// Consistent UA per session (don't rotate mid-session — that's suspicious)
let sessionUserAgent: string = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

/** Ensure Playwright is available */
async function ensurePlaywright(): Promise<typeof PlaywrightModule> {
    if (pw) return pw;
    try {
        pw = await import('playwright');
        return pw;
    } catch {
        throw new Error('Playwright not installed. Run: npx playwright install chromium');
    }
}

/** Load saved storage state from disk (cookies, localStorage) */
function loadStorageState(): string | undefined {
    try {
        if (existsSync(STORAGE_STATE_FILE)) {
            const raw = readFileSync(STORAGE_STATE_FILE, 'utf-8');
            JSON.parse(raw); // validate
            logger.debug(COMPONENT, 'Loaded persistent browser state from disk');
            return STORAGE_STATE_FILE;
        }
    } catch (e) {
        logger.warn(COMPONENT, `Failed to load storage state: ${e}`);
    }
    return undefined;
}

/** Save current storage state to disk for persistence */
export async function saveStorageState(): Promise<void> {
    if (!defaultContext) return;
    try {
        mkdirSync(BROWSER_STATE_DIR, { recursive: true });
        await defaultContext.storageState({ path: STORAGE_STATE_FILE });
        logger.debug(COMPONENT, 'Saved browser state to disk');
    } catch (e) {
        logger.warn(COMPONENT, `Failed to save storage state: ${e}`);
    }
}

/** Get or create the shared browser instance */
export async function getSharedBrowser(): Promise<Browser> {
    if (browser?.isConnected()) {
        resetSessionTimer();
        return browser;
    }

    if (launchPromise) {
        await launchPromise;
        if (browser?.isConnected()) return browser;
    }

    launchPromise = (async () => {
        const playwright = await ensurePlaywright();
        logger.info(COMPONENT, 'Launching shared Chromium browser (stealth mode)...');

        try {
            mkdirSync(BROWSER_STATE_DIR, { recursive: true });
        } catch { /* exists */ }

        // Use headed mode on machines with displays for better site compatibility
        // (many sites detect headless browsers and refuse to render)
        const useHeadless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
        logger.info(COMPONENT, `Browser mode: ${useHeadless ? 'headless' : 'headed'} (DISPLAY=${process.env.DISPLAY || 'unset'})`);

        // Prefer system Chrome over Playwright's bundled Chromium — it's newer,
        // has better JS compatibility (fixes "Class constructor X cannot be invoked without 'new'"),
        // and sites trust it more. Falls back to bundled Chromium if not installed.
        let useChannel: string | undefined;
        try {
            const { execSync } = await import('child_process');
            const hasChrome = execSync('which google-chrome-stable google-chrome 2>/dev/null', { encoding: 'utf8' }).trim();
            if (hasChrome) {
                useChannel = 'chrome';
                logger.info(COMPONENT, 'Using system Chrome (channel: chrome)');
            }
        } catch {
            logger.info(COMPONENT, 'System Chrome not found, using bundled Chromium');
        }

        browser = await playwright.chromium.launch({
            headless: useHeadless,
            channel: useChannel,
            args: [
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-infobars',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-sync',
                '--no-first-run',
                '--window-size=1280,800',
                // Prevent WebRTC IP leak
                '--disable-webrtc-hw-encoding',
                '--disable-webrtc-hw-decoding',
                // Prevent automation info bar
                '--disable-features=AutomationControlled,TranslateUI',
                '--enable-features=NetworkService,NetworkServiceInProcess',
            ],
        });

        logger.info(COMPONENT, 'Shared browser launched (stealth)');
        resetSessionTimer();
    })();

    await launchPromise;
    launchPromise = null;
    return browser!;
}

/** Get or create the default persistent context */
export async function getDefaultContext(): Promise<BrowserContext> {
    if (defaultContext) {
        resetSessionTimer();
        return defaultContext;
    }

    const b = await getSharedBrowser();

    // Load persistent state (cookies, localStorage) from previous sessions
    const storagePath = loadStorageState();

    defaultContext = await b.newContext({
        userAgent: sessionUserAgent,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
        storageState: storagePath,
        // Extra HTTP headers to look more real
        extraHTTPHeaders: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-CH-UA': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
            'Sec-CH-UA-Mobile': '?0',
            'Sec-CH-UA-Platform': '"macOS"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
        },
    });

    // Inject stealth evasion scripts into every new page in this context
    await defaultContext.addInitScript(STEALTH_SCRIPT);

    logger.info(COMPONENT, 'Default browser context created (stealth, persistent state)');
    return defaultContext;
}

/** Get a new page from the pool (max 5 concurrent) */
export async function getPage(): Promise<Page> {
    if (pageCount >= MAX_PAGES) {
        throw new Error(`Browser pool full: ${pageCount}/${MAX_PAGES} pages in use. Close a page first.`);
    }

    const context = await getDefaultContext();
    const page = await context.newPage();
    pageCount++;
    lastActivityMs = Date.now();

    logger.debug(COMPONENT, `Page created (${pageCount}/${MAX_PAGES})`);
    return page;
}

/** Release a page back to the pool */
export async function releasePage(page: Page): Promise<void> {
    try {
        if (!page.isClosed()) {
            await page.close();
        }
    } catch { /* already closed */ }
    pageCount = Math.max(0, pageCount - 1);
    logger.debug(COMPONENT, `Page released (${pageCount}/${MAX_PAGES})`);

    // Auto-save state after page closes (persist cookies gained during browsing)
    await saveStorageState();
}

/** Reset the session inactivity timer */
function resetSessionTimer(): void {
    lastActivityMs = Date.now();
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
        const idleMs = Date.now() - lastActivityMs;
        if (idleMs >= SESSION_TTL_MS && pageCount === 0) {
            logger.info(COMPONENT, `Session TTL expired (${SESSION_TTL_MS / 60000}min idle). Closing browser.`);
            closeBrowser().catch(() => {});
        }
    }, SESSION_TTL_MS);
}

/** Close the shared browser and clean up */
export async function closeBrowser(): Promise<void> {
    if (sessionTimer) {
        clearTimeout(sessionTimer);
        sessionTimer = null;
    }

    // Save state before closing
    await saveStorageState();

    if (defaultContext) {
        try { await defaultContext.close(); } catch { /* ignore */ }
        defaultContext = null;
    }

    if (browser) {
        try { await browser.close(); } catch { /* ignore */ }
        browser = null;
    }

    pageCount = 0;
    launchPromise = null;
    // Pick new UA for next session
    sessionUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    logger.info(COMPONENT, 'Browser pool closed');
}

// ────────────────────────────────────────────────────────
// Human-like behavior helpers
// ────────────────────────────────────────────────────────

/** Random delay between min and max ms — mimics human thinking/reaction time */
export function humanDelay(minMs = 200, maxMs = 800): Promise<void> {
    const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}

/** Type text with human-like per-character delays */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
    await page.click(selector);
    await humanDelay(100, 300);
    for (const char of text) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 120) + 30 });
    }
}

/** Scroll page naturally (small increments with pauses) */
export async function humanScroll(page: Page, distance = 500): Promise<void> {
    const steps = Math.ceil(distance / 100);
    for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, 100);
        await humanDelay(50, 150);
    }
}

/** Cubic Bezier interpolation for natural-looking curves */
function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Move mouse along a Bezier curve to target coordinates (looks human, not robotic) */
export async function humanMoveMouse(page: Page, x: number, y: number): Promise<void> {
    // Get current mouse position (approximate from viewport center if unknown)
    const viewport = page.viewportSize() || { width: 1280, height: 800 };
    const startX = viewport.width * 0.5 + (Math.random() * 100 - 50);
    const startY = viewport.height * 0.5 + (Math.random() * 100 - 50);

    // Random control points for natural curve (humans don't move in straight lines)
    const cp1x = startX + (x - startX) * 0.25 + (Math.random() - 0.5) * 80;
    const cp1y = startY + (y - startY) * 0.25 + (Math.random() - 0.5) * 80;
    const cp2x = startX + (x - startX) * 0.75 + (Math.random() - 0.5) * 80;
    const cp2y = startY + (y - startY) * 0.75 + (Math.random() - 0.5) * 80;

    const steps = Math.floor(Math.random() * 15) + 10;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = bezier(t, startX, cp1x, cp2x, x);
        const py = bezier(t, startY, cp1y, cp2y, y);
        await page.mouse.move(px, py);
        await new Promise(r => setTimeout(r, Math.random() * 25 + 8));
    }
}

// ────────────────────────────────────────────────────────
// reCAPTCHA v3 warm-up
// ────────────────────────────────────────────────────────

/**
 * Warm up a page for reCAPTCHA v3 scoring.
 * reCAPTCHA v3 scores based on behavior — visiting the page, scrolling,
 * moving the mouse, and spending time builds trust before form submission.
 *
 * On fresh sessions (no Google cookies), visits Google first to establish
 * referrer chain and accumulate trust cookies (biggest single scoring factor).
 *
 * Call this BEFORE filling forms on reCAPTCHA-protected pages.
 */
export async function warmUpForCaptcha(page: Page): Promise<void> {
    logger.info(COMPONENT, 'Warming up page for reCAPTCHA v3 scoring...');

    // 0. Google pre-warm: if no Google cookies exist, visit Google first
    //    Having NID/SID cookies from Google is the single biggest factor (~20-30% of score)
    try {
        const context = page.context();
        const cookies = await context.cookies('https://www.google.com');
        const hasGoogleCookies = cookies.some(c => ['NID', 'SID', 'HSID', '1P_JAR'].includes(c.name));

        if (!hasGoogleCookies) {
            logger.info(COMPONENT, 'Fresh session — visiting Google to build cookie trust...');
            const currentUrl = page.url();
            await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10_000 });
            await humanDelay(1000, 2000);

            // Simulate a small interaction on Google (mouse move, maybe a click)
            const vp = page.viewportSize() || { width: 1280, height: 800 };
            await humanMoveMouse(page, vp.width * 0.5, vp.height * 0.4);
            await humanDelay(500, 1000);

            // Navigate back to the target page (now with Google referrer)
            if (currentUrl && currentUrl !== 'about:blank') {
                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                await humanDelay(1000, 2000);
            }

            // Save the Google cookies for future sessions
            await saveStorageState();
        }
    } catch (e) {
        logger.debug(COMPONENT, `Google pre-warm skipped: ${(e as Error).message}`);
    }

    // 1. Wait for page to fully load
    await page.waitForLoadState('networkidle').catch(() => {});
    await humanDelay(1000, 2000);

    // 2. Simulate natural mouse movements along Bezier curves
    const viewport = page.viewportSize() || { width: 1280, height: 800 };
    const points = [
        { x: viewport.width * 0.3, y: viewport.height * 0.2 },
        { x: viewport.width * 0.7, y: viewport.height * 0.4 },
        { x: viewport.width * 0.5, y: viewport.height * 0.6 },
        { x: viewport.width * 0.2, y: viewport.height * 0.8 },
        { x: viewport.width * 0.6, y: viewport.height * 0.3 },
    ];
    for (const pt of points) {
        await humanMoveMouse(page, pt.x, pt.y);
        await humanDelay(200, 500);
    }

    // 3. Scroll down and back up
    await humanScroll(page, 400);
    await humanDelay(500, 1000);
    await page.mouse.wheel(0, -200);
    await humanDelay(300, 600);

    // 4. Hover over a few elements
    const interactiveElements = await page.$$('a, button, input, textarea, select');
    const toHover = interactiveElements.slice(0, 3);
    for (const el of toHover) {
        try {
            await el.hover();
            await humanDelay(100, 300);
        } catch { /* element might not be visible */ }
    }

    // 5. Wait a bit more — time on page is a scoring factor
    await humanDelay(1500, 3000);

    logger.info(COMPONENT, 'reCAPTCHA warm-up complete');
}

/** Get pool status */
export function getPoolStatus(): { connected: boolean; pages: number; maxPages: number; idleMs: number; stealth: boolean } {
    return {
        connected: browser?.isConnected() ?? false,
        pages: pageCount,
        maxPages: MAX_PAGES,
        idleMs: lastActivityMs ? Date.now() - lastActivityMs : 0,
        stealth: true,
    };
}
