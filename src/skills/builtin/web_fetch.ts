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
            description: 'Fetch a URL and return its full content as markdown or plain text.\n\nUSE THIS WHEN:\n- Tony gives you a URL directly: "go to X" / "open X" / "read X" / "check out X"\n- After web_search, to get full page content from the top result URLs\n- Tony says "summarize this article" and provides a link\n\nRULES:\n- Always call this after web_search — never rely on search snippets alone\n- For JS-heavy or interactive sites (SPAs, apps), prefer browse_url or web_act instead\n- Returns clean markdown by default; use extractMode:"text" for plain text',
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
