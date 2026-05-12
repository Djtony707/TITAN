/**
 * TITAN — Web Fetch Skill (Built-in)
 * Fetch any URL and extract content as markdown or text.
 * Matches OpenClaw's web_fetch tool.
 */
import { registerSkill } from '../registry.js';
import { TITAN_VERSION } from '../../utils/constants.js';

/** Convert HTML to clean readable text */
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<li>/gi, '• ')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Convert HTML to simple markdown */
function htmlToMarkdown(html: string): string {
    let md = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');

    // Headers
    md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n');
    md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n');
    md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n');
    md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n');
    // Links
    md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
    // Bold/italic
    md = md.replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**');
    md = md.replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*');
    // Code
    md = md.replace(/<code>(.*?)<\/code>/gi, '`$1`');
    md = md.replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n');
    // Lists
    md = md.replace(/<li>/gi, '- ');
    md = md.replace(/<\/li>/gi, '\n');
    // Images
    md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi, '![$1]($2)');
    md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)');
    // Remaining tags
    md = md.replace(/<br\s*\/?>/gi, '\n');
    md = md.replace(/<\/p>/gi, '\n\n');
    md = md.replace(/<[^>]*>/g, '');
    // Entities
    md = md.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    md = md.replace(/\n{3,}/g, '\n\n');
    return md.trim();
}

/** Block requests to loopback, private, and link-local addresses (SSRF protection) */
function isInternalUrl(urlStr: string): boolean {
    let hostname: string;
    try {
        hostname = new URL(urlStr).hostname;
    } catch {
        return true; // Treat unparseable URLs as internal/blocked
    }

    // Block localhost by name
    if (hostname === 'localhost' || hostname === 'localhost.') return true;

    // Resolve numeric IPv4
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [, a, b] = ipv4.map(Number);
        if (a === 127) return true;                              // 127.0.0.0/8  loopback
        if (a === 10) return true;                               // 10.0.0.0/8   private
        if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12 private
        if (a === 192 && b === 168) return true;                 // 192.168.0.0/16 private
        if (a === 169 && b === 254) return true;                 // 169.254.0.0/16 link-local
    }

    // Block IPv6 loopback (::1) and link-local (fe80::/10)
    const h = hostname.replace(/^\[|\]$/g, '');
    if (h === '::1') return true;
    if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;

    return false;
}

export function registerWebFetchSkill(): void {
    registerSkill(
        { name: 'web_fetch', description: 'Fetch URL content', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'web_fetch',
            description: `Fetch a URL and return its full content as markdown (default) or plain text. HTTP-level fetch with redirects + content sniffing — does NOT run JavaScript, so SPAs return their initial HTML shell.

USE WHEN: the user gives you a URL directly ("read X" / "open X" / "summarize this article: X") OR after web_search to get full content of the top result. Also use to read raw API responses (set extractMode:"text" to skip markdown conversion).

DO NOT USE FOR:
- JS-heavy / SPA / interactive sites where the content is rendered client-side → use browse_url (Playwright; runs JS).
- Pages that need login or interaction → use web_act or browser_screenshot.
- Local files → use read_file (web_fetch only does HTTP/HTTPS).
- Search-then-fetch combined → just call web_search first; it returns URLs you then fetch.

Parameters:
- url (string, required) — full http(s) URL.
- extractMode (string, optional) — "markdown" (default) converts HTML to clean markdown; "text" returns stripped plain text; "html" returns the raw HTML (rare).
- maxLength (number, optional) — truncation cap in chars; default 50_000.

Returns: { url, finalUrl (after redirects), status, contentType, content, truncated, sizeBytes }.

Errors:
- "ECONNREFUSED" / "ENOTFOUND" — the host is down or DNS failed; verify URL spelling, don't retry blindly.
- "HTTP 4xx" — page returned an error; surface the status to the user.
- "HTTP 403 / blocked by anti-bot" — switch to browse_url which uses a real browser fingerprint.
- "Timed out" — page took too long; retry once with a smaller maxLength.

NEVER hallucinate page content. If web_fetch failed, say so.`,
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to fetch' },
                    extractMode: { type: 'string', enum: ['markdown', 'text'], description: 'Output format (default: markdown)' },
                    maxChars: { type: 'number', description: 'Max characters to return (default: 50000)' },
                },
                required: ['url'],
            },
            execute: async (args) => {
                const url = args.url as string;
                const mode = (args.extractMode as string) || 'markdown';
                const maxChars = Math.min((args.maxChars as number) || 50000, 100000);

                try {
                    if (isInternalUrl(url)) {
                        return `Error: Fetching internal/private network addresses is not permitted.`;
                    }
                    const response = await fetch(url, {
                        headers: { 'User-Agent': `Mozilla/5.0 (compatible; TITAN/${TITAN_VERSION})` },
                        signal: AbortSignal.timeout(20000),
                    });
                    const reader = response.body?.getReader();
                    if (!reader) return `Error: No response body from ${url}`;
                    const chunks: Uint8Array[] = [];
                    let totalBytes = 0;
                    const maxBytes = 200000;
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        totalBytes += value.length;
                        if (totalBytes >= maxBytes) break;
                    }
                    reader.cancel().catch(() => {});
                    const decoder = new TextDecoder();
                    const stdout = chunks.map(c => decoder.decode(c, { stream: true })).join('').slice(0, maxBytes);

                    if (!stdout.trim()) {
                        return `Empty response from ${url}`;
                    }

                    // Extract title
                    const title = stdout.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || 'Untitled';

                    // Convert
                    const content = mode === 'markdown' ? htmlToMarkdown(stdout) : htmlToText(stdout);

                    return `# ${title}\n\nSource: ${url}\n\n${content.slice(0, maxChars)}`;
                } catch (e) {
                    return `Error fetching ${url}: ${(e as Error).message}`;
                }
            },
        },
    );
}
