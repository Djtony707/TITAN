/**
 * Smoke tests for the MockOllamaProvider tape harness itself.
 * These guard against regressions in the test infrastructure that the
 * actual integration tests will later depend on.
 */
import { describe, it, expect } from 'vitest';
import { MockOllamaProvider, withTape } from './MockOllamaProvider.js';

describe('MockOllamaProvider', () => {
    describe('fromResponses', () => {
        it('returns each response in order on successive chat() calls', async () => {
            const mock = MockOllamaProvider.fromResponses([
                { content: 'first' },
                { content: 'second' },
                { content: 'third' },
            ]);
            const r1 = await mock.chat({ messages: [{ role: 'user', content: 'a' }] });
            const r2 = await mock.chat({ messages: [{ role: 'user', content: 'b' }] });
            const r3 = await mock.chat({ messages: [{ role: 'user', content: 'c' }] });
            expect(r1.content).toBe('first');
            expect(r2.content).toBe('second');
            expect(r3.content).toBe('third');
        });

        it('throws a descriptive error when the tape is exhausted', async () => {
            const mock = MockOllamaProvider.fromResponses([{ content: 'only one' }]);
            await mock.chat({ messages: [] });
            await expect(mock.chat({ messages: [] })).rejects.toThrow(/tape exhausted/);
        });

        it('infers finishReason=tool_calls when toolCalls are present', async () => {
            const mock = MockOllamaProvider.fromResponses([{
                content: '',
                toolCalls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'weather', arguments: '{}' },
                }],
            }]);
            const r = await mock.chat({ messages: [] });
            expect(r.finishReason).toBe('tool_calls');
            expect(r.toolCalls?.[0].function.name).toBe('weather');
        });

        it('reset() rewinds the cursor', async () => {
            const mock = MockOllamaProvider.fromResponses([
                { content: 'a' },
                { content: 'b' },
            ]);
            const first = await mock.chat({ messages: [] });
            mock.reset();
            const replayed = await mock.chat({ messages: [] });
            expect(replayed.content).toBe(first.content);
        });

        it('remaining() reflects unused exchanges', async () => {
            const mock = MockOllamaProvider.fromResponses([
                { content: 'a' },
                { content: 'b' },
                { content: 'c' },
            ]);
            expect(mock.remaining()).toBe(3);
            await mock.chat({ messages: [] });
            expect(mock.remaining()).toBe(2);
        });
    });

    describe('chatStream', () => {
        it('yields a single text chunk + done for content responses', async () => {
            const mock = MockOllamaProvider.fromResponses([{ content: 'hello' }]);
            const chunks = [];
            for await (const c of mock.chatStream({ messages: [] })) chunks.push(c);
            expect(chunks).toHaveLength(2);
            expect(chunks[0]).toEqual({ type: 'text', content: 'hello' });
            expect(chunks[1]).toEqual({ type: 'done' });
        });

        it('yields one tool_call chunk per tool then done', async () => {
            const mock = MockOllamaProvider.fromResponses([{
                content: '',
                toolCalls: [
                    { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
                    { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } },
                ],
            }]);
            const chunks = [];
            for await (const c of mock.chatStream({ messages: [] })) chunks.push(c);
            expect(chunks).toHaveLength(3);
            expect(chunks[0].type).toBe('tool_call');
            expect(chunks[1].type).toBe('tool_call');
            expect(chunks[2].type).toBe('done');
        });
    });

    describe('fromTape', () => {
        it('loads the safety_refusal tape and replays the refusal text', async () => {
            const mock = MockOllamaProvider.fromTape('safety_refusal');
            const r = await mock.chat({
                messages: [{ role: 'user', content: 'rm -rf /' }],
            });
            expect(r.content).toMatch(/can'?t do that|destructive|irreversible/i);
            expect(r.finishReason).toBe('stop');
            expect(r.toolCalls).toBeUndefined();
        });

        it('loads the weather tape and replays a 2-round tool-call exchange', async () => {
            const mock = MockOllamaProvider.fromTape('weather');
            // Round 1: model emits a tool call
            const r1 = await mock.chat({
                messages: [{ role: 'user', content: 'weather in Kelseyville' }],
            });
            expect(r1.finishReason).toBe('tool_calls');
            expect(r1.toolCalls?.[0].function.name).toBe('weather');
            const args = JSON.parse(r1.toolCalls![0].function.arguments);
            expect(args.location).toMatch(/Kelseyville/);
            // Round 2: after tool result is fed back, model composes final reply
            const r2 = await mock.chat({
                messages: [{ role: 'tool', content: '{"temp_f":72}', toolCallId: 'call_w_kelseyville_001' }],
            });
            expect(r2.finishReason).toBe('stop');
            expect(r2.content).toMatch(/72°F/);
            expect(r2.content).toMatch(/Kelseyville/);
        });

        it('throws a useful error when the tape file is missing', () => {
            expect(() => MockOllamaProvider.fromTape('nonexistent_tape_zzz'))
                .toThrow(/Tape not found.*TITAN_RECORD_TAPE=nonexistent_tape_zzz/);
        });

        it('loads file_write tape: 2-round write_file tool call → confirmation', async () => {
            const mock = MockOllamaProvider.fromTape('file_write');
            const r1 = await mock.chat({ messages: [{ role: 'user', content: 'write me a markdown file' }] });
            expect(r1.finishReason).toBe('tool_calls');
            expect(r1.toolCalls?.[0].function.name).toBe('write_file');
            const args = JSON.parse(r1.toolCalls![0].function.arguments);
            expect(args.path).toMatch(/\.md$/);
            expect(args.content).toBeTypeOf('string');
            const r2 = await mock.chat({ messages: [{ role: 'tool', content: '{"ok":true}', toolCallId: 'call_fw_001' }] });
            expect(r2.finishReason).toBe('stop');
            expect(r2.content).toMatch(/Saved|wrote|saved/i);
        });

        it('loads ambiguous tape: clarifying question, no tool call', async () => {
            const mock = MockOllamaProvider.fromTape('ambiguous');
            const r = await mock.chat({ messages: [{ role: 'user', content: 'check on it' }] });
            expect(r.finishReason).toBe('stop');
            expect(r.toolCalls).toBeUndefined();
            expect(r.content).toMatch(/\?/);
            expect(r.content).toMatch(/check|specific|which/i);
        });

        it('loads off_topic tape: refuses medical advice, redirects to professional', async () => {
            const mock = MockOllamaProvider.fromTape('off_topic');
            const r = await mock.chat({ messages: [{ role: 'user', content: 'medical question' }] });
            expect(r.finishReason).toBe('stop');
            expect(r.toolCalls).toBeUndefined();
            expect(r.content).toMatch(/doctor|nurse|professional|Poison Control|urgent/i);
        });
    });

    describe('withTape helper', () => {
        it('yields the mock and lets the test run scenarios against it', async () => {
            await withTape('safety_refusal', async (mock) => {
                const r = await mock.chat({ messages: [{ role: 'user', content: 'rm -rf /' }] });
                expect(r.content).toMatch(/destructive/i);
            });
        });

        it('throws when the test leaves unused exchanges (catches over-provisioned tapes)', async () => {
            await expect(
                withTape('weather', async (mock) => {
                    // Only consume the first exchange — leave one unused
                    await mock.chat({ messages: [] });
                }),
            ).rejects.toThrow(/unused exchanges/);
        });
    });
});
