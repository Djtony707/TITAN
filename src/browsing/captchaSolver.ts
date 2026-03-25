/**
 * TITAN — CAPTCHA Solver (CapSolver API)
 * Solves reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile via CapSolver's REST API.
 * No browser extension needed — works in headless mode.
 */
import type { Page } from 'playwright';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CaptchaSolver';
const CAPSOLVER_API = 'https://api.capsolver.com';

export interface CaptchaInfo {
    type: 'recaptcha_v2' | 'recaptcha_v3' | 'turnstile' | 'hcaptcha';
    sitekey: string;
    pageUrl: string;
    action?: string;        // reCAPTCHA v3 action name
    isEnterprise?: boolean;
}

// ── Detection ────────────────────────────────────────────────

/**
 * Detect CAPTCHA type and sitekey from page DOM.
 * Inspects iframes, divs, and global config objects.
 */
export async function detectCaptchaInfo(page: Page): Promise<CaptchaInfo | null> {
    const pageUrl = page.url();

    const info = await page.evaluate(() => {
        // 1. reCAPTCHA — check div.g-recaptcha, iframe src, or global config
        const recaptchaDiv = document.querySelector('div.g-recaptcha[data-sitekey]');
        if (recaptchaDiv) {
            const sitekey = recaptchaDiv.getAttribute('data-sitekey') || '';
            const size = recaptchaDiv.getAttribute('data-size');
            return {
                type: size === 'invisible' ? 'recaptcha_v3' as const : 'recaptcha_v2' as const,
                sitekey,
                action: recaptchaDiv.getAttribute('data-action') || undefined,
            };
        }

        // Check reCAPTCHA iframe for sitekey
        const recaptchaIframe = document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null;
        if (recaptchaIframe) {
            try {
                const src = new URL(recaptchaIframe.src);
                const sitekey = src.searchParams.get('k') || '';
                const isV3 = recaptchaIframe.src.includes('size=invisible') ||
                             recaptchaIframe.style.display === 'none' ||
                             recaptchaIframe.width === '0';
                return {
                    type: isV3 ? 'recaptcha_v3' as const : 'recaptcha_v2' as const,
                    sitekey,
                };
            } catch { /* ignore parse errors */ }
        }

        // Check reCAPTCHA script tag for render= param (v3 invisible sites like AshbyHQ)
        const recaptchaScript = document.querySelector('script[src*="recaptcha"][src*="render="]') as HTMLScriptElement | null;
        if (recaptchaScript) {
            try {
                const src = new URL(recaptchaScript.src);
                const renderKey = src.searchParams.get('render') || '';
                if (renderKey && renderKey !== 'explicit') {
                    return { type: 'recaptcha_v3' as const, sitekey: renderKey };
                }
            } catch { /* ignore */ }
        }

        // Check global grecaptcha config (v3 sites often use this)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gCfg = (window as any).___grecaptcha_cfg;
        if (gCfg?.clients) {
            for (const clientId of Object.keys(gCfg.clients)) {
                const client = gCfg.clients[clientId];
                // Walk the client object to find sitekey
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const findKey = (obj: any, depth = 0): string | null => {
                    if (!obj || depth > 5) return null;
                    if (typeof obj === 'string' && obj.length > 20 && obj.length < 60) return obj;
                    if (typeof obj === 'object') {
                        for (const k of Object.keys(obj)) {
                            if (k === 'sitekey' || k === 'key') return obj[k];
                            const found = findKey(obj[k], depth + 1);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                const sitekey = findKey(client);
                if (sitekey) {
                    return { type: 'recaptcha_v3' as const, sitekey };
                }
            }
        }

        // 2. hCaptcha
        const hcaptchaDiv = document.querySelector('div.h-captcha[data-sitekey]');
        if (hcaptchaDiv) {
            return {
                type: 'hcaptcha' as const,
                sitekey: hcaptchaDiv.getAttribute('data-sitekey') || '',
            };
        }

        // 3. Cloudflare Turnstile
        const turnstileDiv = document.querySelector('div.cf-turnstile[data-sitekey]');
        if (turnstileDiv) {
            return {
                type: 'turnstile' as const,
                sitekey: turnstileDiv.getAttribute('data-sitekey') || '',
            };
        }

        return null;
    });

    if (!info || !info.sitekey) return null;

    return { ...info, pageUrl } as CaptchaInfo;
}

// ── CapSolver API ────────────────────────────────────────────

const TASK_TYPE_MAP: Record<CaptchaInfo['type'], string> = {
    recaptcha_v2: 'ReCaptchaV2TaskProxyLess',
    recaptcha_v3: 'ReCaptchaV3TaskProxyLess',
    hcaptcha: 'HCaptchaTaskProxyLess',
    turnstile: 'AntiTurnstileTaskProxyLess',
};

async function createTask(apiKey: string, info: CaptchaInfo, minScore: number): Promise<string> {
    const taskType = TASK_TYPE_MAP[info.type];
    const task: Record<string, unknown> = {
        type: taskType,
        websiteURL: info.pageUrl,
        websiteKey: info.sitekey,
    };

    if (info.type === 'recaptcha_v3') {
        task.pageAction = info.action || 'submit';
        task.minScore = minScore;
    }

    if (info.isEnterprise && (info.type === 'recaptcha_v2' || info.type === 'recaptcha_v3')) {
        task.type = task.type === 'ReCaptchaV2TaskProxyLess'
            ? 'ReCaptchaV2EnterpriseTaskProxyLess'
            : 'ReCaptchaV3EnterpriseTaskProxyLess';
        task.isEnterprise = true;
    }

    logger.info(COMPONENT, `Creating task: ${task.type} for ${info.pageUrl}`);

    const resp = await fetch(`${CAPSOLVER_API}/createTask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, task }),
    });

    const body = await resp.json() as { errorId?: number; errorDescription?: string; taskId?: string };
    if (body.errorId && body.errorId !== 0) {
        throw new Error(`CapSolver createTask error: ${body.errorDescription || 'unknown'}`);
    }
    if (!body.taskId) {
        throw new Error('CapSolver createTask returned no taskId');
    }

    logger.info(COMPONENT, `Task created: ${body.taskId}`);
    return body.taskId;
}

async function getTaskResult(apiKey: string, taskId: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 3000;

    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        const resp = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: apiKey, taskId }),
        });

        const body = await resp.json() as {
            errorId?: number;
            errorDescription?: string;
            status?: string;
            solution?: { gRecaptchaResponse?: string; token?: string };
        };

        if (body.errorId && body.errorId !== 0) {
            throw new Error(`CapSolver getTaskResult error: ${body.errorDescription || 'unknown'}`);
        }

        if (body.status === 'ready') {
            const token = body.solution?.gRecaptchaResponse || body.solution?.token;
            if (!token) throw new Error('CapSolver solved but returned no token');
            logger.info(COMPONENT, `Task ${taskId} solved (token length: ${token.length})`);
            return token;
        }

        // status === 'processing' — keep polling
        logger.debug(COMPONENT, `Task ${taskId} still processing...`);
    }

    throw new Error(`CapSolver timeout after ${timeoutMs}ms`);
}

// ── Token Injection ──────────────────────────────────────────

export async function injectCaptchaToken(page: Page, info: CaptchaInfo, token: string): Promise<void> {
    await page.evaluate(({ type, token: t }) => {
        if (type === 'recaptcha_v2' || type === 'recaptcha_v3') {
            // Set the response textarea(s)
            const textareas = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
            textareas.forEach(ta => { (ta as HTMLTextAreaElement).value = t; });

            // Also check for hidden textarea by id
            const byId = document.getElementById('g-recaptcha-response');
            if (byId) (byId as HTMLTextAreaElement).value = t;

            // Try to invoke the reCAPTCHA callback
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const gCfg = (window as any).___grecaptcha_cfg;
            if (gCfg?.clients) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const findCallback = (obj: any, depth = 0): ((token: string) => void) | null => {
                    if (!obj || depth > 8) return null;
                    if (typeof obj === 'function') return null;
                    if (typeof obj === 'object') {
                        for (const k of Object.keys(obj)) {
                            if (k === 'callback' && typeof obj[k] === 'function') return obj[k];
                            const found = findCallback(obj[k], depth + 1);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                for (const clientId of Object.keys(gCfg.clients)) {
                    const cb = findCallback(gCfg.clients[clientId]);
                    if (cb) {
                        try { cb(t); } catch { /* callback error is non-fatal */ }
                        break;
                    }
                }
            }
        } else if (type === 'hcaptcha') {
            const textareas = document.querySelectorAll('textarea[name="h-captcha-response"]');
            textareas.forEach(ta => { (ta as HTMLTextAreaElement).value = t; });
        } else if (type === 'turnstile') {
            const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
            if (input) input.value = t;

            // Try Turnstile callback
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const turnstile = (window as any).turnstile;
            if (turnstile?._callbacks) {
                for (const cb of Object.values(turnstile._callbacks)) {
                    if (typeof cb === 'function') {
                        try { (cb as (t: string) => void)(t); } catch { /* non-fatal */ }
                        break;
                    }
                }
            }
        }
    }, { type: info.type, token });

    logger.info(COMPONENT, `Token injected for ${info.type}`);
}

// ── Main Solver ──────────────────────────────────────────────

export async function solveCaptcha(page: Page): Promise<{ solved: boolean; type: string; error?: string }> {
    const config = loadConfig();
    const capCfg = config.capsolver;

    if (!capCfg?.enabled || !capCfg?.apiKey) {
        return { solved: false, type: 'unknown', error: 'CapSolver not configured (set capsolver.enabled=true and capsolver.apiKey in config)' };
    }

    const info = await detectCaptchaInfo(page);
    if (!info) {
        return { solved: false, type: 'none', error: 'No CAPTCHA detected on page' };
    }

    logger.info(COMPONENT, `Solving ${info.type} (sitekey: ${info.sitekey.slice(0, 8)}...) on ${info.pageUrl}`);

    try {
        const taskId = await createTask(capCfg.apiKey, info, capCfg.minScore);
        const token = await getTaskResult(capCfg.apiKey, taskId, capCfg.timeoutMs);
        await injectCaptchaToken(page, info, token);
        logger.info(COMPONENT, `✅ ${info.type} solved successfully`);
        return { solved: true, type: info.type };
    } catch (e) {
        const msg = (e as Error).message;
        logger.error(COMPONENT, `Failed to solve ${info.type}: ${msg}`);
        return { solved: false, type: info.type, error: msg };
    }
}
