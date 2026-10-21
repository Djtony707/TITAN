/** Separate credentials for the optional Python voice service, bound to one explicit origin. */
function requestUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('Invalid optional voice service URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Invalid optional voice service URL.');
    }
    return url;
}

function secureCredentialOrigin(value: string, url: URL): void {
    if (url.protocol === 'https:') return;
    const authority = value.match(/^http:\/\/([^/?#]+)/i)?.[1];
    if (!authority || !/^(127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(authority)) {
        throw new Error('Optional voice service credentials require HTTPS or literal loopback.');
    }
}

export async function voiceServiceFetch(value: string, options?: RequestInit): Promise<Response> {
    const target = requestUrl(value);
    const configured = process.env.TITAN_VOICE_SERVER_URL || '';
    const token = process.env.TITAN_VOICE_AUTH_TOKEN || '';
    if (!configured) {
        if (token) throw new Error('Configure an explicit optional voice service URL before using its token.');
        return fetch(value, options);
    }
    const service = requestUrl(configured);
    if (service.pathname !== '/' || service.search || service.hash) {
        throw new Error('Configure the optional voice service origin without a path or query.');
    }
    secureCredentialOrigin(configured, service);
    // Unrelated F5/other TTS endpoints retain their existing request headers.
    if (target.origin !== service.origin) return fetch(value, options);
    secureCredentialOrigin(value, target);
    if (target.search || target.hash || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
        throw new Error('Invalid optional voice service authentication configuration.');
    }
    const headers = new Headers(options?.headers);
    if (headers.has('authorization')) throw new Error('Ambiguous optional voice service credentials.');
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(value, { ...options, headers, redirect: 'error' });
}
