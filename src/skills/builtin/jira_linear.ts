/**
 * TITAN — Jira & Linear Integration Skill
 * Pull tasks from PM tools, create issues, update status bidirectionally.
 */
import { registerSkill } from '../registry.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'JiraLinear';

async function apiCall(url: string, token: string, method = 'GET', body?: unknown): Promise<unknown> {
    const res = await fetch(url, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
}

export function registerJiraLinearSkill(): void {
    // Linear integration
    registerSkill(
        { name: 'linear_issues', description: 'Manage Linear issues', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'linear_issues',
            description: 'List, create, or update Linear issues.\nUSE THIS WHEN: "check Linear", "create Linear issue", "update ticket", "what are my tasks"\nRequires LINEAR_API_KEY env var.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'create', 'update', 'get'], description: 'Action to perform' },
                    query: { type: 'string', description: 'Search query or issue ID' },
                    title: { type: 'string', description: 'Issue title (for create)' },
                    description: { type: 'string', description: 'Issue description (for create/update)' },
                    status: { type: 'string', description: 'Status to set (for update)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const token = process.env.LINEAR_API_KEY;
                if (!token) return 'Error: LINEAR_API_KEY not set. Set it in your environment to use Linear integration.';

                const action = args.action as string;
                const graphqlUrl = 'https://api.linear.app/graphql';

                try {
                    if (action === 'list') {
                        const query = args.query as string || '';
                        const gql = query
                            ? `{ issueSearch(query: "${query}", first: 10) { nodes { id identifier title state { name } assignee { name } priority createdAt } } }`
                            : `{ issues(first: 20, orderBy: updatedAt) { nodes { id identifier title state { name } assignee { name } priority updatedAt } } }`;
                        const data = await apiCall(graphqlUrl, token, 'POST', { query: gql }) as any;
                        const issues = data?.data?.issues?.nodes || data?.data?.issueSearch?.nodes || [];
                        if (issues.length === 0) return 'No issues found.';
                        return issues.map((i: any) => `${i.identifier} [${i.state?.name || '?'}] ${i.title} (${i.assignee?.name || 'unassigned'})`).join('\n');
                    }
                    if (action === 'create') {
                        const gql = `mutation { issueCreate(input: { title: "${args.title || 'Untitled'}", description: "${args.description || ''}" }) { success issue { id identifier title url } } }`;
                        const data = await apiCall(graphqlUrl, token, 'POST', { query: gql }) as any;
                        const issue = data?.data?.issueCreate?.issue;
                        return issue ? `Created: ${issue.identifier} — ${issue.title} (${issue.url})` : 'Failed to create issue';
                    }
                    return `Action "${action}" not fully implemented yet. Available: list, create`;
                } catch (e) {
                    return `Linear API error: ${(e as Error).message}`;
                }
            },
        },
    );

    // Jira integration
    registerSkill(
        { name: 'jira_issues', description: 'Manage Jira issues', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'jira_issues',
            description: 'List, create, or update Jira issues.\nUSE THIS WHEN: "check Jira", "create Jira ticket", "what Jira issues are assigned to me"\nRequires JIRA_URL, JIRA_EMAIL, JIRA_TOKEN env vars.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'create', 'search', 'get'], description: 'Action to perform' },
                    jql: { type: 'string', description: 'JQL query for search (e.g. "assignee=currentUser() AND status!=Done")' },
                    project: { type: 'string', description: 'Project key (for create)' },
                    title: { type: 'string', description: 'Issue summary (for create)' },
                    description: { type: 'string', description: 'Issue description (for create)' },
                    issueType: { type: 'string', description: 'Issue type: Bug, Task, Story (default: Task)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const url = process.env.JIRA_URL;
                const email = process.env.JIRA_EMAIL;
                const token = process.env.JIRA_TOKEN;
                if (!url || !email || !token) return 'Error: Set JIRA_URL, JIRA_EMAIL, JIRA_TOKEN environment variables.';

                const auth = Buffer.from(`${email}:${token}`).toString('base64');
                const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };
                const action = args.action as string;

                try {
                    if (action === 'list' || action === 'search') {
                        const jql = (args.jql as string) || 'assignee=currentUser() AND status!=Done ORDER BY updated DESC';
                        const res = await fetch(`${url}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=20`, { headers });
                        const data = await res.json() as any;
                        const issues = data.issues || [];
                        if (issues.length === 0) return 'No issues found.';
                        return issues.map((i: any) => `${i.key} [${i.fields?.status?.name || '?'}] ${i.fields?.summary} (${i.fields?.assignee?.displayName || 'unassigned'})`).join('\n');
                    }
                    if (action === 'create') {
                        const body = {
                            fields: {
                                project: { key: args.project || 'TITAN' },
                                summary: args.title || 'Untitled',
                                description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: args.description || '' }] }] },
                                issuetype: { name: args.issueType || 'Task' },
                            },
                        };
                        const res = await fetch(`${url}/rest/api/3/issue`, { method: 'POST', headers, body: JSON.stringify(body) });
                        const data = await res.json() as any;
                        return data.key ? `Created: ${data.key} — ${args.title} (${url}/browse/${data.key})` : `Error: ${JSON.stringify(data.errors || data)}`;
                    }
                    return `Action "${action}" supported: list, search, create`;
                } catch (e) {
                    return `Jira API error: ${(e as Error).message}`;
                }
            },
        },
    );
    logger.info(COMPONENT, 'Registered Jira + Linear integration skills');
}
