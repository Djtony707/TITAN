/**
 * TITAN — Google OAuth Token Manager
 * Handles OAuth2 consent flow, token exchange, refresh, and storage.
 * Uses native fetch — zero npm dependencies.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TITAN_CREDENTIALS_DIR } from '../utils/constants.js';
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';

const COMPONENT = 'GoogleAuth';
const TOKEN_FILE = join(TITAN_CREDENTIALS_DIR, 'google.json');
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // epoch ms
    email?: string;
}

/** Build Google OAuth consent URL */
export function getConsentUrl(redirectUri: string): string {
    const config = loadConfig();
    const { clientId } = config.oauth.google;
    if (!clientId) throw new Error('Google OAuth client ID not configured');

    const scopes = config.oauth.google.scopes.join(' ');
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes,
        access_type: 'offline',
        prompt: 'consent',
    });

    return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

/** Exchange authorization code for tokens */
export async function exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens> {
    const config = loadConfig();
    const { clientId, clientSecret } = config.oauth.google;
    if (!clientId || !clientSecret) throw new Error('Google OAuth client ID/secret not configured');

    const response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
    };

    const tokens: GoogleTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000),
    };

    // Fetch the user's email
    try {
        const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (profileRes.ok) {
            const profile = await profileRes.json() as { emailAddress: string };
            tokens.email = profile.emailAddress;
        }
    } catch { /* non-critical */ }

    saveTokens(tokens);
    logger.info(COMPONENT, `Google OAuth connected${tokens.email ? ` (${tokens.email})` : ''}`);
    return tokens;
}

/** Get a valid access token, refreshing if expired */
export async function getAccessToken(): Promise<string | null> {
    const tokens = loadTokens();
    if (!tokens) return null;

    // Refresh if within 5 minute buffer of expiry
    if (Date.now() >= tokens.expires_at - 300_000) {
        try {
            const refreshed = await refreshAccessToken(tokens);
            return refreshed.access_token;
        } catch (err) {
            logger.error(COMPONENT, `Token refresh failed: ${(err as Error).message}`);
            return null;
        }
    }

    return tokens.access_token;
}

/** Refresh the access token */
async function refreshAccessToken(tokens: GoogleTokens): Promise<GoogleTokens> {
    const config = loadConfig();
    const { clientId, clientSecret } = config.oauth.google;
    if (!clientId || !clientSecret) throw new Error('Google OAuth not configured');

    const response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: tokens.refresh_token,
            grant_type: 'refresh_token',
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
        access_token: string;
        expires_in: number;
    };

    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + (data.expires_in * 1000);
    saveTokens(tokens);
    logger.debug(COMPONENT, 'Access token refreshed');
    return tokens;
}

/** Check if Google is connected */
export function isGoogleConnected(): boolean {
    return existsSync(TOKEN_FILE);
}

/** Get the connected Google email */
export function getGoogleEmail(): string | null {
    const tokens = loadTokens();
    return tokens?.email || null;
}

/** Disconnect Google (delete tokens) */
export function disconnectGoogle(): void {
    if (existsSync(TOKEN_FILE)) {
        unlinkSync(TOKEN_FILE);
        logger.info(COMPONENT, 'Google account disconnected');
    }
}

/** Make an authenticated Gmail API request */
export async function gmailFetch(path: string, options?: RequestInit): Promise<Response> {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected. Connect your Google account in Settings.');

    const url = `https://gmail.googleapis.com${path}`;
    const headers = {
        Authorization: `Bearer ${token}`,
        ...(options?.headers || {}),
    };

    return fetch(url, { ...options, headers });
}

/** Make an authenticated request to any Google API base URL */
export async function googleFetch(baseUrl: string, path: string, options?: RequestInit): Promise<Response> {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected. Connect your Google account in Settings.');

    const url = `${baseUrl}${path}`;
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options?.headers || {}),
    };

    return fetch(url, { ...options, headers });
}

// ── Token storage ─────────────────────────────────────────────────

function loadTokens(): GoogleTokens | null {
    try {
        if (!existsSync(TOKEN_FILE)) return null;
        return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) as GoogleTokens;
    } catch {
        return null;
    }
}

function saveTokens(tokens: GoogleTokens): void {
    mkdirSync(TITAN_CREDENTIALS_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
