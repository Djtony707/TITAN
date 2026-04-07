/**
 * TITAN — Sentry Integration
 * Pull errors from Sentry, auto-diagnose, and create fixes.
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'Sentry';

export function registerSentrySkill(): void {
    registerSkill(
        { name: 'sentry_issues', description: 'View Sentry error issues', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'sentry_issues',
            description: 'List recent Sentry issues, get error details, and diagnose.\nUSE THIS WHEN: "check Sentry errors", "what\'s crashing", "show me Sentry issues"\nRequires SENTRY_AUTH_TOKEN and SENTRY_ORG env vars.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'get', 'resolve'], description: 'list issues, get detail, or resolve' },
                    project: { type: 'string', description: 'Sentry project slug' },
                    issueId: { type: 'string', description: 'Issue ID for get/resolve' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const token = process.env.SENTRY_AUTH_TOKEN;
                const org = process.env.SENTRY_ORG;
                if (!token || !org) return 'Error: Set SENTRY_AUTH_TOKEN and SENTRY_ORG environment variables.';

                const action = args.action as string;
                const project = args.project as string;
                const baseUrl = `https://sentry.io/api/0`;

                try {
                    if (action === 'list') {
                        const url = project
                            ? `${baseUrl}/projects/${org}/${project}/issues/?query=is:unresolved&limit=10`
                            : `${baseUrl}/organizations/${org}/issues/?query=is:unresolved&limit=10`;
                        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
                        const issues = await res.json() as any[];
                        if (!Array.isArray(issues) || issues.length === 0) return 'No unresolved issues found.';
                        return issues.map(i => `[${i.shortId}] ${i.title} (${i.count} events, ${i.level})`).join('\n');
                    }
                    if (action === 'get' && args.issueId) {
                        const res = await fetch(`${baseUrl}/issues/${args.issueId}/`, { headers: { 'Authorization': `Bearer ${token}` } });
                        const issue = await res.json() as any;
                        const eventsRes = await fetch(`${baseUrl}/issues/${args.issueId}/events/latest/`, { headers: { 'Authorization': `Bearer ${token}` } });
                        const event = await eventsRes.json() as any;
                        const stack = event?.entries?.find((e: any) => e.type === 'exception')?.data?.values?.[0]?.stacktrace?.frames?.slice(-5) || [];
                        return `Issue: ${issue.title}\nLevel: ${issue.level}\nEvents: ${issue.count}\nFirst seen: ${issue.firstSeen}\n\nStack trace (last 5 frames):\n${stack.map((f: any) => `  ${f.filename}:${f.lineNo} in ${f.function}`).join('\n')}`;
                    }
                    return 'Use: list, get (with issueId)';
                } catch (e) {
                    return `Sentry API error: ${(e as Error).message}`;
                }
            },
        },
    );
}
