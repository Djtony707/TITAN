import { describe, expect, it } from 'vitest';
import { blockToAction, extractExecutionBlocks } from '../../ui/src/titan2/agent/protocol';

describe('titan2 agent protocol actions', () => {
    it('maps react gates to render_widget actions', () => {
        const [block] = extractExecutionBlocks('Building it.\n_____react\nfunction Weather() { return <div>72°F</div>; }');
        expect(block.gate).toBe('_____react');
        expect(block.action).toEqual({
            type: 'render_widget',
            widget: {
                format: 'react',
                source: 'function Weather() { return <div>72°F</div>; }',
            },
        });
    });

    it('maps widget update payloads to update_widget actions', () => {
        const action = blockToAction({
            gate: '_____widget',
            code: JSON.stringify({ id: 'widget_123', source: 'function Widget() { return <div>Updated</div>; }', name: 'Updated Widget' }),
            leadingText: '',
        });

        expect(action).toEqual({
            type: 'update_widget',
            widgetId: 'widget_123',
            patch: {
                source: 'function Widget() { return <div>Updated</div>; }',
                name: 'Updated Widget',
            },
        });
    });

    it('maps raw widget code to render_widget actions', () => {
        const action = blockToAction({
            gate: '_____widget',
            code: 'function Widget() { return <div>Hello</div>; }',
            leadingText: '',
        });

        expect(action).toEqual({
            type: 'render_widget',
            widget: {
                format: 'react',
                source: 'function Widget() { return <div>Hello</div>; }',
            },
        });
    });
});