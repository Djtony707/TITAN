/**
 * TITAN — Local-LLM-Friendly Web Browsing
 * Two tools that make browsing work with text-only local LLMs (no vision needed).
 *
 * web_read  — Fetch URL → Readability → Turndown → clean markdown
 * web_act   — Interactive step-by-step browser with numbered elements
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';
import { getPage, releasePage, warmUpForCaptcha, humanDelay } from '../../browsing/browserPool.js';
import { recordSuccessPattern, recordToolResult, learnFact } from '../../memory/learning.js';

const COMPONENT = 'WebBrowseLLM';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PlaywrightPage = import('playwright').Page;

// ─── Shared Playwright types (same as web_browser.ts) ────────────
interface PwLocator { first(): PwLocator; waitFor(opts: unknown): Promise<unknown>; click(opts?: unknown): Promise<void>; pressSequentially(text: string, opts?: unknown): Promise<void> }
interface PwPage {
    goto(url: string, opts?: unknown): Promise<unknown>;
    title(): Promise<string>;
    evaluate(fn: unknown, ...args: unknown[]): Promise<unknown>;
    content(): Promise<string>;
    close(): Promise<void>;
    url(): string;
    click(sel: string, opts?: unknown): Promise<void>;
    fill(sel: string, val: string): Promise<void>;
    waitForTimeout(ms: number): Promise<void>;
    locator(sel: string): PwLocator;
    focus(sel: string): Promise<void>;
    keyboard: { press(key: string): Promise<void> };
    goBack(opts?: unknown): Promise<unknown>;
    mouse: { wheel(dx: number, dy: number): Promise<void>; move(x: number, y: number, opts?: unknown): Promise<void> };
    viewportSize(): { width: number; height: number } | null;
    waitForLoadState(state?: string): Promise<void>;
    $$(sel: string): Promise<Array<{ hover(): Promise<void> }>>;
    isClosed(): boolean;
    waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
    $eval(sel: string, fn: (el: unknown) => unknown): Promise<unknown>;
}

// ─── Token estimation (rough: 1 token ≈ 4 chars) ─────────────────
function truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n\n[... truncated]';
}

// ─── web_read: URL → Readability → Turndown → Markdown ───────────

async function webRead(url: string, maxTokens: number): Promise<string> {
    let html: string;
    let finalUrl = url;

    // Try fast fetch first
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 TITAN-Agent/1.0' },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
        finalUrl = res.url || url;

        // Heuristic: if almost no text, page needs JS rendering
        const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (stripped.length < 200) throw new Error('needs JS');
    } catch {
        // Fallback to Playwright for JS-heavy pages
        logger.info(COMPONENT, `Using Playwright for: ${url}`);
        const page = await getPage() as unknown as PwPage;
        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
            html = await page.content();
            finalUrl = page.url();
        } finally {
            await releasePage(page as unknown as Parameters<typeof releasePage>[0]);
        }
    }

    // Parse with Readability + Turndown
    let title = '';
    let markdown = '';

    try {
        const { JSDOM } = await import('jsdom' as string);
        const dom = new JSDOM(html, { url: finalUrl });
        const doc = dom.window.document;

        // Try Readability first
        const { Readability } = await import('@mozilla/readability' as string);
        const article = new Readability(doc).parse();

        if (article && article.content) {
            title = article.title || '';
            const TurndownService = (await import('turndown' as string)).default || (await import('turndown' as string));
            const td = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
            });
            // Strip images (text-only LLMs can't use them)
            td.addRule('strip-images', {
                filter: 'img',
                replacement: () => '',
            });
            // Simplify tables to text
            td.addRule('simple-tables', {
                filter: 'table',
                replacement: (_content: string, node: unknown) => {
                    const el = node as { textContent?: string };
                    return '\n' + (el.textContent || '').replace(/\s+/g, ' ').trim() + '\n';
                },
            });
            markdown = td.turndown(article.content);
        } else {
            // Fallback: grab main/article/body
            title = doc.title || '';
            const main = doc.querySelector('main') || doc.querySelector('article') || doc.querySelector('[role="main"]') || doc.body;
            if (main) {
                const TurndownService = (await import('turndown' as string)).default || (await import('turndown' as string));
                const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
                td.addRule('strip-images', { filter: 'img', replacement: () => '' });
                markdown = td.turndown(main.innerHTML || main.textContent || '');
            }
        }
    } catch (e) {
        // If Readability/Turndown unavailable, fall back to basic text extraction
        logger.warn(COMPONENT, `Readability/Turndown failed: ${(e as Error).message}`);
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        title = titleMatch?.[1]?.trim() || '';
        markdown = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{3,}/g, '\n\n')
            .trim();
    }

    // Build output
    const header = `# ${title || 'Untitled'}\nSource: ${finalUrl}\n\n`;
    return header + truncateToTokens(markdown, maxTokens);
}

// ─── web_act: Interactive browser with numbered elements ──────────

export interface WebActSession {
    page: PwPage;
    lastUsed: number;
    elements: Map<number, string>; // id -> CSS selector
}

const sessions: Map<string, WebActSession> = new Map();
const SESSION_TTL = 10 * 60 * 1000; // 10 min

// Cleanup stale sessions every 5 min
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastUsed > SESSION_TTL) {
            session.page.close().catch(() => {});
            sessions.delete(id);
            logger.debug(COMPONENT, `Cleaned up stale web_act session: ${id}`);
        }
    }
}, 5 * 60 * 1000).unref();

async function getOrCreateSession(sessionId: string): Promise<WebActSession> {
    let session = sessions.get(sessionId);
    if (session) {
        session.lastUsed = Date.now();
        return session;
    }

    const page = await getPage() as unknown as PwPage;
    session = {
        page,
        lastUsed: Date.now(),
        elements: new Map(),
    };
    sessions.set(sessionId, session);
    return session;
}

/** Build a numbered snapshot of interactive elements on the page */
async function buildSnapshot(session: WebActSession): Promise<string> {
    const page = session.page;
    const title = await page.title();
    const url = page.url();

    // Inject data-titan-id attributes and collect element info
    const elements = await page.evaluate(() => {
        const results: Array<{
            id: number;
            role: string;
            name: string;
            value: string;
            href: string;
            tagName: string;
            type: string;
            checked: boolean;
            disabled: boolean;
        }> = [];

        const selector = [
            'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
            '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
            '[role="menuitem"]', '[contenteditable="true"]',
        ].join(', ');

        const els = document.querySelectorAll(selector);
        let nextId = 1;

        for (const el of els) {
            if (nextId > 80) break;

            const rect = el.getBoundingClientRect();
            // Skip invisible elements
            if (rect.width === 0 || rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            // Skip elements way off screen (>3 viewports below)
            if (rect.top > window.innerHeight * 3) continue;

            const htmlEl = el as HTMLElement;
            const inputEl = el as HTMLInputElement;
            const anchorEl = el as HTMLAnchorElement;

            // Set data attribute for later targeting
            htmlEl.setAttribute('data-titan-id', String(nextId));

            // Determine role
            let role = el.getAttribute('role') || el.tagName.toLowerCase();
            if (role === 'a') role = 'link';
            if (role === 'input') {
                const t = inputEl.type || 'text';
                if (t === 'submit' || t === 'button') role = 'button';
                else if (t === 'checkbox') role = 'checkbox';
                else if (t === 'radio') role = 'radio';
                else role = 'textbox';
            }
            if (role === 'textarea') role = 'textbox';
            if (role === 'select') role = 'combobox';

            // Determine accessible name
            let name =
                el.getAttribute('aria-label') ||
                (el as HTMLElement).innerText?.trim() ||
                inputEl.placeholder ||
                inputEl.name ||
                el.getAttribute('title') ||
                '';
            name = name.slice(0, 60).replace(/\n/g, ' ').trim();

            results.push({
                id: nextId,
                role,
                name,
                value: inputEl.value || '',
                href: anchorEl.href || '',
                tagName: el.tagName.toLowerCase(),
                type: inputEl.type || '',
                checked: inputEl.checked || false,
                disabled: inputEl.disabled || false,
            });
            nextId++;
        }
        return results;
    }) as Array<{
        id: number; role: string; name: string; value: string;
        href: string; tagName: string; type: string; checked: boolean; disabled: boolean;
    }>;

    // Update session element map
    session.elements.clear();
    for (const el of elements) {
        session.elements.set(el.id, `[data-titan-id="${el.id}"]`);
    }

    // Build text output
    const lines: string[] = [];
    lines.push(`Page: "${title}" (${url})`);
    lines.push(`Session: ${[...sessions.entries()].find(([, s]) => s === session)?.[0] || '__default__'}`);
    lines.push('');

    for (const el of elements) {
        let line = `[${el.id}] ${el.role}`;
        if (el.name) line += ` "${el.name}"`;
        if (el.value) line += ` value="${el.value}"`;
        if (el.href && el.role === 'link') line += ` -> ${el.href}`;
        if (el.checked) line += ' [checked]';
        if (el.disabled) line += ' [disabled]';
        lines.push(line);
    }

    // Add condensed page text
    const pageText = await page.evaluate(() => {
        const main = document.querySelector('main') || document.querySelector('article') ||
            document.querySelector('[role="main"]') || document.body;
        return main?.innerText?.slice(0, 2000) || '';
    }) as string;

    if (pageText.trim()) {
        lines.push('');
        lines.push('--- Page content ---');
        lines.push(truncateToTokens(pageText.trim(), 500));
    }

    return lines.join('\n');
}

// ─── Form field discovery (shared by read_form, fill_form, smart_form_fill) ──

interface DiscoveredField {
    selector: string;
    label: string;
    type: string;
    tagName: string;
    role: string;
    placeholder: string;
    ariaLabel: string;
    currentValue: string;
}

/**
 * Discover all form fields on a page — returns structured list with labels, types, selectors.
 * Used by both read_form and fillFormSmart for consistent field detection.
 */
export async function discoverFormFields(page: PwPage): Promise<DiscoveredField[]> {
    return await page.evaluate(() => {
        const elements: Array<{
            selector: string; label: string; type: string; tagName: string;
            role: string; placeholder: string; ariaLabel: string; currentValue: string;
        }> = [];

        function getLabelText(el: HTMLElement): string {
            const id = el.id;
            if (id) {
                const label = document.querySelector(`label[for="${id}"]`);
                if (label?.textContent?.trim()) return label.textContent.trim();
            }
            const parentLabel = el.closest('label');
            if (parentLabel) {
                const text = parentLabel.textContent?.replace(el.textContent || '', '').trim();
                if (text) return text;
            }
            let prev = el.previousElementSibling;
            if (prev?.tagName === 'LABEL') return prev.textContent?.trim() || '';
            let parent = el.parentElement;
            for (let depth = 0; depth < 3 && parent; depth++) {
                const lbl = parent.querySelector(':scope > label');
                if (lbl?.textContent?.trim()) return lbl.textContent.trim();
                prev = parent.previousElementSibling;
                if (prev?.tagName === 'LABEL') return prev.textContent?.trim() || '';
                parent = parent.parentElement;
            }
            return el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
        }

        const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), textarea, select, [role="combobox"], [contenteditable="true"]');
        let idx = 0;
        for (const el of inputs) {
            const htmlEl = el as HTMLInputElement;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            const titanId = `_titan_form_${idx}`;
            htmlEl.setAttribute('data-titan-form', titanId);
            elements.push({
                selector: `[data-titan-form="${titanId}"]`,
                label: getLabelText(htmlEl),
                type: htmlEl.type || '',
                tagName: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                placeholder: htmlEl.placeholder || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                currentValue: htmlEl.value || '',
            });
            idx++;
        }

        const buttons = document.querySelectorAll('button, input[type="radio"], [role="button"]');
        for (const el of buttons) {
            const htmlEl = el as HTMLElement;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            const titanId = `_titan_form_${idx}`;
            htmlEl.setAttribute('data-titan-form', titanId);
            elements.push({
                selector: `[data-titan-form="${titanId}"]`,
                label: htmlEl.innerText?.trim() || htmlEl.getAttribute('aria-label') || (el as HTMLInputElement).value || '',
                type: (el as HTMLInputElement).type || 'button',
                tagName: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                placeholder: '',
                ariaLabel: el.getAttribute('aria-label') || '',
                currentValue: '',
            });
            idx++;
        }

        return elements;
    }) as DiscoveredField[];
}

/**
 * Detect CAPTCHA on a page — returns description or null.
 */
export async function detectCaptcha(page: PwPage): Promise<string | null> {
    return await page.evaluate(() => {
        const recaptcha = document.querySelector('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]');
        if (recaptcha) return 'reCAPTCHA detected';
        const hcaptcha = document.querySelector('iframe[src*="hcaptcha"]');
        if (hcaptcha) return 'hCaptcha detected';
        const cf = document.querySelector('#challenge-form, .cf-turnstile, iframe[src*="challenges.cloudflare"]');
        if (cf) return 'Cloudflare challenge detected';
        const generic = document.querySelector('[class*="captcha" i], [id*="captcha" i]');
        if (generic) return 'CAPTCHA detected';
        return null;
    }) as string | null;
}

/**
 * Smart form filler — matches field labels to values and fills them automatically.
 * This allows a single tool call to fill an entire form instead of 10+ sequential calls.
 */
export async function fillFormSmart(session: WebActSession, url: string, fields: Record<string, string>, autoSubmit = false): Promise<string> {
    const page = session.page;
    const pageErrors: string[] = [];

    // Navigate to the form page if URL provided and different from current
    if (url && page.url() !== url) {
        // Monitor for network/console errors during page load
        try {
            const realPage = page as unknown as PlaywrightPage;
            realPage.on('pageerror', (err) => pageErrors.push(`JS Error: ${err.message}${err.stack ? '\n  Stack: ' + err.stack.split('\n').slice(1, 4).join('\n  ') : ''}`));
            realPage.on('requestfailed', (req) => pageErrors.push(`Network fail: ${req.url().slice(0, 150)} → ${req.failure()?.errorText || 'unknown'}`));
            realPage.on('console', (msg) => {
                const text = msg.text().slice(0, 300);
                if (msg.type() === 'error') pageErrors.push(`Console error: ${text}`);
                else if (msg.type() === 'warning') pageErrors.push(`Console warn: ${text}`);
            });
        } catch { /* page type mismatch is non-fatal */ }

        await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
        // Wait for JS-rendered forms (SPA frameworks like React/Ashby need extra time)
        await page.waitForTimeout(3000);
        // Try to wait for form inputs to appear (best-effort)
        try {
            await page.waitForSelector('input, textarea, select, [role="combobox"], [contenteditable]', { timeout: 15_000 });
            await page.waitForTimeout(2000); // Extra buffer after first input appears
        } catch {
            logger.warn(COMPONENT, 'fillFormSmart: No form inputs found after 15s wait');
            // Last resort: scroll down and try again (some SPAs lazy-load forms)
            try {
                await page.evaluate(() => window.scrollTo(0, 500));
                await page.waitForTimeout(3000);
            } catch { /* best-effort */ }
        }
    }

    // Warm up for reCAPTCHA v3 scoring — natural mouse movements, scrolling, hovering
    // This builds trust score BEFORE we start filling the form
    try {
        await warmUpForCaptcha(page as unknown as PlaywrightPage);
    } catch (e) {
        logger.warn(COMPONENT, `Warm-up failed (non-fatal): ${(e as Error).message}`);
    }

    const results: string[] = [];
    results.push(`Form filling: ${Object.keys(fields).length} fields to fill`);
    results.push('');

    // Quick page state check
    try {
        const pageState = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            inputCount: document.querySelectorAll('input, textarea, select').length,
        })) as { url: string; title: string; inputCount: number };
        logger.info(COMPONENT, `fillFormSmart: page="${pageState.title}", inputs=${pageState.inputCount}`);
    } catch { /* non-fatal */ }

    // Log any network/JS errors captured during page load
    if (pageErrors.length > 0) {
        logger.warn(COMPONENT, `fillFormSmart: ${pageErrors.length} page errors during load:`);
        for (const err of pageErrors.slice(0, 20)) {
            logger.warn(COMPONENT, `  ${err}`);
        }
        results.push(`⚠️ ${pageErrors.length} page errors detected during load (check logs)`);
    }

    // Step 1: Discover form fields using shared helper
    const formElements = await discoverFormFields(page);

    results.push(`Found ${formElements.length} form elements on page`);
    logger.info(COMPONENT, `fillFormSmart: discovered ${formElements.length} fields on ${url}`);
    for (const el of formElements) {
        logger.debug(COMPONENT, `  field: "${el.label}" type=${el.type} tag=${el.tagName} role=${el.role}`);
    }

    // Pre-read validation: if ALL user field names are unmatched, return field list immediately
    const fieldKeys = Object.keys(fields).filter(k => k !== 'submit' && k !== 'Submit');

    // Normalize field name: "agent_name" → "agent name", "operatorEmail" → "operator email"
    function normalize(s: string): string {
        return s
            .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → spaces
            .replace(/[_\-./]+/g, ' ')              // underscores, dashes → spaces
            .replace(/[^\w\s]/g, '')                // strip punctuation
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Fuzzy match helper — returns best matching element for a field name
    function findBestMatch(fieldName: string): typeof formElements[0] | null {
        const norm = normalize(fieldName);
        const lower = fieldName.toLowerCase();

        // First try exact label match (original + normalized)
        const exact = formElements.find(e => {
            const l = e.label.toLowerCase();
            const nl = normalize(e.label);
            return l === lower || l === norm || nl === norm ||
                e.ariaLabel.toLowerCase() === lower || normalize(e.ariaLabel) === norm ||
                e.placeholder.toLowerCase() === lower;
        });
        if (exact) return exact;

        // Then try substring match (both directions)
        const partial = formElements.find(e => {
            const nl = normalize(e.label);
            return nl.includes(norm) || norm.includes(nl) ||
                e.label.toLowerCase().includes(lower) ||
                lower.includes(e.label.toLowerCase()) ||
                normalize(e.ariaLabel).includes(norm) ||
                normalize(e.placeholder).includes(norm);
        });
        if (partial) return partial;

        // Try word overlap (with normalized tokens)
        const words = norm.split(/\s+/).filter(w => w.length > 1);
        let bestScore = 0;
        let bestEl: typeof formElements[0] | null = null;
        for (const el of formElements) {
            const elText = normalize(`${el.label} ${el.ariaLabel} ${el.placeholder}`);
            const matched = words.filter(w => elText.includes(w)).length;
            const score = words.length > 0 ? matched / words.length : 0;
            if (score > bestScore) {
                bestScore = score;
                bestEl = el;
            }
        }
        // Require at least 50% word overlap
        return bestScore >= 0.5 ? bestEl : null;
    }

    // Pre-read check: if ALL data fields are unmatched, return discovered labels for retry
    if (fieldKeys.length > 0 && formElements.length > 0) {
        const matchCount = fieldKeys.filter(k => findBestMatch(k) !== null).length;
        if (matchCount === 0) {
            const availableLabels = formElements
                .filter(e => e.label && e.type !== 'button' && e.type !== 'radio')
                .map(e => `  - "${e.label}" [${e.type || e.tagName}]`);
            return `Error: None of your ${fieldKeys.length} field names matched the form.\n\nAvailable fields on this page:\n${availableLabels.join('\n')}\n\nRetry with the EXACT field labels listed above.`;
        }
    }

    // Fill each field — text/select fields first, buttons/radios deferred to second pass
    // (clicking buttons can change page state, so fill all inputs before clicking)
    const deferredClicks: Array<{ fieldName: string; value: string }> = [];

    for (const [fieldName, value] of Object.entries(fields)) {
        const valueStr = String(value);
        // Human-like pause between fields — bots fill instantly, humans don't
        await humanDelay(300, 900);
        try {
            const normFieldName = normalize(fieldName);

            const el = findBestMatch(fieldName);

            // If no text/select match found, check if this is a button/radio click — defer it
            if (!el) {
                const isSelect = valueStr === 'true' || valueStr === 'false' || valueStr === '';
                if (isSelect) {
                    const matchingBtn = formElements.find(e =>
                        (e.type === 'radio' || e.type === 'button' || e.tagName === 'button') &&
                        normalize(e.label) === normFieldName
                    );
                    if (matchingBtn) { deferredClicks.push({ fieldName, value: valueStr }); continue; }
                }
                const buttonEl = formElements.find(e =>
                    (e.type === 'button' || e.type === 'radio' || e.tagName === 'button' || e.role === 'button') &&
                    (e.label.toLowerCase().includes(valueStr.toLowerCase()) ||
                     normalize(e.label).includes(normFieldName) ||
                     normFieldName.includes(normalize(e.label)))
                );
                if (buttonEl) { deferredClicks.push({ fieldName, value: valueStr }); continue; }
                results.push(`❌ Could not find field: "${fieldName}"`);
                continue;
            }

            // Handle different field types
            if (el.type === 'radio' || el.type === 'button' || el.tagName === 'button') {
                // Defer button/radio clicks to second pass
                deferredClicks.push({ fieldName, value: valueStr });
            } else if (el.role === 'combobox' || el.placeholder?.toLowerCase().includes('start typing')) {
                // Combobox/autocomplete: type then select from dropdown (React-compatible)
                const comboLocator = page.locator(el.selector);
                await comboLocator.click({ timeout: 3000 }).catch(() => {});
                await comboLocator.pressSequentially(value, { delay: 10 });
                await page.waitForTimeout(1500); // Wait for dropdown to appear
                // Try to click the first dropdown option
                try {
                    // Look for listbox/option elements
                    await page.evaluate(() => {
                        const options = document.querySelectorAll('[role="option"], [role="listbox"] li, .autocomplete-item, .suggestion');
                        if (options.length > 0) (options[0] as HTMLElement).click();
                    });
                    await page.waitForTimeout(500);
                    results.push(`✅ Filled combobox "${fieldName}" with "${value}" and selected first option`);
                } catch {
                    results.push(`⚠️ Filled combobox "${fieldName}" with "${value}" but could not select option`);
                }
            } else {
                // Standard text input — use pressSequentially for React SPA compatibility
                // page.fill() sets DOM .value but doesn't trigger React's synthetic onChange events.
                // pressSequentially types char-by-char, which fires all React event handlers.
                const locator = page.locator(el.selector);
                await locator.click({ timeout: 3000 }).catch(() => {});
                // Clear existing value first
                await page.evaluate((sel: string) => {
                    const input = document.querySelector(sel) as HTMLInputElement;
                    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
                }, el.selector);
                await locator.pressSequentially(value, { delay: 5 });
                await page.waitForTimeout(300);
                results.push(`✅ Filled "${fieldName}" with "${value.slice(0, 50)}${value.length > 50 ? '...' : ''}"`);
            }
        } catch (e) {
            results.push(`❌ Error filling "${fieldName}": ${(e as Error).message?.split('\n')[0]}`);
        }
    }

    // Second pass: execute deferred button/radio clicks (after all text fields are filled)
    for (const { fieldName, value } of deferredClicks) {
        await humanDelay(300, 600);
        try {
            const normFieldName = normalize(fieldName);
            // Try exact label match first
            const isSelect = value === 'true' || value === 'false' || value === '';
            if (isSelect) {
                const matchingBtn = formElements.find(e =>
                    (e.type === 'radio' || e.type === 'button' || e.tagName === 'button') &&
                    normalize(e.label) === normFieldName
                );
                if (matchingBtn) {
                    await page.click(matchingBtn.selector, { timeout: 5000 });
                    await page.waitForTimeout(500);
                    results.push(`✅ Selected "${fieldName}"`);
                    continue;
                }
            }
            // Try value-based button match
            const el = findBestMatch(fieldName);
            if (el && (el.type === 'radio' || el.type === 'button' || el.tagName === 'button')) {
                const target = formElements.find(e =>
                    e.label.toLowerCase().includes(value.toLowerCase()) &&
                    (e.type === 'radio' || e.type === 'button' || e.tagName === 'button')
                );
                if (target) {
                    await page.click(target.selector, { timeout: 5000 });
                    await page.waitForTimeout(500);
                    results.push(`✅ Clicked "${value}" for "${fieldName}"`);
                } else {
                    results.push(`❌ Could not find option "${value}" for "${fieldName}"`);
                }
            } else {
                // Fallback: find any button matching field name or value
                const buttonEl = formElements.find(e =>
                    (e.type === 'button' || e.type === 'radio' || e.tagName === 'button' || e.role === 'button') &&
                    (e.label.toLowerCase().includes(value.toLowerCase()) ||
                     normalize(e.label).includes(normFieldName) ||
                     normFieldName.includes(normalize(e.label)))
                );
                if (buttonEl) {
                    await page.click(buttonEl.selector, { timeout: 5000 });
                    await page.waitForTimeout(500);
                    results.push(`✅ Clicked "${buttonEl.label}" for "${fieldName}"`);
                } else {
                    results.push(`❌ Could not find button: "${fieldName}" = "${value}"`);
                }
            }
        } catch (e) {
            results.push(`❌ Error clicking "${fieldName}": ${(e as Error).message?.split('\n')[0]}`);
        }
    }

    // Post-fill verification: re-read values and compare to intended
    try {
        const verifyResults = await page.evaluate(() => {
            const results: Array<{ selector: string; value: string }> = [];
            const inputs = document.querySelectorAll('[data-titan-form]');
            for (const el of inputs) {
                const htmlEl = el as HTMLInputElement;
                results.push({ selector: el.getAttribute('data-titan-form') || '', value: htmlEl.value || '' });
            }
            return results;
        }) as Array<{ selector: string; value: string }>;
        const mismatches: string[] = [];
        for (const [fieldName, value] of Object.entries(fields)) {
            if (fieldName === 'submit' || fieldName === 'Submit') continue;
            const el = findBestMatch(fieldName);
            if (!el) continue;
            const titanId = el.selector.match(/_titan_form_\d+/)?.[0];
            if (!titanId) continue;
            const verified = verifyResults.find(v => v.selector === titanId);
            if (verified && verified.value && verified.value !== String(value) && verified.value.toLowerCase() !== String(value).toLowerCase()) {
                mismatches.push(`  "${fieldName}": expected "${String(value).slice(0, 40)}", got "${verified.value.slice(0, 40)}"`);
            }
        }
        if (mismatches.length > 0) {
            results.push('');
            results.push('⚠️ Verification mismatches:');
            results.push(...mismatches);
        }
    } catch { /* verification is best-effort */ }

    // CAPTCHA detection before submit
    const captcha = await detectCaptcha(page);

    // Auto-submit if requested (autoSubmit param, or submit/Submit in fields dict)
    const submitValue = autoSubmit ? 'true' : (fields['submit'] || fields['Submit']);
    let captchaSolved = false;
    if (submitValue && captcha) {
        // Try CapSolver if configured
        try {
            const { solveCaptcha } = await import('../../browsing/captchaSolver.js');
            const solveResult = await solveCaptcha(page as unknown as PlaywrightPage);
            if (solveResult.solved) {
                results.push(`\n✅ ${solveResult.type} solved via CapSolver`);
                captchaSolved = true;
            } else {
                results.push(`\n⚠️ ${captcha} — CapSolver: ${solveResult.error || 'failed'}. User must complete CAPTCHA manually at: ${page.url()}`);
            }
        } catch {
            results.push(`\n⚠️ ${captcha} — cannot auto-submit. User must complete CAPTCHA manually at: ${page.url()}`);
        }
    }

    if (submitValue && (!captcha || captchaSolved)) {
        try {
            const submitText = typeof submitValue === 'string' && submitValue !== 'true' ? submitValue : 'submit';
            const submitted = await page.evaluate((text: string) => {
                const lower = text.toLowerCase();
                const candidates = document.querySelectorAll('button, input[type="submit"], [role="button"]');
                for (const el of candidates) {
                    const elText = (el as HTMLElement).innerText?.trim().toLowerCase() || (el as HTMLInputElement).value?.toLowerCase() || '';
                    if (elText.includes(lower) || elText.includes('submit') || elText.includes('apply')) {
                        (el as HTMLElement).click();
                        return elText;
                    }
                }
                return null;
            }, submitText) as string | null;

            if (submitted) {
                await page.waitForTimeout(3000);
                results.push(`\n✅ Clicked submit button: "${submitted}"`);
            } else {
                results.push('\n⚠️ Could not find submit button');
            }
        } catch (e) {
            results.push(`\n❌ Submit error: ${(e as Error).message?.split('\n')[0]}`);
        }
    }

    // Return compact result — no full snapshot (too large for local models)
    const filledCount = results.filter(r => r.startsWith('✅')).length;
    const failedCount = results.filter(r => r.startsWith('❌')).length;
    results.push('');
    results.push(`Summary: ${filledCount} filled, ${failedCount} failed out of ${Object.keys(fields).length} fields`);
    logger.info(COMPONENT, `fillFormSmart result: ${filledCount} filled, ${failedCount} failed out of ${Object.keys(fields).length} fields`);
    for (const r of results.filter(r => r.startsWith('✅') || r.startsWith('❌') || r.startsWith('⚠️'))) {
        logger.info(COMPONENT, `  ${r}`);
    }

    // List available form fields so model can retry with correct names
    if (failedCount > 0) {
        results.push('');
        results.push('Available form fields on this page:');
        for (const el of formElements) {
            if (el.label && el.type !== 'button' && el.type !== 'radio') {
                results.push(`  - "${el.label}" (${el.type || el.tagName})`);
            }
        }
        results.push('');
        results.push('RETRY: Call smart_form_fill again with ONLY the failed fields, using exact labels above.');
    }

    // Learning hooks: record successful fills for future reference
    try {
        const pageUrl = page.url();
        const hostname = new URL(pageUrl).hostname;
        recordToolResult('smart_form_fill', failedCount === 0, pageUrl, failedCount > 0 ? `${failedCount} fields failed` : undefined);
        if (failedCount === 0) {
            recordSuccessPattern({
                topic: `form_fill:${hostname}`,
                toolsUsed: ['smart_form_fill'],
                outcome: `Filled ${filledCount} fields on ${pageUrl}`,
            });
            const fieldLabels = formElements
                .filter(e => e.label && e.type !== 'button' && e.type !== 'radio')
                .map(e => `"${e.label}"`).join(', ');
            learnFact('form_fields', `Form at ${hostname}: fields are ${fieldLabels}`, pageUrl);
        }
    } catch { /* learning is best-effort */ }

    return results.join('\n');
}

/** Parse and execute a web_act action */
async function executeAction(session: WebActSession, action: string): Promise<string> {
    const page = session.page;
    const parts = action.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    try {
        switch (cmd) {
            case 'open': {
                let url = parts[1];
                if (!url) return 'Error: open requires a URL. Usage: open <url>';
                // Auto-prefix protocol if missing
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'https://' + url;
                }
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                await page.waitForTimeout(1000);
                return buildSnapshot(session);
            }
            case 'click': {
                const arg = parts.slice(1).join(' ');
                const n = parseInt(arg);
                if (!isNaN(n)) {
                    // Click by element number
                    const sel = session.elements.get(n);
                    if (!sel) return `Error: element [${n}] not found. Run snapshot to refresh.`;
                    await page.click(sel, { timeout: 5000 });
                } else if (arg) {
                    // Click by text content — find button/link with matching text
                    const clicked = await page.evaluate((text: string) => {
                        const lower = text.toLowerCase().trim();
                        const candidates = document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="radio"]');
                        for (const el of candidates) {
                            const elText = (el as HTMLElement).innerText?.trim().toLowerCase() || (el as HTMLInputElement).value?.toLowerCase() || '';
                            if (elText === lower || elText.includes(lower)) {
                                (el as HTMLElement).click();
                                return elText;
                            }
                        }
                        return null;
                    }, arg) as string | null;
                    if (!clicked) return `Error: no button/link with text "${arg}" found. Try snapshot to see available elements.`;
                } else {
                    return 'Error: click requires element number or text. Usage: click <n> OR click Submit Application';
                }
                await page.waitForTimeout(1000);
                return buildSnapshot(session);
            }
            case 'type': {
                const n = parseInt(parts[1]);
                const text = parts.slice(2).join(' ');
                const sel = session.elements.get(n);
                if (!sel) return `Error: element [${n}] not found.`;
                if (!text) return 'Error: type requires text. Usage: type <n> <text>';
                await page.fill(sel, text);
                return buildSnapshot(session);
            }
            case 'press': {
                const n = parseInt(parts[1]);
                const key = parts[2];
                const sel = session.elements.get(n);
                if (!sel) return `Error: element [${n}] not found.`;
                if (!key) return 'Error: press requires a key. Usage: press <n> <key>';
                await page.focus(sel);
                await page.keyboard.press(key);
                await page.waitForTimeout(1000);
                return buildSnapshot(session);
            }
            case 'select': {
                const n = parseInt(parts[1]);
                const value = parts.slice(2).join(' ');
                const sel = session.elements.get(n);
                if (!sel) return `Error: element [${n}] not found.`;
                await page.evaluate((selector: string, val: string) => {
                    const el = document.querySelector(selector) as HTMLSelectElement;
                    if (!el) return;
                    for (const opt of el.options) {
                        if (opt.text.trim().toLowerCase().includes(val.toLowerCase()) || opt.value === val) {
                            el.value = opt.value;
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            break;
                        }
                    }
                }, sel, value);
                return buildSnapshot(session);
            }
            case 'scroll': {
                const dir = parts[1]?.toLowerCase();
                const amount = dir === 'up' ? -600 : 600;
                await page.mouse.wheel(0, amount);
                await page.waitForTimeout(500);
                return buildSnapshot(session);
            }
            case 'back': {
                await page.goBack({ timeout: 10_000 });
                await page.waitForTimeout(1000);
                return buildSnapshot(session);
            }
            case 'snapshot': {
                return buildSnapshot(session);
            }
            case 'read_form': {
                // Compact form-only view for local models — just fields and their labels
                const formInfo = await page.evaluate(() => {
                    const fields: string[] = [];

                    // Helper: find label for an element by walking up DOM
                    function findLabel(el: Element): string {
                        const htmlEl = el as HTMLInputElement;
                        // 1. label[for=id]
                        if (htmlEl.id) {
                            const lbl = document.querySelector(`label[for="${htmlEl.id}"]`);
                            if (lbl?.textContent?.trim()) return lbl.textContent.trim();
                        }
                        // 2. Previous sibling label
                        let prev = el.previousElementSibling;
                        if (prev?.tagName === 'LABEL') return prev.textContent?.trim() || '';
                        // 3. Walk up to parent/grandparent and find first label child
                        let parent = el.parentElement;
                        for (let depth = 0; depth < 3 && parent; depth++) {
                            const lbl = parent.querySelector(':scope > label');
                            if (lbl?.textContent?.trim()) return lbl.textContent.trim();
                            // Check previous sibling of parent too
                            prev = parent.previousElementSibling;
                            if (prev?.tagName === 'LABEL') return prev.textContent?.trim() || '';
                            parent = parent.parentElement;
                        }
                        // 4. aria-label or placeholder
                        return htmlEl.getAttribute('aria-label') || htmlEl.placeholder || '';
                    }

                    // Collect all form inputs (not radios/buttons — handled separately)
                    const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], textarea, select, [role="combobox"]');
                    for (const el of inputs) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        const style = window.getComputedStyle(el);
                        if (style.display === 'none' || style.visibility === 'hidden') continue;
                        const label = findLabel(el).slice(0, 100);
                        const type = (el as HTMLInputElement).type || el.getAttribute('role') || el.tagName.toLowerCase();
                        const val = (el as HTMLInputElement).value || '';
                        fields.push(`- "${label}" [${type}]${val ? ` = "${val}"` : ''}`);
                    }

                    // Collect buttons that look like Yes/No options (not submit/nav)
                    const buttons = document.querySelectorAll('button');
                    const yesNoButtons: string[] = [];
                    let lastQuestion = '';
                    for (const btn of buttons) {
                        const text = btn.innerText?.trim();
                        if (!text || text.length > 20) continue;
                        const rect = btn.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        // Check if there's a question label before this button group
                        let parent = btn.parentElement;
                        for (let d = 0; d < 3 && parent; d++) {
                            const prev = parent.previousElementSibling;
                            if (prev?.tagName === 'LABEL' && prev.textContent?.trim() && prev.textContent.trim() !== lastQuestion) {
                                lastQuestion = prev.textContent.trim().slice(0, 100);
                                break;
                            }
                            parent = parent.parentElement;
                        }
                        if (text.toLowerCase() === 'yes' || text.toLowerCase() === 'no') {
                            yesNoButtons.push(text);
                        }
                    }
                    if (yesNoButtons.length > 0 && lastQuestion) {
                        fields.push(`- "${lastQuestion}" [buttons: ${yesNoButtons.join(' / ')}]`);
                    }

                    // Collect radio groups with their question
                    const radios = document.querySelectorAll('input[type="radio"]');
                    const seen = new Set<string>();
                    for (const r of radios) {
                        const radio = r as HTMLInputElement;
                        const name = radio.name || 'radio';
                        if (seen.has(name)) continue;
                        // Get all radios in this group
                        const group = document.querySelectorAll(`input[name="${name}"]`);
                        const options: string[] = [];
                        for (const g of group) {
                            const lbl = document.querySelector(`label[for="${(g as HTMLInputElement).id}"]`);
                            const text = lbl?.textContent?.trim().slice(0, 60) || (g as HTMLInputElement).value;
                            options.push(text + ((g as HTMLInputElement).checked ? ' [selected]' : ''));
                        }
                        fields.push(`- Radio choose one: ${options.join(' | ')}`);
                        seen.add(name);
                    }

                    // Find submit button
                    const submitBtns = document.querySelectorAll('button[type="submit"], input[type="submit"]');
                    for (const btn of submitBtns) {
                        const text = (btn as HTMLElement).innerText?.trim() || (btn as HTMLInputElement).value || 'Submit';
                        fields.push(`- Submit button: "${text}"`);
                    }
                    // Also check for buttons with "submit" or "apply" text
                    if (submitBtns.length === 0) {
                        for (const btn of document.querySelectorAll('button')) {
                            const text = btn.innerText?.trim().toLowerCase();
                            if (text?.includes('submit') || text?.includes('apply')) {
                                fields.push(`- Submit button: "${btn.innerText.trim()}"`);
                                break;
                            }
                        }
                    }

                    return fields.join('\n');
                }) as string;
                const title = await page.title();
                return `Form fields on "${title}":\n${formInfo || '(no form fields found)'}\n\nTo fill this form, use fill_form with EXACT field labels as keys in form_data JSON. For Yes/No questions, include the field label as key and "Yes" or "No" as value. For radio options, use the option text as value. Add "submit": "Submit Application" to auto-submit.`;
            }
            case 'text': {
                const fullText = await page.evaluate(() => {
                    const main = document.querySelector('main') || document.querySelector('article') ||
                        document.querySelector('[role="main"]') || document.body;
                    return main?.innerText || '';
                }) as string;
                return truncateToTokens(fullText, 3000);
            }
            case 'fill_form': {
                // Parse JSON from the rest of the action string
                // Format: fill_form <url> <json> OR just fill_form <json> (uses current page)
                const restText = action.replace(/^fill_form\s*/, '').trim();
                let formUrl = '';
                let jsonStr = restText;

                // Check if first arg is a URL
                if (restText.startsWith('http://') || restText.startsWith('https://')) {
                    const spaceIdx = restText.indexOf(' ');
                    if (spaceIdx > 0) {
                        formUrl = restText.slice(0, spaceIdx);
                        jsonStr = restText.slice(spaceIdx + 1).trim();
                    }
                }

                try {
                    const fields = JSON.parse(jsonStr);
                    if (typeof fields !== 'object' || fields === null) {
                        return 'Error: fill_form requires a JSON object. Usage: fill_form [url] {"field": "value", ...}';
                    }
                    return fillFormSmart(session, formUrl, fields as Record<string, string>);
                } catch (e) {
                    return `Error parsing form data: ${(e as Error).message}. Usage: fill_form [url] {"Field Label": "value", ...}`;
                }
            }
            default:
                return `Unknown action: "${cmd}". Available: open, click, type, press, select, scroll, back, snapshot, text, fill_form`;
        }
    } catch (e) {
        const msg = (e as Error).message?.split('\n')[0] || 'Unknown error';
        logger.warn(COMPONENT, `web_act action "${action}" failed: ${msg}`);
        return `Error: ${msg}\n\nTry "snapshot" to refresh the page state.`;
    }
}

// ─── Register tools ───────────────────────────────────────────────

export function registerWebBrowseLlmSkill(): void {
    // web_read
    registerSkill({
        name: 'web_read',
        description: 'Read a webpage as clean markdown. Uses Readability + Turndown. Works with text-only LLMs.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'web_read',
        description: 'Fetch a URL and return clean structured markdown — strips ads, nav, scripts, leaving just the article content.\n\nUSE THIS WHEN Tony says: "read X" / "summarize this article" / "what does this page say" / "get the content from X" / "open this link"\n\nUSE web_read (not web_fetch) when:\n- You need clean readable article/doc content (Readability extraction)\n- Working with a local LLM that needs minimal noise\n\nWORKFLOW: Call web_read → summarize the content → answer Tony\'s question\nNEVER just return the raw markdown dump — always synthesize it.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to read' },
                maxTokens: { type: 'number', description: 'Maximum tokens in the response (default: 5000)', default: 5000 },
            },
            required: ['url'],
        },
        execute: async (args) => {
            const url = args.url as string;
            if (!url) return 'Error: url is required.';
            const maxTokens = Math.max(100, (args.maxTokens as number) || 5000);
            logger.info(COMPONENT, `web_read: ${url}`);
            try {
                return await webRead(url, maxTokens);
            } catch (e) {
                const msg = (e as Error).message?.split('\n')[0] || 'Unknown error';
                logger.warn(COMPONENT, `web_read failed for ${url}: ${msg}`);
                return `Error reading ${url}: ${msg}`;
            }
        },
    });

    // web_act
    registerSkill({
        name: 'web_act',
        description: 'Interactive step-by-step browser. Returns numbered elements for text-only LLM interaction.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'web_act',
        description: 'Interactive browser — navigate, click, type, scroll, and interact with web pages step by step.\n\nUSE THIS WHEN Tony says: "click X on that page" / "go to X then click Y" / "scroll down" / "navigate to X" / "log in to X" / "browse X" / "interact with X website"\n\nACTIONS: "open <url>", "click <n>", "type <n> <text>", "press <n> Enter", "select <n> <value>", "scroll up|down", "back", "snapshot", "text", "read_form"\n\nRULES:\n- For filling forms, prefer smart_form_fill — it handles the full read→fill→verify workflow in ONE call\n- Use web_act for general browsing, clicking links, navigating pages, and non-form interactions\n- After each action, call "snapshot" to see the current state of the page',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'Action: "open <url>", "click <n>", "type <n> <text>", "read_form" (list form fields), "fill_form" (fill form), "snapshot", "scroll up|down", "text"' },
                url: { type: 'string', description: 'URL for fill_form action — the page with the form to fill' },
                form_data: { type: 'string', description: 'JSON string for fill_form — maps field labels to values. Example: {"Name": "TITAN", "Email": "user@example.com", "Visa": "No"}' },
                sessionId: { type: 'string', description: 'Session ID for persistent browsing (optional)' },
            },
            required: ['action'],
        },
        execute: async (args) => {
            const action = args.action as string;
            const sessionId = (args.sessionId as string) || '__default__';
            logger.info(COMPONENT, `web_act [${sessionId}]: ${action}`);

            const session = await getOrCreateSession(sessionId);

            // Handle fill_form — LLMs may pass url/form_data as separate params
            const cmd = action.trim().split(/\s+/)[0]?.toLowerCase();

            // Redirect: LLMs sometimes pass "smart_form_fill" as a web_act action
            if (cmd === 'smart_form_fill') {
                const formUrl = (args.url as string) || '';
                const formDataStr = (args.form_data as string) || (args.data as string) || '';
                let fields: Record<string, string> | null = null;
                if (formDataStr) {
                    try { fields = JSON.parse(formDataStr); } catch { /* ignore */ }
                }
                if (!fields) {
                    const jsonMatch = action.match(/\{[\s\S]+\}/);
                    if (jsonMatch) {
                        try { fields = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
                    }
                }
                if (fields) {
                    const submitArg = (args.submit as string) || 'false';
                    const doSubmit = submitArg === 'true' || submitArg === '1';
                    logger.info(COMPONENT, `Redirecting web_act "smart_form_fill" action → fillFormSmart (${Object.keys(fields).length} fields)`);
                    if (formUrl && session.page.url() !== formUrl) {
                        await session.page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                        await session.page.waitForTimeout(2000);
                    }
                    return fillFormSmart(session, formUrl || session.page.url(), fields, doSubmit);
                }
                // No data provided — discover fields and return them so the model can retry
                logger.info(COMPONENT, 'web_act smart_form_fill redirect: no data provided, discovering fields');
                if (formUrl && session.page.url() !== formUrl) {
                    try {
                        await session.page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                        await session.page.waitForTimeout(2000);
                    } catch (err) {
                        return `Error navigating to form: ${err instanceof Error ? err.message : String(err)}`;
                    }
                }
                const discoveredFields = await discoverFormFields(session.page);
                if (discoveredFields.length === 0) {
                    return 'No form fields found on this page. Try navigating to the form URL first.';
                }
                const fieldList = discoveredFields.map(f => {
                    const desc = f.label || f.placeholder || f.ariaLabel || f.selector;
                    return `  - "${desc}" (${f.type || f.tagName}${f.role ? `, role=${f.role}` : ''})`;
                }).join('\n');
                return `Found ${discoveredFields.length} form fields on the page:\n${fieldList}\n\nNow call smart_form_fill with these EXACT parameters:\n  smart_form_fill url="${formUrl || session.page.url()}" data='{"FIELD_LABEL": "value", ...}' submit=false\n\nUse the exact field labels listed above as keys in the data JSON.`;
            }

            if (cmd === 'read_form') {
                // Navigate to URL if provided
                const formUrl = (args.url as string) || '';
                if (formUrl && session.page.url() !== formUrl) {
                    await session.page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                    await session.page.waitForTimeout(2000);
                }
                return executeAction(session, 'read_form');
            }
            if (cmd === 'fill_form') {
                const formUrl = (args.url as string) || '';
                const formDataStr = (args.form_data as string) || '';

                // Try to get JSON from: 1) form_data param, 2) inline in action string
                let fields: Record<string, string> | null = null;
                if (formDataStr) {
                    try { fields = JSON.parse(formDataStr); } catch { /* ignore */ }
                }
                if (!fields) {
                    // Try parsing from the action string itself
                    const jsonMatch = action.match(/\{[\s\S]+\}/);
                    if (jsonMatch) {
                        try { fields = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
                    }
                }
                if (!fields) {
                    return 'Error: fill_form requires form data. Pass as: action="fill_form URL {json}" or provide form_data parameter with JSON string.';
                }

                // Get URL from args or action string
                let url = formUrl;
                if (!url) {
                    const urlMatch = action.match(/https?:\/\/\S+/);
                    if (urlMatch) url = urlMatch[0];
                }

                return fillFormSmart(session, url, fields);
            }

            // If this is the first action and it's not "open", return helpful error
            if (session.page.url() === 'about:blank' && !action.trim().toLowerCase().startsWith('open')) {
                return 'No page loaded. Start with: open <url>';
            }

            return executeAction(session, action);
        },
    });

    // smart_form_fill — single-call form filling tool for local LLMs
    registerSkill({
        name: 'smart_form_fill',
        description: 'Fill a web form end-to-end in ONE call. Reads form fields, matches your data, fills inputs, verifies results, detects CAPTCHA.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'smart_form_fill',
        description: `Fill a web form completely in ONE call — reads fields, matches data, fills inputs, verifies, and reports.\n\nUSE THIS WHEN Tony says: "fill out the form at X" / "apply to X" / "submit my info to X" / "fill in my details on X"\n\nWORKFLOW: ONE call does everything — read → match → fill → verify → report\nDo NOT use web_act for form filling unless smart_form_fill fails.\n\nFull description:\nReads form fields automatically, matches your data to the correct inputs, fills them, verifies the values were set, and reports results. Handles CAPTCHA detection gracefully.

HOW TO USE:
  smart_form_fill url="https://jobs.example.com/apply" data='{"Full Name": "Tony Elliott", "Email": "tony@example.com", "Location": "Los Angeles, CA", "Visa Sponsorship": "No"}' submit=true

PARAMETERS:
  url    — The URL of the page with the form (required)
  data   — JSON string mapping field LABELS to values (required). Use the labels visible on the form.
  submit — Set to "true" to auto-click the submit button after filling (optional, default false)

RETURNS:
  ✅ Successfully filled fields with values
  ❌ Failed fields with available labels for retry
  ⚠️ CAPTCHA warnings (user must complete manually)
  Field count summary

TIPS:
  - Field names are fuzzy-matched so exact labels are not required but help
  - For radio buttons or yes/no fields, use the option text as the value: {"Visa required": "No"}
  - If fields fail, retry with ONLY the failed fields using the exact labels from the error message
  - CAPTCHA forms will be filled but NOT submitted — user completes CAPTCHA manually`,
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL of the form page to fill' },
                data: { type: 'string', description: 'JSON string mapping field labels to values. Example: {"Full Name": "Tony", "Email": "tony@example.com"}' },
                submit: { type: 'string', description: 'Set to "true" to auto-click submit after filling. Default: false. Skipped if CAPTCHA detected.' },
            },
            required: ['url', 'data'],
        },
        execute: async (args) => {
            const url = args.url as string;
            // Accept multiple parameter names — local models frequently hallucinate the param name
            const dataStr = (args.data || args.form_data || args.form_data_string || args.formData || args.fields) as string;
            const submitStr = (args.submit as string) || 'false';
            const submit = submitStr === 'true' || submitStr === '1';

            if (!url) return 'Error: url parameter is required.';
            if (!dataStr) return 'Error: data parameter is required. Pass a JSON string mapping field labels to values.';

            let fields: Record<string, string>;
            try {
                fields = JSON.parse(dataStr);
            } catch {
                return `Error: Could not parse data as JSON. Got: ${dataStr.slice(0, 200)}`;
            }

            if (Object.keys(fields).length === 0) {
                return 'Error: data object is empty. Provide at least one field label → value mapping.';
            }

            logger.info(COMPONENT, `smart_form_fill: ${url} with ${Object.keys(fields).length} fields, submit=${submit}`);

            const session = await getOrCreateSession('__default__');

            // Navigate to form page
            if (session.page.url() !== url) {
                try {
                    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                    await session.page.waitForTimeout(2000);
                } catch (err) {
                    return `Error: Could not navigate to ${url}: ${err instanceof Error ? err.message : String(err)}`;
                }
            }

            // Delegate to upgraded fillFormSmart
            return fillFormSmart(session, url, fields, submit);
        },
    });

    logger.info(COMPONENT, 'Registered web_read + web_act + smart_form_fill (LLM-friendly browsing)');
}
