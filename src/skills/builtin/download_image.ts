/**
 * TITAN — Download Image Skill (Built-in, v6.1.0-alpha.37)
 *
 * Fetches an image URL server-side and returns it as a base64
 * data URL the agent can embed directly in HTML as
 * `<img src="data:image/jpeg;base64,…">`.
 *
 * Why this skill exists:
 *
 * The HTML report viewer (alpha.16 → alpha.36) went through five
 * rounds of iframe sandbox / CORS / referrer / CSP / Shadow-DOM
 * tuning trying to make external `<img src="https://…">` tags load
 * reliably. They never did, consistently. Browsers, referer
 * policies, and image-host hotlinking rules kept stacking.
 *
 * Tony's call: "instead of linking, the AI Agent downloads the
 * images?" — exactly right. A base64 data URL is **portable**
 * (the HTML file is self-contained), **always loads** (no network
 * request, no CORS, no referer to police), and **survives sharing**
 * (downloading the HTML to your phone, emailing it, hosting it
 * elsewhere all keep the image intact).
 *
 * Trade: file size grows ~33% per image (base64 overhead). For an
 * essay with 3-5 images at typical web resolution, the file is
 * still well under 1 MB. We cap individual images at 4 MB of raw
 * bytes (≈5.3 MB base64) so a hostile or oversized image can't
 * blow out the HTML doc.
 *
 * Pattern mirrors web_fetch — same internal-URL protection, same
 * User-Agent, same timeout. Returns a string suitable for direct
 * use in an `<img src>` attribute.
 */
import { registerSkill } from '../registry.js';
import { TITAN_VERSION } from '../../utils/constants.js';
import { registerImage } from '../../agent/imageRegistry.js';

// Block private-network / loopback addresses. Mirrors web_fetch.ts.
function isInternalUrl(urlStr: string): boolean {
    try {
        const u = new URL(urlStr);
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
        if (host.endsWith('.local') || host.endsWith('.internal')) return true;
        if (/^10\./.test(host)) return true;
        if (/^192\.168\./.test(host)) return true;
        if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
        if (/^169\.254\./.test(host)) return true; // link-local
        return false;
    } catch {
        return false;
    }
}

function inferMimeFromUrl(url: string, contentType: string | null): string {
    if (contentType && contentType.startsWith('image/')) {
        // strip charset / parameters if any
        return contentType.split(';')[0].trim();
    }
    const lower = url.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.bmp')) return 'image/bmp';
    if (lower.endsWith('.avif')) return 'image/avif';
    return 'image/jpeg'; // safe default; most photo CDNs serve JPEG
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB raw

export function registerDownloadImageSkill(): void {
    registerSkill(
        { name: 'download_image', description: 'Download an image as a base64 data URL for HTML embedding', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'download_image',
            description: `Download an image from a URL server-side and return a SHORT reference token (tdi://...) suitable for embedding directly in HTML as <img src="tdi://...">.

USE WHEN: you are writing an HTML report and want to include images that will reliably display in the user's viewer, on any machine, even offline. The viewer's iframe sandbox + referer-policy + private-network mitigations can block hotlinked <img src="https://…"> URLs from many hosts (Wikimedia, Pinterest, Imgur, etc.). Downloading and embedding sidesteps all of that.

WORKFLOW:
1. Find the image URL (typically via web_search results that include image links, or known Wikimedia Commons URLs from your research).
2. Call download_image with the URL.
3. Use the returned dataUrl string (a short "tdi://abc123def456" token, ~30 chars) directly as the src attribute of an <img> tag in your HTML.
4. When write_file persists your HTML, the token is automatically substituted with the actual base64 data URL on disk. The final file is self-contained and portable.

Example:
  Call: download_image({ url: "https://upload.wikimedia.org/wikipedia/commons/0/05/Martin_Luther_King%2C_Jr..jpg" })
  Returns: { ok: true, dataUrl: "tdi://9f3a2c1b8e5d7f06", sizeBytes: 191378, mimeType: "image/jpeg" }
  Then in your HTML: <img src="tdi://9f3a2c1b8e5d7f06" alt="MLK portrait" style="max-width:380px;">

IMPORTANT: the token is intentionally short. Do NOT try to "expand" it, "decode" it, or pass it through other tools — just paste it AS-IS inside <img src="...">. The file-write tools handle the expansion automatically.

DO NOT USE FOR:
- Local files you already have on disk → use read_file or reference the path directly.
- Generating images from a text prompt → use generate_image.
- Inspecting an image's contents to describe it → use analyze_image.

Parameters:
- url (string, required) — full HTTPS URL of the image. HTTP works too but HTTPS is strongly preferred. Internal/private addresses are blocked.

Returns:
- { ok: true, dataUrl, mimeType, sizeBytes } on success
- { ok: false, error } on failure (HTTP error, too-large, internal URL, timeout, etc.)

Size limits: individual image capped at 4 MB raw (≈5.3 MB base64). Larger images fail with a clear error — pick a smaller source or scale the URL via a CDN parameter.

NEVER use a fabricated URL. Only embed images whose URL came from an actual web_search / web_fetch result. If you don't have a real source URL, OMIT the image rather than invent one.`,
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Full http(s) URL of the image to download.' },
                },
                required: ['url'],
            },
            execute: async (args) => {
                const url = String(args.url ?? '').trim();
                if (!url) return JSON.stringify({ ok: false, error: 'url is required' });
                if (isInternalUrl(url)) {
                    return JSON.stringify({ ok: false, error: 'Internal / private network URLs are not permitted.' });
                }
                let parsed: URL;
                try { parsed = new URL(url); }
                catch { return JSON.stringify({ ok: false, error: 'Invalid URL.' }); }
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    return JSON.stringify({ ok: false, error: 'Only http(s) URLs are supported.' });
                }
                try {
                    const response = await fetch(url, {
                        headers: {
                            'User-Agent': `Mozilla/5.0 (compatible; TITAN/${TITAN_VERSION}; +https://github.com/Djtony707/TITAN)`,
                            // Identify as an image-fetcher so CDNs that vary by Accept-header serve raw bytes.
                            'Accept': 'image/*, */*;q=0.8',
                        },
                        signal: AbortSignal.timeout(20000),
                        redirect: 'follow',
                    });
                    if (!response.ok) {
                        return JSON.stringify({
                            ok: false,
                            error: `HTTP ${response.status} ${response.statusText} fetching ${url}`,
                        });
                    }
                    const contentType = response.headers.get('content-type');
                    const mimeType = inferMimeFromUrl(url, contentType);
                    if (!mimeType.startsWith('image/')) {
                        return JSON.stringify({
                            ok: false,
                            error: `Response is not an image (content-type=${contentType ?? 'unknown'}).`,
                        });
                    }
                    // Stream-read with size cap so a 100MB "image" doesn't blow the process.
                    const reader = response.body?.getReader();
                    if (!reader) return JSON.stringify({ ok: false, error: 'No response body.' });
                    const chunks: Uint8Array[] = [];
                    let total = 0;
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        total += value.length;
                        if (total > MAX_IMAGE_BYTES) {
                            await reader.cancel().catch(() => { /* ignore */ });
                            return JSON.stringify({
                                ok: false,
                                error: `Image exceeded ${MAX_IMAGE_BYTES / 1024 / 1024}MB cap (got at least ${(total / 1024 / 1024).toFixed(1)}MB). Pick a smaller image source or use a CDN URL with size parameters.`,
                            });
                        }
                    }
                    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
                    const base64 = buf.toString('base64');
                    const realDataUrl = `data:${mimeType};base64,${base64}`;
                    // v6.1.0-alpha.56 — register the real data URL in
                    // the side-channel and return a short opaque token
                    // (`tdi://abc123def456`) as the `dataUrl` field.
                    // The LLM treats it like a normal URL and embeds
                    // it as `<img src="tdi://...">`. write_file resolves
                    // the token to the full data URL right before
                    // writing to disk, so the file on disk is portable
                    // self-contained HTML with the image embedded.
                    //
                    // This fixes the long-standing "Writer hotlinks
                    // external URL instead of embedding" problem,
                    // whose root cause was never the tool itself — it
                    // was that asking an LLM to copy 270 KB of base64
                    // verbatim through its context window is fragile
                    // even when nothing in the harness strips it.
                    const ref = registerImage(realDataUrl, mimeType, buf.length);
                    return JSON.stringify({
                        ok: true,
                        dataUrl: ref,
                        mimeType,
                        sizeBytes: buf.length,
                        note: 'dataUrl is a short reference token; embed it directly as <img src="..."> and the file-write tools will substitute the real image bytes before saving.',
                    });
                } catch (err) {
                    const e = err as Error;
                    const msg = e.name === 'AbortError' ? 'Timed out after 20s' : e.message;
                    return JSON.stringify({ ok: false, error: msg });
                }
            },
        },
    );
}
