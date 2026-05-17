import type { SelfKnowledge } from '../../agent/selfKnowledge.js';

export interface TruthVerificationResult {
    ok: boolean;
    violations: string[];
}

const NUMBER_PATTERN = /\b\d+(?:[.,]\d+)?\+?\b/g;
const ACTIVITY_CLAIM_PATTERN = /\b(just |i )(rewrote|built|deployed|spawned|created|killed|launched|shipped|integrated|added|removed|fixed|debugged|wrote|ran|trained|merged)\s+([a-z0-9]+ [a-z0-9_-]+|my [a-z0-9]+|the [a-z0-9]+|[a-z0-9][a-z0-9_-]*)/gi;
const INTEGRATION_PATTERN = /\b(smart fridge|thermostat|gmail|slack|discord|telegram|notion|stripe|fly\.io|kubernetes|docker)\b/gi;
const ABSOLUTE_PATTERN = /\b(spotless|immaculate|flawless|zero errors|perfect uptime|no bugs)\b/gi;

export function verifyPostTruthfulness(post: string, snapshot: SelfKnowledge): TruthVerificationResult {
    const violations: string[] = [];
    const snapshotText = JSON.stringify(snapshot).toLowerCase();
    const snapshotNumbers = extractNumberTokens(`${snapshotText}\nv${snapshot.version}`);
    const sourceText = [
        ...snapshot.recentCommitMessages,
        ...snapshot.recentReleaseNotes,
    ].join('\n').toLowerCase();

    for (const match of post.matchAll(NUMBER_PATTERN)) {
        const value = match[0];
        if (!numberIsGroundedOrIdiomatic(post, match.index ?? 0, value, snapshotNumbers)) {
            violations.push(`unverified number: "${value}"`);
        }
    }

    for (const match of post.matchAll(ACTIVITY_CLAIM_PATTERN)) {
        const full = match[0].trim();
        const verb = (match[2] || '').toLowerCase();
        const object = (match[3] || '').toLowerCase();
        const normalizedObject = object.replace(/^(my|the)\s+/, '').trim();
        const keyNoun = normalizedObject.split(/\s+/).filter(Boolean).at(-1) || '';
        const verbObject = `${verb} ${normalizedObject}`.trim();
        if (!object ||
            (!sourceText.includes(object) &&
                !sourceText.includes(normalizedObject) &&
                !sourceText.includes(verbObject) &&
                (keyNoun.length === 0 || !sourceText.includes(keyNoun)))) {
            violations.push(`unverified activity claim: "${full}"`);
        }
    }

    for (const match of post.matchAll(INTEGRATION_PATTERN)) {
        const name = match[1].toLowerCase();
        if (!sourceText.includes(name)) {
            violations.push(`unverified integration claim: "${name}"`);
        }
    }

    if (snapshot.errorsLast24h > 0) {
        for (const match of post.matchAll(ABSOLUTE_PATTERN)) {
            const claim = match[0];
            violations.push(`contradicted absolute claim: "${claim}" (errors observed: ${snapshot.errorsLast24h})`);
        }
        if (violations.some(v => v.startsWith('contradicted absolute claim:'))) {
            violations.push('contradicted absolute claim');
        }
    }

    return { ok: violations.length === 0, violations };
}

function extractNumberTokens(text: string): Set<string> {
    return new Set([...text.matchAll(NUMBER_PATTERN)].map(match => normalizeNumberToken(match[0])));
}

function normalizeNumberToken(value: string): string {
    return value.toLowerCase().replace(/,/g, '');
}

function numberIsGroundedOrIdiomatic(
    post: string,
    index: number,
    value: string,
    snapshotNumbers: Set<string>,
): boolean {
    const lower = post.toLowerCase();
    const normalizedValue = normalizeNumberToken(value);
    if (snapshotNumbers.has(normalizedValue)) {
        return true;
    }

    const after = lower.slice(index + value.length, index + value.length + 24);
    const before = lower.slice(Math.max(0, index - 12), index);

    if (/^20[2-9]\d$/.test(value)) return true;
    if ((value === '24' && lower.slice(index, index + 4) === '24/7') ||
        (value === '7' && before.endsWith('24/'))) {
        return true;
    }
    if ((value === '1' && lower.slice(index, index + 3) === '1/2') ||
        (value === '2' && before.endsWith('1/')) ||
        (value === '3' && lower.slice(index, index + 3) === '3/4') ||
        (value === '4' && before.endsWith('3/'))) {
        return true;
    }
    if (/^(?:[1-9]|[1-9]\d)$/.test(value.replace(/\+$/, '')) &&
        (/^\s*(years?|days?|hours?)\b/.test(after) ||
            /^\s*(years?\s+old|yo\b)/.test(after) ||
            /\b(age|for)\s*$/.test(before))) {
        return true;
    }

    return false;
}
