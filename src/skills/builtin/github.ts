/**
 * TITAN — GitHub Skill (Built-in)
 * Provides GitHub REST API v3 integration: repos, issues, PRs, commits, and files.
 * Requires GITHUB_TOKEN environment variable for authenticated requests.
 */
import { registerSkill } from '../registry.js';
import type { ToolHandler } from '../../agent/toolRunner.js';
import { fetchWithRetry } from '../../utils/helpers.js';
import { loadConfig } from '../../config/config.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'GitHubSkill';
const GITHUB_API_BASE = 'https://api.github.com';
const MAX_OUTPUT_CHARS = 50000;

// ─── Shared helper ────────────────────────────────────────────────────────────

/** Build GitHub API request headers using the token from env or config */
function getHeaders(): Record<string, string> {
    const token = process.env.GITHUB_TOKEN;
    const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'TITAN-Agent',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

/** Perform a GitHub API request with retry logic and rate-limit awareness */
async function githubFetch(
    endpoint: string,
    options: RequestInit = {},
): Promise<unknown> {
    const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API_BASE}${endpoint}`;

    const mergedOptions: RequestInit = {
        ...options,
        headers: {
            ...getHeaders(),
            ...(options.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(30000),
    };

    // For diff requests, we need a different Accept header
    const acceptOverride = (options.headers as Record<string, string> | undefined)?.['Accept'];
    if (acceptOverride) {
        (mergedOptions.headers as Record<string, string>)['Accept'] = acceptOverride;
    }

    const response = await fetchWithRetry(url, mergedOptions, {
        maxRetries: 3,
        initialDelayMs: 1000,
        retryableStatuses: [429, 500, 502, 503],
    });

    // Rate limit warning
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const limit = response.headers.get('X-RateLimit-Limit');
    if (remaining !== null && parseInt(remaining, 10) < 10) {
        const resetTs = response.headers.get('X-RateLimit-Reset');
        const resetTime = resetTs ? new Date(parseInt(resetTs, 10) * 1000).toISOString() : 'unknown';
        logger.warn(COMPONENT, `GitHub rate limit low: ${remaining}/${limit} remaining. Resets at ${resetTime}`);
    }

    if (!response.ok) {
        let errMsg: string;
        try {
            const errBody = await response.json() as { message?: string };
            errMsg = errBody?.message || response.statusText;
        } catch {
            errMsg = response.statusText;
        }
        throw new Error(`GitHub API error ${response.status}: ${errMsg}`);
    }

    // Some endpoints return 204 No Content (e.g. merge)
    if (response.status === 204) return { success: true };

    // Diff responses are plain text
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('text/') || contentType.includes('application/vnd.github.diff')) {
        return response.text();
    }

    return response.json();
}

/** Truncate output if it exceeds the max character limit */
function truncateOutput(data: unknown, label: string): string {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (str.length <= MAX_OUTPUT_CHARS) return str;
    const half = Math.floor(MAX_OUTPUT_CHARS / 2);
    logger.warn(COMPONENT, `${label} output truncated (${str.length} chars → ${MAX_OUTPUT_CHARS})`);
    return str.slice(0, half) + `\n\n... [output truncated — ${str.length - MAX_OUTPUT_CHARS} chars omitted] ...\n\n` + str.slice(-half);
}

/** Validate that owner and repo are present where required */
function requireOwnerRepo(owner: unknown, repo: unknown, action: string): string | null {
    if (!owner || typeof owner !== 'string') return `Error: 'owner' is required for action '${action}'`;
    if (!repo || typeof repo !== 'string') return `Error: 'repo' is required for action '${action}'`;
    return null;
}

// ─── Tool metadata ─────────────────────────────────────────────────────────────

const metaRepos = {
    name: 'github_repos',
    description: 'List, get, or search GitHub repositories. USE THIS WHEN Tony says: "list my repos", "show my GitHub repos", "search for repos about X", "find the repo named X". WORKFLOW: use action=list for owned repos, action=get for a specific repo, action=search to find public repos by keyword.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

const metaIssues = {
    name: 'github_issues',
    description: 'List, create, close, or comment on GitHub issues. USE THIS WHEN Tony says: "check issues", "show open issues", "create an issue", "close issue #X", "comment on issue #X", "what bugs are open". WORKFLOW: Use action=list to see issues, action=create to file a new one, action=close to close, action=comment to add a comment.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

const metaPRs = {
    name: 'github_prs',
    description: 'List, create, merge, or review GitHub pull requests. USE THIS WHEN Tony says: "create a PR", "open a pull request", "merge PR #X", "show open PRs", "what\'s the diff on PR #X", "review pull request". WORKFLOW: For "create PR" — use action=create with title, head branch, and base branch. For diff — use action=diff with prNumber.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

const metaCommits = {
    name: 'github_commits',
    description: 'List, inspect, or compare commits on GitHub. USE THIS WHEN Tony says: "show recent commits", "what changed in the last commit", "what\'s the diff between main and feature branch", "compare branches", "show commit history", "what did we commit". WORKFLOW: Use action=list for history, action=get for a specific SHA, action=compare to diff two branches.',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

const metaFiles = {
    name: 'github_files',
    description: 'Read, list, create, or update files in a GitHub repository. USE THIS WHEN Tony says: "read file X from repo", "show me the contents of X in GitHub", "push this file to GitHub", "update file X in repo", "list files in directory". WORKFLOW: Use action=read to view a file, action=list to browse a directory, action=create for new files (requires content + commit message), action=update for existing files (requires sha from action=read first).',
    version: '1.0.0',
    source: 'bundled' as const,
    enabled: true,
};

// ─── Tool handlers ──────────────────────────────────────────────────────────────

const githubReposHandler: ToolHandler = {
    name: 'github_repos',
    description:
        'Interacts with GitHub repositories. USE THIS WHEN Tony says: "list my repos", "show my GitHub repos", "get info on repo X", "search for repos about Y". ' +
        'WORKFLOW: action=list for owned repos, action=get for a specific repo (requires owner+repo), action=search to find public repos by keyword. ' +
        'RULES: Requires GITHUB_TOKEN env var for private repos and authenticated requests.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'get', 'search'],
                description: 'Action to perform: list (authenticated user repos), get (single repo info), search (query repos)',
            },
            owner: {
                type: 'string',
                description: 'GitHub username or org name (required for action=get)',
            },
            repo: {
                type: 'string',
                description: 'Repository name (required for action=get)',
            },
            query: {
                type: 'string',
                description: 'Search query string (required for action=search)',
            },
            page: {
                type: 'number',
                description: 'Page number for paginated results (default: 1)',
            },
            perPage: {
                type: 'number',
                description: 'Results per page, max 100 (default: 30)',
            },
        },
        required: ['action'],
    },
    execute: async (args: Record<string, unknown>) => {
        const action = args.action as string;
        const owner = args.owner as string | undefined;
        const repo = args.repo as string | undefined;
        const query = args.query as string | undefined;
        const page = (args.page as number) || 1;
        const perPage = Math.min((args.perPage as number) || 30, 100);

        logger.info(COMPONENT, `github_repos action=${action}`);

        try {
            switch (action) {
                case 'list': {
                    const params = new URLSearchParams({
                        per_page: String(perPage),
                        page: String(page),
                        sort: 'updated',
                    });
                    const data = await githubFetch(`/user/repos?${params}`);
                    return truncateOutput(data, 'github_repos/list');
                }

                case 'get': {
                    const err = requireOwnerRepo(owner, repo, action);
                    if (err) return err;
                    const data = await githubFetch(`/repos/${owner}/${repo}`);
                    return truncateOutput(data, 'github_repos/get');
                }

                case 'search': {
                    if (!query) return `Error: 'query' is required for action 'search'`;
                    const params = new URLSearchParams({
                        q: query,
                        per_page: String(perPage),
                        page: String(page),
                    });
                    const data = await githubFetch(`/search/repositories?${params}`);
                    return truncateOutput(data, 'github_repos/search');
                }

                default:
                    return `Error: Unknown action '${action}'. Valid actions: list, get, search`;
            }
        } catch (e) {
            logger.error(COMPONENT, `github_repos error: ${(e as Error).message}`);
            return `Error: ${(e as Error).message}`;
        }
    },
};

const githubIssuesHandler: ToolHandler = {
    name: 'github_issues',
    description:
        'Manages GitHub issues. USE THIS WHEN Tony says: "check issues", "show open issues", "create an issue", "close issue #X", "comment on issue #X", "what bugs are open in repo X". ' +
        'WORKFLOW: action=list to see issues, action=get for details on one issue, action=create to file a new issue (requires title), action=close to close, action=comment to add a comment. ' +
        'RULES: Always include owner and repo. For action=create, always provide a clear title and body.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'get', 'create', 'close', 'comment'],
                description: 'Action to perform on issues',
            },
            owner: {
                type: 'string',
                description: 'GitHub username or org name',
            },
            repo: {
                type: 'string',
                description: 'Repository name',
            },
            issueNumber: {
                type: 'number',
                description: 'Issue number (required for get, close, comment)',
            },
            title: {
                type: 'string',
                description: 'Issue title (required for create)',
            },
            body: {
                type: 'string',
                description: 'Issue body / comment text (required for create and comment)',
            },
            labels: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of label names to apply (optional, used with create)',
            },
            state: {
                type: 'string',
                enum: ['open', 'closed', 'all'],
                description: 'Filter issues by state for action=list (default: open)',
            },
            page: {
                type: 'number',
                description: 'Page number (default: 1)',
            },
            perPage: {
                type: 'number',
                description: 'Results per page, max 100 (default: 30)',
            },
        },
        required: ['action', 'owner', 'repo'],
    },
    execute: async (args: Record<string, unknown>) => {
        const action = args.action as string;
        const owner = args.owner as string;
        const repo = args.repo as string;
        const issueNumber = args.issueNumber as number | undefined;
        const title = args.title as string | undefined;
        const body = args.body as string | undefined;
        const labels = args.labels as string[] | undefined;
        const state = (args.state as string) || 'open';
        const page = (args.page as number) || 1;
        const perPage = Math.min((args.perPage as number) || 30, 100);

        const err = requireOwnerRepo(owner, repo, action);
        if (err) return err;

        logger.info(COMPONENT, `github_issues action=${action} ${owner}/${repo}`);

        try {
            switch (action) {
                case 'list': {
                    const params = new URLSearchParams({
                        state,
                        per_page: String(perPage),
                        page: String(page),
                    });
                    const data = await githubFetch(`/repos/${owner}/${repo}/issues?${params}`);
                    return truncateOutput(data, 'github_issues/list');
                }

                case 'get': {
                    if (!issueNumber) return `Error: 'issueNumber' is required for action 'get'`;
                    const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issueNumber}`);
                    return truncateOutput(data, 'github_issues/get');
                }

                case 'create': {
                    if (!title) return `Error: 'title' is required for action 'create'`;
                    const payload: Record<string, unknown> = { title };
                    if (body) payload.body = body;
                    if (labels && labels.length > 0) payload.labels = labels;
                    const data = await githubFetch(`/repos/${owner}/${repo}/issues`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    return truncateOutput(data, 'github_issues/create');
                }

                case 'close': {
                    if (!issueNumber) return `Error: 'issueNumber' is required for action 'close'`;
                    const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ state: 'closed' }),
                    });
                    return truncateOutput(data, 'github_issues/close');
                }

                case 'comment': {
                    if (!issueNumber) return `Error: 'issueNumber' is required for action 'comment'`;
                    if (!body) return `Error: 'body' is required for action 'comment'`;
                    const data = await githubFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ body }),
                    });
                    return truncateOutput(data, 'github_issues/comment');
                }

                default:
                    return `Error: Unknown action '${action}'. Valid actions: list, get, create, close, comment`;
            }
        } catch (e) {
            logger.error(COMPONENT, `github_issues error: ${(e as Error).message}`);
            return `Error: ${(e as Error).message}`;
        }
    },
};

const githubPRsHandler: ToolHandler = {
    name: 'github_prs',
    description:
        'Manages GitHub pull requests. USE THIS WHEN Tony says: "create a PR", "open a pull request", "merge PR #X", "show open PRs", "what\'s the diff on PR #X", "review pull request". ' +
        'WORKFLOW: action=list for all PRs, action=get for one PR, action=create to open a new PR (requires title, head branch, base branch), action=merge to merge, action=diff to see raw diff. ' +
        'RULES: For action=create, always confirm head and base branch names before proceeding.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'get', 'create', 'merge', 'diff'],
                description: 'Action to perform on pull requests',
            },
            owner: {
                type: 'string',
                description: 'GitHub username or org name',
            },
            repo: {
                type: 'string',
                description: 'Repository name',
            },
            prNumber: {
                type: 'number',
                description: 'Pull request number (required for get, merge, diff)',
            },
            title: {
                type: 'string',
                description: 'PR title (required for create)',
            },
            body: {
                type: 'string',
                description: 'PR description body (optional for create)',
            },
            head: {
                type: 'string',
                description: 'The branch containing the changes (required for create, e.g. "feature-branch" or "owner:branch")',
            },
            base: {
                type: 'string',
                description: 'The branch to merge into (required for create, e.g. "main")',
            },
            state: {
                type: 'string',
                enum: ['open', 'closed', 'all'],
                description: 'Filter PRs by state for action=list (default: open)',
            },
            page: {
                type: 'number',
                description: 'Page number (default: 1)',
            },
            perPage: {
                type: 'number',
                description: 'Results per page, max 100 (default: 30)',
            },
        },
        required: ['action', 'owner', 'repo'],
    },
    execute: async (args: Record<string, unknown>) => {
        const action = args.action as string;
        const owner = args.owner as string;
        const repo = args.repo as string;
        const prNumber = args.prNumber as number | undefined;
        const title = args.title as string | undefined;
        const body = args.body as string | undefined;
        const head = args.head as string | undefined;
        const base = args.base as string | undefined;
        const state = (args.state as string) || 'open';
        const page = (args.page as number) || 1;
        const perPage = Math.min((args.perPage as number) || 30, 100);

        const err = requireOwnerRepo(owner, repo, action);
        if (err) return err;

        logger.info(COMPONENT, `github_prs action=${action} ${owner}/${repo}`);

        try {
            switch (action) {
                case 'list': {
                    const params = new URLSearchParams({
                        state,
                        per_page: String(perPage),
                        page: String(page),
                    });
                    const data = await githubFetch(`/repos/${owner}/${repo}/pulls?${params}`);
                    return truncateOutput(data, 'github_prs/list');
                }

                case 'get': {
                    if (!prNumber) return `Error: 'prNumber' is required for action 'get'`;
                    const data = await githubFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`);
                    return truncateOutput(data, 'github_prs/get');
                }

                case 'create': {
                    if (!title) return `Error: 'title' is required for action 'create'`;
                    if (!head) return `Error: 'head' is required for action 'create'`;
                    if (!base) return `Error: 'base' is required for action 'create'`;
                    const payload: Record<string, unknown> = { title, head, base };
                    if (body) payload.body = body;
                    const data = await githubFetch(`/repos/${owner}/${repo}/pulls`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    return truncateOutput(data, 'github_prs/create');
                }

                case 'merge': {
                    if (!prNumber) return `Error: 'prNumber' is required for action 'merge'`;
                    const data = await githubFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ merge_method: 'merge' }),
                    });
                    return truncateOutput(data, 'github_prs/merge');
                }

                case 'diff': {
                    if (!prNumber) return `Error: 'prNumber' is required for action 'diff'`;
                    const data = await githubFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
                        headers: { 'Accept': 'application/vnd.github.diff' },
                    });
                    return truncateOutput(data, 'github_prs/diff');
                }

                default:
                    return `Error: Unknown action '${action}'. Valid actions: list, get, create, merge, diff`;
            }
        } catch (e) {
            logger.error(COMPONENT, `github_prs error: ${(e as Error).message}`);
            return `Error: ${(e as Error).message}`;
        }
    },
};

const githubCommitsHandler: ToolHandler = {
    name: 'github_commits',
    description:
        'Inspects GitHub commit history. USE THIS WHEN Tony says: "show recent commits", "what changed in the last commit", "what\'s the diff between branches", "compare main and feature-x", "show commit history", "what did we push". ' +
        'WORKFLOW: action=list for commit history on a branch, action=get for a specific commit SHA, action=compare to diff two refs (base...head). ' +
        'RULES: Always include owner and repo.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['list', 'get', 'compare'],
                description: 'Action: list commits, get single commit, or compare two refs',
            },
            owner: {
                type: 'string',
                description: 'GitHub username or org name',
            },
            repo: {
                type: 'string',
                description: 'Repository name',
            },
            sha: {
                type: 'string',
                description: 'Commit SHA or branch name to list from (optional for list, required for get)',
            },
            base: {
                type: 'string',
                description: 'Base ref (branch, tag, or SHA) for action=compare',
            },
            head: {
                type: 'string',
                description: 'Head ref (branch, tag, or SHA) for action=compare',
            },
            page: {
                type: 'number',
                description: 'Page number (default: 1)',
            },
            perPage: {
                type: 'number',
                description: 'Results per page, max 100 (default: 30)',
            },
        },
        required: ['action', 'owner', 'repo'],
    },
    execute: async (args: Record<string, unknown>) => {
        const action = args.action as string;
        const owner = args.owner as string;
        const repo = args.repo as string;
        const sha = args.sha as string | undefined;
        const base = args.base as string | undefined;
        const head = args.head as string | undefined;
        const page = (args.page as number) || 1;
        const perPage = Math.min((args.perPage as number) || 30, 100);

        const err = requireOwnerRepo(owner, repo, action);
        if (err) return err;

        logger.info(COMPONENT, `github_commits action=${action} ${owner}/${repo}`);

        try {
            switch (action) {
                case 'list': {
                    const params = new URLSearchParams({
                        per_page: String(perPage),
                        page: String(page),
                    });
                    if (sha) params.set('sha', sha);
                    const data = await githubFetch(`/repos/${owner}/${repo}/commits?${params}`);
                    return truncateOutput(data, 'github_commits/list');
                }

                case 'get': {
                    if (!sha) return `Error: 'sha' is required for action 'get'`;
                    const data = await githubFetch(`/repos/${owner}/${repo}/commits/${sha}`);
                    return truncateOutput(data, 'github_commits/get');
                }

                case 'compare': {
                    if (!base) return `Error: 'base' is required for action 'compare'`;
                    if (!head) return `Error: 'head' is required for action 'compare'`;
                    const data = await githubFetch(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
                    return truncateOutput(data, 'github_commits/compare');
                }

                default:
                    return `Error: Unknown action '${action}'. Valid actions: list, get, compare`;
            }
        } catch (e) {
            logger.error(COMPONENT, `github_commits error: ${(e as Error).message}`);
            return `Error: ${(e as Error).message}`;
        }
    },
};

const githubFilesHandler: ToolHandler = {
    name: 'github_files',
    description:
        'Reads, lists, creates, or updates files in a GitHub repository. USE THIS WHEN Tony says: "read file X from GitHub", "show contents of X in repo", "push this file to GitHub", "update file X with new content", "list files in src/". ' +
        'WORKFLOW: action=read to decode file contents, action=list to browse a directory, action=create for new files (requires content + message), action=update for existing files (requires sha from action=read first to prevent conflicts). ' +
        'RULES: For action=update, always fetch the current sha via action=read before writing.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['read', 'list', 'create', 'update'],
                description: 'Action: read file content, list directory, create a new file, or update an existing file',
            },
            owner: {
                type: 'string',
                description: 'GitHub username or org name',
            },
            repo: {
                type: 'string',
                description: 'Repository name',
            },
            path: {
                type: 'string',
                description: 'File or directory path within the repository (e.g. "src/index.ts" or "src/")',
            },
            content: {
                type: 'string',
                description: 'Plain text file content to write (required for create and update — will be base64-encoded automatically)',
            },
            message: {
                type: 'string',
                description: 'Commit message (required for create and update)',
            },
            branch: {
                type: 'string',
                description: 'Branch name to read from or write to (optional, defaults to repo default branch)',
            },
            sha: {
                type: 'string',
                description: 'The blob SHA of the file being replaced (required for update to prevent conflicts)',
            },
        },
        required: ['action', 'owner', 'repo', 'path'],
    },
    execute: async (args: Record<string, unknown>) => {
        const action = args.action as string;
        const owner = args.owner as string;
        const repo = args.repo as string;
        const path = args.path as string;
        const content = args.content as string | undefined;
        const message = args.message as string | undefined;
        const branch = args.branch as string | undefined;
        const sha = args.sha as string | undefined;

        const err = requireOwnerRepo(owner, repo, action);
        if (err) return err;
        if (!path) return `Error: 'path' is required for action '${action}'`;

        // Normalise path — strip leading slash
        const cleanPath = path.replace(/^\/+/, '');

        logger.info(COMPONENT, `github_files action=${action} ${owner}/${repo}/${cleanPath}`);

        try {
            switch (action) {
                case 'read': {
                    const params = new URLSearchParams();
                    if (branch) params.set('ref', branch);
                    const qs = params.toString() ? `?${params}` : '';
                    const data = await githubFetch(`/repos/${owner}/${repo}/contents/${cleanPath}${qs}`) as Record<string, unknown>;

                    if (Array.isArray(data)) {
                        return `Error: '${cleanPath}' is a directory. Use action='list' to see its contents.`;
                    }

                    const encoding = data.encoding as string;
                    const rawContent = data.content as string;

                    if (encoding === 'base64' && rawContent) {
                        const decoded = Buffer.from(rawContent.replace(/\n/g, ''), 'base64').toString('utf-8');
                        return truncateOutput(decoded, 'github_files/read');
                    }

                    return truncateOutput(data, 'github_files/read');
                }

                case 'list': {
                    const params = new URLSearchParams();
                    if (branch) params.set('ref', branch);
                    const qs = params.toString() ? `?${params}` : '';
                    const data = await githubFetch(`/repos/${owner}/${repo}/contents/${cleanPath}${qs}`);

                    if (!Array.isArray(data)) {
                        return `Error: '${cleanPath}' is a file, not a directory. Use action='read' to get its contents.`;
                    }

                    // Return a compact directory listing
                    const entries = (data as Array<Record<string, unknown>>).map(entry => ({
                        name: entry.name,
                        type: entry.type,
                        size: entry.size,
                        path: entry.path,
                        sha: entry.sha,
                        download_url: entry.download_url,
                    }));
                    return truncateOutput(entries, 'github_files/list');
                }

                case 'create': {
                    if (!content) return `Error: 'content' is required for action 'create'`;
                    if (!message) return `Error: 'message' is required for action 'create'`;
                    const payload: Record<string, unknown> = {
                        message,
                        content: Buffer.from(content, 'utf-8').toString('base64'),
                    };
                    if (branch) payload.branch = branch;
                    const data = await githubFetch(`/repos/${owner}/${repo}/contents/${cleanPath}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    return truncateOutput(data, 'github_files/create');
                }

                case 'update': {
                    if (!content) return `Error: 'content' is required for action 'update'`;
                    if (!message) return `Error: 'message' is required for action 'update'`;
                    if (!sha) return `Error: 'sha' is required for action 'update' (the current file blob SHA — get it via action='read')`;
                    const payload: Record<string, unknown> = {
                        message,
                        content: Buffer.from(content, 'utf-8').toString('base64'),
                        sha,
                    };
                    if (branch) payload.branch = branch;
                    const data = await githubFetch(`/repos/${owner}/${repo}/contents/${cleanPath}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    return truncateOutput(data, 'github_files/update');
                }

                default:
                    return `Error: Unknown action '${action}'. Valid actions: read, list, create, update`;
            }
        } catch (e) {
            logger.error(COMPONENT, `github_files error: ${(e as Error).message}`);
            return `Error: ${(e as Error).message}`;
        }
    },
};

// ─── Registration entry point ──────────────────────────────────────────────────

export function registerGitHubSkill(): void {
    if (!process.env.GITHUB_TOKEN) {
        logger.warn(COMPONENT, 'GITHUB_TOKEN is not set — GitHub skill will work for public repos only (rate limits apply)');
    }

    // Load config so that future config-based token lookup is available
    try { loadConfig(); } catch { /* non-fatal */ }

    registerSkill(metaRepos, githubReposHandler);
    registerSkill(metaIssues, githubIssuesHandler);
    registerSkill(metaPRs, githubPRsHandler);
    registerSkill(metaCommits, githubCommitsHandler);
    registerSkill(metaFiles, githubFilesHandler);

    logger.info(COMPONENT, 'GitHub skill registered (5 tools: github_repos, github_issues, github_prs, github_commits, github_files)');
}
