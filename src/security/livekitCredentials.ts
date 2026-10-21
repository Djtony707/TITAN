/** Validate only the LiveKit boundary; an invalid pair must not discard unrelated user configuration. */
export function hasPrivateLiveKitCredentials(voice: { livekitApiKey?: unknown; livekitApiSecret?: unknown }): boolean {
    return typeof voice.livekitApiKey === 'string'
        && typeof voice.livekitApiSecret === 'string'
        && voice.livekitApiKey !== 'devkey'
        && voice.livekitApiSecret !== 'secret'
        && /^[A-Za-z0-9_-]{8,128}$/.test(voice.livekitApiKey)
        && /^[A-Za-z0-9_-]{32,256}$/.test(voice.livekitApiSecret);
}
