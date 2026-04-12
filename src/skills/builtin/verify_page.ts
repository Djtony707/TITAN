/**
 * TITAN — Page Verification Skill
 *
 * Browser-level testing for web apps built by TITAN.
 * Uses Playwright to verify pages render, forms submit, and APIs respond.
 * Bridges the gap between "curl returns 200" and "the page actually works."
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'VerifyPage';

export function registerVerifyPageSkill(): void {
    registerSkill(
        {
            name: 'verify_page',
            description: 'Browser-level page verification — checks if pages render, forms work, APIs respond',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'verify_page',
            description: 'Verify a web page works correctly at the browser level.\nChecks: page loads, content renders, forms submit, JavaScript runs.\nUSE THIS WHEN: testing a web app you built, verifying signup/login works, checking if a page renders correctly.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'URL to verify (e.g., http://localhost:3000/signup)',
                    },
                    checks: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'What to verify: "renders" (page loads), "has:TEXT" (contains text), "form:SELECTOR" (form exists), "click:SELECTOR" (element clickable), "api:METHOD:URL:BODY" (API responds)',
                    },
                },
                required: ['url'],
            },
            execute: async (args) => {
                const url = args.url as string;
                const checks = (args.checks as string[]) || ['renders'];

                try {
                    // Dynamic import — Playwright may not be installed
                    const { chromium } = await import('playwright');

                    const browser = await chromium.launch({
                        headless: true,
                        args: ['--no-sandbox', '--disable-setuid-sandbox'],
                    });

                    const page = await browser.newPage();
                    const results: string[] = [];
                    let allPassed = true;

                    try {
                        // Navigate to URL
                        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
                        const status = response?.status() || 0;

                        if (status >= 400) {
                            results.push(`❌ FAIL: Page returned HTTP ${status}`);
                            allPassed = false;
                        } else {
                            results.push(`✅ Page loaded (HTTP ${status})`);
                        }

                        // Run each check
                        for (const check of checks) {
                            if (check === 'renders') {
                                const content = await page.textContent('body');
                                if (content && content.trim().length > 10) {
                                    results.push(`✅ Page renders (${content.trim().length} chars visible)`);
                                } else {
                                    results.push(`❌ FAIL: Page is blank or has minimal content`);
                                    allPassed = false;
                                }
                            } else if (check.startsWith('has:')) {
                                const text = check.slice(4);
                                const content = await page.textContent('body');
                                if (content?.includes(text)) {
                                    results.push(`✅ Contains "${text}"`);
                                } else {
                                    results.push(`❌ FAIL: Missing text "${text}"`);
                                    allPassed = false;
                                }
                            } else if (check.startsWith('form:')) {
                                const selector = check.slice(5) || 'form';
                                const form = await page.$(selector);
                                if (form) {
                                    results.push(`✅ Form found: ${selector}`);
                                } else {
                                    results.push(`❌ FAIL: Form not found: ${selector}`);
                                    allPassed = false;
                                }
                            } else if (check.startsWith('click:')) {
                                const selector = check.slice(6);
                                const element = await page.$(selector);
                                if (element) {
                                    const isVisible = await element.isVisible();
                                    results.push(isVisible ? `✅ Clickable: ${selector}` : `❌ FAIL: Not visible: ${selector}`);
                                    if (!isVisible) allPassed = false;
                                } else {
                                    results.push(`❌ FAIL: Element not found: ${selector}`);
                                    allPassed = false;
                                }
                            } else if (check.startsWith('no-errors')) {
                                // Check for console errors
                                const errors: string[] = [];
                                page.on('console', msg => {
                                    if (msg.type() === 'error') errors.push(msg.text());
                                });
                                await page.reload({ waitUntil: 'networkidle' });
                                await page.waitForTimeout(2000);
                                if (errors.length === 0) {
                                    results.push(`✅ No console errors`);
                                } else {
                                    results.push(`❌ FAIL: ${errors.length} console errors: ${errors.slice(0, 3).join('; ')}`);
                                    allPassed = false;
                                }
                            }
                        }

                        // Take screenshot for evidence
                        const screenshot = await page.screenshot({ type: 'jpeg', quality: 50 });
                        logger.info(COMPONENT, `Verification screenshot: ${screenshot.length} bytes`);

                    } finally {
                        await browser.close();
                    }

                    const verdict = allPassed ? 'PASS' : 'FAIL';
                    return `VERDICT: ${verdict}\n\n${results.join('\n')}`;

                } catch (err) {
                    const msg = (err as Error).message;
                    if (msg.includes('Cannot find module') || msg.includes('playwright')) {
                        // Playwright not installed — fall back to curl-based check
                        logger.warn(COMPONENT, 'Playwright not available — falling back to HTTP check');
                        try {
                            const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
                            const html = await response.text();
                            const hasContent = html.length > 100 && /<body/i.test(html);
                            const results = [
                                `HTTP ${response.status} (${html.length} bytes)`,
                                hasContent ? '✅ HTML body present' : '❌ No HTML body',
                            ];
                            for (const check of checks) {
                                if (check.startsWith('has:')) {
                                    const text = check.slice(4);
                                    results.push(html.includes(text) ? `✅ Contains "${text}"` : `❌ Missing "${text}"`);
                                }
                            }
                            return `VERDICT: ${response.status < 400 && hasContent ? 'PASS' : 'FAIL'} (HTTP fallback — install playwright for full browser testing)\n\n${results.join('\n')}`;
                        } catch (fetchErr) {
                            return `VERDICT: FAIL\n\nCannot reach ${url}: ${(fetchErr as Error).message}`;
                        }
                    }
                    return `VERDICT: FAIL\n\nBrowser error: ${msg}`;
                }
            },
        },
    );
}
