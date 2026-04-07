/**
 * TITAN — Slack Skill Tests
 * Tests for slack_post, slack_read, slack_search, slack_react,
 * slack_thread_reply, slack_channels, slack_review tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const { mockRegisterSkill, mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockUuidV4, mockPostMessage, mockConversationsHistory, mockConversationsList, mockSearchMessages, mockReactionsAdd, mockUsersInfo } = vi.hoisted(() => ({
    mockRegisterSkill: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockUuidV4: vi.fn(() => 'test-uuid-12345678'),
    mockPostMessage: vi.fn(),
    mockConversationsHistory: vi.fn(),
    mockConversationsList: vi.fn(),
    mockSearchMessages: vi.fn(),
    mockReactionsAdd: vi.fn(),
    mockUsersInfo: vi.fn(),
}));

// ── Module mocks ─────────────────────────────────────────────────────────

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: mockRegisterSkill,
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test',
}));

vi.mock('../src/utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('uuid', () => ({
    v4: mockUuidV4,
}));

vi.mock('fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
}));

vi.mock('@slack/web-api', () => ({
    WebClient: vi.fn().mockImplementation(() => ({
        chat: { postMessage: mockPostMessage },
        conversations: {
            history: mockConversationsHistory,
            list: mockConversationsList,
        },
        search: { messages: mockSearchMessages },
        reactions: { add: mockReactionsAdd },
        users: { info: mockUsersInfo },
    })),
}));

// ── Import under test ────────────────────────────────────────────────────

import { registerSlackSkill } from '../src/skills/builtin/slack.js';

// ── Helpers ──────────────────────────────────────────────────────────────

type ToolDef = { name: string; execute: (args: Record<string, unknown>) => Promise<string> };

function getToolHandler(toolName: string): ToolDef['execute'] {
    const call = vi.mocked(mockRegisterSkill).mock.calls.find(
        (c) => c[1]?.name === toolName,
    );
    if (!call) throw new Error(`Tool "${toolName}" not registered`);
    return call[1].execute;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Slack Skill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.SLACK_BOT_TOKEN = 'xoxb-test';
        // Reset the module-level webClient by re-registering
        mockRegisterSkill.mockClear();
        registerSlackSkill();
    });

    describe('registration', () => {
        it('registers 7 tools', () => {
            expect(mockRegisterSkill).toHaveBeenCalledTimes(7);
        });

        it('registers slack_post tool', () => {
            const call = mockRegisterSkill.mock.calls.find((c: any) => c[1]?.name === 'slack_post');
            expect(call).toBeDefined();
            expect(call![0].name).toBe('slack');
        });

        it('registers all expected tool names', () => {
            const names = mockRegisterSkill.mock.calls.map((c: any) => c[1]?.name);
            expect(names).toContain('slack_post');
            expect(names).toContain('slack_read');
            expect(names).toContain('slack_search');
            expect(names).toContain('slack_react');
            expect(names).toContain('slack_thread_reply');
            expect(names).toContain('slack_channels');
            expect(names).toContain('slack_review');
        });
    });

    describe('slack_post', () => {
        it('queues message for review by default', async () => {
            mockExistsSync.mockReturnValue(false);
            mockMkdirSync.mockReturnValue(undefined);
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('slack_post');
            const result = await execute({ channel: '#general', text: 'Hello world' });

            expect(result).toContain('queued for review');
            expect(result).toContain('test-uui'); // uuid().slice(0,8)
            expect(mockWriteFileSync).toHaveBeenCalled();
        });

        it('posts immediately when skipReview is true', async () => {
            mockPostMessage.mockResolvedValue({ ok: true, ts: '1234567890.123456' });

            const execute = getToolHandler('slack_post');
            const result = await execute({ channel: '#general', text: 'Hello', skipReview: true });

            expect(result).toContain('Message posted to #general');
            expect(result).toContain('1234567890.123456');
            expect(mockPostMessage).toHaveBeenCalledWith({ channel: '#general', text: 'Hello' });
        });

        it('returns error when Slack API fails on skipReview', async () => {
            mockPostMessage.mockRejectedValue(new Error('channel_not_found'));

            const execute = getToolHandler('slack_post');
            const result = await execute({ channel: '#nope', text: 'Hi', skipReview: true });

            expect(result).toContain('Slack API error');
            expect(result).toContain('channel_not_found');
        });

        it('includes threadTs in queued message', async () => {
            mockExistsSync.mockReturnValue(false);
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('slack_post');
            await execute({ channel: '#general', text: 'reply', threadTs: '111.222' });

            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written.messages[0].threadTs).toBe('111.222');
        });
    });

    describe('slack_read', () => {
        it('reads channel messages', async () => {
            mockConversationsHistory.mockResolvedValue({
                ok: true,
                messages: [
                    { user: 'U1', ts: '100.001', text: 'Hello' },
                    { user: 'U2', ts: '100.002', text: 'Hi there' },
                ],
            });
            mockUsersInfo.mockResolvedValue({ user: { real_name: 'Alice' } });

            const execute = getToolHandler('slack_read');
            const result = await execute({ channel: 'C01234567' });

            expect(result).toContain('Messages from C01234567');
            expect(result).toContain('Alice');
        });

        it('returns no messages found when empty', async () => {
            mockConversationsHistory.mockResolvedValue({ ok: true, messages: [] });

            const execute = getToolHandler('slack_read');
            const result = await execute({ channel: 'C01234567' });

            expect(result).toContain('No messages found');
        });

        it('handles API error', async () => {
            mockConversationsHistory.mockRejectedValue(new Error('not_in_channel'));

            const execute = getToolHandler('slack_read');
            const result = await execute({ channel: 'C99999' });

            expect(result).toContain('Slack API error');
            expect(result).toContain('not_in_channel');
        });

        it('passes oldest parameter when provided', async () => {
            mockConversationsHistory.mockResolvedValue({ ok: true, messages: [] });

            const execute = getToolHandler('slack_read');
            await execute({ channel: 'C01234567', oldest: '1700000000' });

            expect(mockConversationsHistory).toHaveBeenCalledWith(
                expect.objectContaining({ oldest: '1700000000' }),
            );
        });
    });

    describe('slack_search', () => {
        it('returns search results', async () => {
            mockSearchMessages.mockResolvedValue({
                ok: true,
                messages: {
                    matches: [
                        { channel: { name: 'general' }, username: 'bob', ts: '100.001', text: 'deploy done' },
                    ],
                },
            });

            const execute = getToolHandler('slack_search');
            const result = await execute({ query: 'deploy' });

            expect(result).toContain('deploy');
            expect(result).toContain('#general');
            expect(result).toContain('bob');
        });

        it('returns no results message', async () => {
            mockSearchMessages.mockResolvedValue({ ok: true, messages: { matches: [] } });

            const execute = getToolHandler('slack_search');
            const result = await execute({ query: 'nonexistent' });

            expect(result).toContain('No results found');
        });

        it('handles missing_scope error', async () => {
            mockSearchMessages.mockRejectedValue(new Error('missing_scope'));

            const execute = getToolHandler('slack_search');
            const result = await execute({ query: 'test' });

            expect(result).toContain('user token with search:read scope');
        });

        it('handles generic search error', async () => {
            mockSearchMessages.mockRejectedValue(new Error('timeout'));

            const execute = getToolHandler('slack_search');
            const result = await execute({ query: 'test' });

            expect(result).toContain('Slack search error');
            expect(result).toContain('timeout');
        });
    });

    describe('slack_react', () => {
        it('adds emoji reaction', async () => {
            mockReactionsAdd.mockResolvedValue({ ok: true });

            const execute = getToolHandler('slack_react');
            const result = await execute({ channel: 'C01234567', timestamp: '100.001', emoji: 'thumbsup' });

            expect(result).toContain(':thumbsup:');
            expect(result).toContain('added');
            expect(mockReactionsAdd).toHaveBeenCalledWith({
                channel: 'C01234567',
                timestamp: '100.001',
                name: 'thumbsup',
            });
        });

        it('handles reaction error', async () => {
            mockReactionsAdd.mockRejectedValue(new Error('already_reacted'));

            const execute = getToolHandler('slack_react');
            const result = await execute({ channel: 'C01234567', timestamp: '100.001', emoji: 'thumbsup' });

            expect(result).toContain('Slack reaction error');
            expect(result).toContain('already_reacted');
        });
    });

    describe('slack_thread_reply', () => {
        it('queues thread reply for review by default', async () => {
            mockExistsSync.mockReturnValue(false);
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('slack_thread_reply');
            const result = await execute({ channel: 'C01234567', threadTs: '100.001', text: 'Noted' });

            expect(result).toContain('Thread reply queued for review');
            expect(result).toContain('test-uui');
            expect(mockWriteFileSync).toHaveBeenCalled();
        });

        it('posts thread reply immediately when skipReview is true', async () => {
            mockPostMessage.mockResolvedValue({ ok: true, ts: '100.002' });

            const execute = getToolHandler('slack_thread_reply');
            const result = await execute({
                channel: 'C01234567', threadTs: '100.001', text: 'Done', skipReview: true,
            });

            expect(result).toContain('Thread reply posted');
            expect(result).toContain('100.002');
            expect(mockPostMessage).toHaveBeenCalledWith(
                expect.objectContaining({ thread_ts: '100.001' }),
            );
        });

        it('handles API error on skipReview thread reply', async () => {
            mockPostMessage.mockRejectedValue(new Error('thread_not_found'));

            const execute = getToolHandler('slack_thread_reply');
            const result = await execute({
                channel: 'C01234567', threadTs: '100.001', text: 'oops', skipReview: true,
            });

            expect(result).toContain('Slack API error');
        });
    });

    describe('slack_channels', () => {
        it('lists channels', async () => {
            mockConversationsList.mockResolvedValue({
                ok: true,
                channels: [
                    { name: 'general', id: 'C001', num_members: 50, topic: { value: 'Main channel' } },
                    { name: 'random', id: 'C002', num_members: 30, topic: { value: '' } },
                ],
            });

            const execute = getToolHandler('slack_channels');
            const result = await execute({});

            expect(result).toContain('#general');
            expect(result).toContain('C001');
            expect(result).toContain('50 members');
        });

        it('returns no channels message', async () => {
            mockConversationsList.mockResolvedValue({ ok: true, channels: [] });

            const execute = getToolHandler('slack_channels');
            const result = await execute({});

            expect(result).toContain('No channels found');
        });

        it('handles API error', async () => {
            mockConversationsList.mockRejectedValue(new Error('token_revoked'));

            const execute = getToolHandler('slack_channels');
            const result = await execute({});

            expect(result).toContain('Slack API error');
            expect(result).toContain('token_revoked');
        });
    });

    describe('slack_review', () => {
        it('lists pending messages', async () => {
            const queue = {
                messages: [
                    { id: 'abc12345', channel: '#general', text: 'Hello', status: 'pending', createdAt: '2026-03-13T00:00:00Z' },
                ],
            };
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(queue));

            const execute = getToolHandler('slack_review');
            const result = await execute({ action: 'list' });

            expect(result).toContain('abc12345');
            expect(result).toContain('#general');
            expect(result).toContain('Hello');
        });

        it('returns empty queue message', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ messages: [] }));

            const execute = getToolHandler('slack_review');
            const result = await execute({ action: 'list' });

            expect(result).toContain('queue is empty');
        });

        it('approves and sends a pending message', async () => {
            const queue = {
                messages: [
                    { id: 'msg001', channel: '#dev', text: 'Ship it', status: 'pending', createdAt: '2026-03-13T00:00:00Z' },
                ],
            };
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(queue));
            mockPostMessage.mockResolvedValue({ ok: true, ts: '999.001' });
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('slack_review');
            const result = await execute({ action: 'approve', messageId: 'msg001' });

            expect(result).toContain('Approved and sent');
            expect(result).toContain('#dev');
            expect(mockPostMessage).toHaveBeenCalled();
        });

        it('returns not found when approving nonexistent message', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ messages: [] }));

            const execute = getToolHandler('slack_review');
            const result = await execute({ action: 'approve', messageId: 'nope' });

            expect(result).toContain('not found');
        });

        it('rejects message already sent', async () => {
            const queue = {
                messages: [
                    { id: 'msg002', channel: '#dev', text: 'Hi', status: 'sent', createdAt: '2026-03-13T00:00:00Z' },
                ],
            };
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(queue));

            const execute = getToolHandler('slack_review');
            const result = await execute({ action: 'approve', messageId: 'msg002' });

            expect(result).toContain('already sent');
        });

        it('rejects a pending message', async () => {
            const queue = {
                messages: [
                    { id: 'msg003', channel: '#ops', text: 'Bad msg', status: 'pending', createdAt: '2026-03-13T00:00:00Z' },
                ],
            };
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(queue));
            mockWriteFileSync.mockReturnValue(undefined);

            const execute = getToolHandler('slack_review');
            const result = await execute({ action: 'reject', messageId: 'msg003' });

            expect(result).toContain('rejected');
            const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
            expect(written.messages[0].status).toBe('rejected');
        });

        it('returns usage on invalid action', async () => {
            mockExistsSync.mockReturnValue(false);

            const execute = getToolHandler('slack_review');
            const result = await execute({ action: 'invalid' });

            expect(result).toContain('Usage');
        });

        it('handles send failure during approve', async () => {
            const queue = {
                messages: [
                    { id: 'msg004', channel: '#dev', text: 'Try', status: 'pending', createdAt: '2026-03-13T00:00:00Z' },
                ],
            };
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify(queue));
            mockPostMessage.mockRejectedValue(new Error('rate_limited'));

            const execute = getToolHandler('slack_review');
            const result = await execute({ action: 'approve', messageId: 'msg004' });

            expect(result).toContain('Failed to send');
        });
    });
});
