/**
 * TITAN — Hunter.io Skill (Built-in)
 * Email finder, domain search, and email verification via Hunter.io API.
 * Requires HUNTER_API_KEY environment variable.
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Hunter';
const BASE_URL = 'https://api.hunter.io/v2';

function getApiKey(): string {
    const key = process.env.HUNTER_API_KEY || process.env.HUNTER_IO_API_KEY;
    if (!key) throw new Error('HUNTER_API_KEY not set — add your Hunter.io API key to use this tool');
    return key;
}

async function hunterFetch(endpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${BASE_URL}/${endpoint}`);
    url.searchParams.set('api_key', getApiKey());
    for (const [k, v] of Object.entries(params)) {
        if (v) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
        headers: { 'User-Agent': 'TITAN-Agent/1.0' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Hunter.io API error (${res.status}): ${body}`);
    }
    return await res.json() as Record<string, unknown>;
}

interface HunterEmail {
    value: string;
    type: string | null;
    confidence: number;
    first_name: string | null;
    last_name: string | null;
    position: string | null;
    department: string | null;
    linkedin: string | null;
    sources: Array<{ domain: string; uri: string }>;
}

interface DomainSearchData {
    domain: string;
    organization: string;
    emails: HunterEmail[];
    pattern: string | null;
    webmail: boolean;
}

function formatEmail(e: HunterEmail): string {
    const name = [e.first_name, e.last_name].filter(Boolean).join(' ');
    const parts = [`${e.value} (${e.confidence}% confidence)`];
    if (name) parts.push(`Name: ${name}`);
    if (e.position) parts.push(`Role: ${e.position}`);
    if (e.department) parts.push(`Dept: ${e.department}`);
    if (e.type) parts.push(`Type: ${e.type}`);
    if (e.linkedin) parts.push(`LinkedIn: ${e.linkedin}`);
    return parts.join(' | ');
}

export function registerHunterSkill(): void {
    // ── Domain Search ──────────────────────────────────────────
    registerSkill(
        {
            name: 'hunter',
            description: 'Use this skill when Tony says "find emails for X company", "find the contact at Y", "who do I reach out to at [company]?", "find [person]\'s email", "verify this email", or "how many contacts does [company] have?". Uses Hunter.io API to find, verify, and count professional email addresses. Requires HUNTER_API_KEY.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'hunter_domain_search',
            description: 'Find all known email addresses at a company domain. Use when Tony says "find emails for [company.com]", "who works at [company]?", or "get me contacts at [company]". Returns names, roles, departments, confidence scores, and LinkedIn profiles.',
            parameters: {
                type: 'object',
                properties: {
                    domain: {
                        type: 'string',
                        description: 'Company domain to search (e.g. "stripe.com")',
                    },
                    department: {
                        type: 'string',
                        description: 'Filter by department: "executive", "it", "finance", "management", "sales", "legal", "support", "hr", "marketing", "communication", "education", "design", "health", "operations"',
                    },
                    type: {
                        type: 'string',
                        description: 'Email type filter: "personal" or "generic"',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max results (default 10, max 100)',
                    },
                },
                required: ['domain'],
            },
            execute: async (args) => {
                const domain = (args.domain as string).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
                const params: Record<string, string> = { domain };
                if (args.department) params.department = args.department as string;
                if (args.type) params.type = args.type as string;
                params.limit = String(Math.min(Number(args.limit) || 10, 100));

                logger.info(COMPONENT, `Domain search: ${domain}`);
                const result = await hunterFetch('domain-search', params);
                const data = result.data as DomainSearchData;

                if (!data?.emails?.length) {
                    return `No emails found for ${domain}.`;
                }

                const lines = [
                    `## ${data.organization || domain}`,
                    `Domain: ${data.domain}${data.pattern ? ` | Pattern: ${data.pattern}` : ''}`,
                    `Found ${data.emails.length} email(s):`,
                    '',
                ];
                for (const email of data.emails) {
                    lines.push(`- ${formatEmail(email)}`);
                }
                return lines.join('\n');
            },
        },
    );

    // ── Email Finder ───────────────────────────────────────────
    registerSkill(
        {
            name: 'hunter',
            description: 'Use this skill when Tony says "find emails for X company", "find the contact at Y", "who do I reach out to at [company]?", "find [person]\'s email", "verify this email", or "how many contacts does [company] have?". Uses Hunter.io API to find, verify, and count professional email addresses. Requires HUNTER_API_KEY.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'hunter_email_finder',
            description: 'Find the email address of a specific person at a company. Use when Tony says "find [person]\'s email", "what\'s the email for [name] at [company]?", or "I need to contact [person] at [domain]".',
            parameters: {
                type: 'object',
                properties: {
                    domain: {
                        type: 'string',
                        description: 'Company domain (e.g. "stripe.com")',
                    },
                    first_name: {
                        type: 'string',
                        description: 'Person\'s first name',
                    },
                    last_name: {
                        type: 'string',
                        description: 'Person\'s last name',
                    },
                    full_name: {
                        type: 'string',
                        description: 'Person\'s full name (alternative to first_name + last_name)',
                    },
                },
                required: ['domain'],
            },
            execute: async (args) => {
                const domain = (args.domain as string).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
                const params: Record<string, string> = { domain };
                if (args.full_name) {
                    const parts = (args.full_name as string).trim().split(/\s+/);
                    params.first_name = parts[0];
                    params.last_name = parts.slice(1).join(' ');
                } else {
                    if (args.first_name) params.first_name = args.first_name as string;
                    if (args.last_name) params.last_name = args.last_name as string;
                }

                if (!params.first_name && !params.last_name) {
                    return 'Please provide a name (first_name + last_name, or full_name) to find their email.';
                }

                logger.info(COMPONENT, `Email finder: ${params.first_name || ''} ${params.last_name || ''} @ ${domain}`);
                const result = await hunterFetch('email-finder', params);
                const data = result.data as Record<string, unknown>;

                if (!data?.email) {
                    return `No email found for ${params.first_name || ''} ${params.last_name || ''} at ${domain}.`;
                }

                const lines = [
                    `Email: ${data.email}`,
                    `Confidence: ${data.score}%`,
                ];
                if (data.position) lines.push(`Position: ${data.position}`);
                if (data.linkedin) lines.push(`LinkedIn: ${data.linkedin}`);
                if (data.twitter) lines.push(`Twitter: ${data.twitter}`);
                if (data.company) lines.push(`Company: ${data.company}`);
                const sources = data.sources as Array<{ domain: string; uri: string }> | undefined;
                if (sources?.length) {
                    lines.push(`Sources: ${sources.map(s => s.uri || s.domain).join(', ')}`);
                }
                return lines.join('\n');
            },
        },
    );

    // ── Email Verifier ─────────────────────────────────────────
    registerSkill(
        {
            name: 'hunter',
            description: 'Use this skill when Tony says "find emails for X company", "find the contact at Y", "who do I reach out to at [company]?", "find [person]\'s email", "verify this email", or "how many contacts does [company] have?". Uses Hunter.io API to find, verify, and count professional email addresses. Requires HUNTER_API_KEY.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'hunter_verify_email',
            description: 'Verify whether an email address is valid and deliverable. Use when Tony says "verify this email", "is [email] real?", or "check if [email] will bounce". Returns status, confidence score, and mail server diagnostics.',
            parameters: {
                type: 'object',
                properties: {
                    email: {
                        type: 'string',
                        description: 'Email address to verify',
                    },
                },
                required: ['email'],
            },
            execute: async (args) => {
                const email = args.email as string;
                logger.info(COMPONENT, `Verifying: ${email}`);
                const result = await hunterFetch('email-verifier', { email });
                const data = result.data as Record<string, unknown>;

                const status = data.status as string || 'unknown';
                const score = data.score as number;
                const lines = [
                    `Email: ${email}`,
                    `Status: ${status}`,
                    `Score: ${score}`,
                ];
                if (data.result) lines.push(`Result: ${data.result}`);
                if (data.regexp !== undefined) lines.push(`Valid format: ${data.regexp ? 'yes' : 'no'}`);
                if (data.gibberish !== undefined) lines.push(`Gibberish: ${data.gibberish ? 'yes' : 'no'}`);
                if (data.disposable !== undefined) lines.push(`Disposable: ${data.disposable ? 'yes' : 'no'}`);
                if (data.webmail !== undefined) lines.push(`Webmail: ${data.webmail ? 'yes' : 'no'}`);
                if (data.mx_records !== undefined) lines.push(`MX records: ${data.mx_records ? 'yes' : 'no'}`);
                if (data.smtp_server !== undefined) lines.push(`SMTP responds: ${data.smtp_server ? 'yes' : 'no'}`);
                if (data.smtp_check !== undefined) lines.push(`SMTP accepts: ${data.smtp_check ? 'yes' : 'no'}`);
                if (data.accept_all !== undefined) lines.push(`Catch-all: ${data.accept_all ? 'yes' : 'no'}`);
                if (data.block !== undefined) lines.push(`Blocked: ${data.block ? 'yes' : 'no'}`);
                return lines.join('\n');
            },
        },
    );

    // ── Email Count ────────────────────────────────────────────
    registerSkill(
        {
            name: 'hunter',
            description: 'Use this skill when Tony says "find emails for X company", "find the contact at Y", "who do I reach out to at [company]?", "find [person]\'s email", "verify this email", or "how many contacts does [company] have?". Uses Hunter.io API to find, verify, and count professional email addresses. Requires HUNTER_API_KEY.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'hunter_email_count',
            description: 'Get a quick count of how many emails Hunter.io has indexed for a company domain. Use when Tony asks "how big is [company]?", "how many contacts does [company] have?", or before running a full domain search to gauge coverage.',
            parameters: {
                type: 'object',
                properties: {
                    domain: {
                        type: 'string',
                        description: 'Company domain (e.g. "stripe.com")',
                    },
                },
                required: ['domain'],
            },
            execute: async (args) => {
                const domain = (args.domain as string).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
                logger.info(COMPONENT, `Email count: ${domain}`);
                const result = await hunterFetch('email-count', { domain });
                const data = result.data as Record<string, unknown>;

                const total = data.total as number || 0;
                const lines = [`Domain: ${domain}`, `Total emails on file: ${total}`];
                const personal = data.personal_emails as number;
                const generic = data.generic_emails as number;
                if (personal !== undefined) lines.push(`Personal: ${personal}`);
                if (generic !== undefined) lines.push(`Generic: ${generic}`);
                const dept = data.department as Record<string, number> | undefined;
                if (dept && Object.keys(dept).length > 0) {
                    lines.push('By department:');
                    for (const [name, count] of Object.entries(dept)) {
                        if (count > 0) lines.push(`  ${name}: ${count}`);
                    }
                }
                return lines.join('\n');
            },
        },
    );

    // ── Account Info ───────────────────────────────────────────
    registerSkill(
        {
            name: 'hunter',
            description: 'Use this skill when Tony says "find emails for X company", "find the contact at Y", "who do I reach out to at [company]?", "find [person]\'s email", "verify this email", or "how many contacts does [company] have?". Uses Hunter.io API to find, verify, and count professional email addresses. Requires HUNTER_API_KEY.',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'hunter_account',
            description: 'Check Hunter.io account status — API credits remaining, plan info, and usage. Use when Tony asks "how many Hunter searches do I have left?" or "check my Hunter.io account".',
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                logger.info(COMPONENT, 'Checking account status');
                const result = await hunterFetch('account', {});
                const data = result.data as Record<string, unknown>;

                const calls = data.calls as Record<string, unknown> | undefined;
                const lines = [`Hunter.io Account`];
                if (data.email) lines.push(`Email: ${data.email}`);
                if (data.plan_name) lines.push(`Plan: ${data.plan_name}`);
                if (data.plan_level) lines.push(`Level: ${data.plan_level}`);
                if (calls) {
                    lines.push(`Requests used: ${calls.used || 0}`);
                    lines.push(`Requests available: ${calls.available || 0}`);
                }
                if (data.team_id) lines.push(`Team ID: ${data.team_id}`);
                return lines.join('\n');
            },
        },
    );

    logger.info(COMPONENT, 'Hunter.io skill registered (5 tools: hunter_domain_search, hunter_email_finder, hunter_verify_email, hunter_email_count, hunter_account)');
}
