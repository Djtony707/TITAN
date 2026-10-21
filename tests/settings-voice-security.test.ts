import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Script } from 'vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';

// Execute the exact UI save callback with synthetic masked config; no browser, owner config or API request.
function saveHandler(config: unknown) {
    const filename = join(process.cwd(), 'ui/src/components/admin/SettingsPanel.tsx');
    const source = readFileSync(filename, 'utf8');
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleSave') callback = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!callback) throw new Error('Settings save callback missing');
    const updateConfig = vi.fn(async () => ({ voice: { enabled: false } }));
    const context = { config, voiceEnabled: false, livekitUrl: 'ws://127.0.0.1:7880', ttsVoice: 'andrew', ttsEngine: 'f5-tts', ttsUrl: 'http://localhost:5006',
        updateConfig, setSaving: vi.fn(), setConfig: vi.fn(), showToast: vi.fn(), checkVoiceServices: vi.fn() };
    const compiled = transformSync(`(${callback.getText(ast)})`, { loader: 'ts', target: 'node22' }).code;
    return { handler: new Script(compiled).runInNewContext(context) as () => Promise<void>, updateConfig, context };
}

describe('settings voice save preserves private credentials', () => {
    it.each([{ voice: { sttUrl: 'http://localhost:48421', agentUrl: 'http://localhost:8081' } },
        { voice: { livekitApiKey: 'synthetic_private_key', livekitApiSecret: 'synthetic_private_secret_0123456789abcdef' } }])('saves editable voice fields without sending either hidden credential', async config => {
        const { handler, updateConfig, context } = saveHandler(config);
        await handler();
        expect(updateConfig).toHaveBeenCalledOnce();
        const payload = updateConfig.mock.calls[0][0] as any;
        expect(payload.voice).not.toHaveProperty('livekitApiKey');
        expect(payload.voice).not.toHaveProperty('livekitApiSecret');
        expect(payload.voice.enabled).toBe(false);
        expect(payload.voice.ttsEngine).toBe('f5-tts');
        expect(payload.voice.ttsUrl).toBe('http://localhost:5006');
        expect(context.showToast).toHaveBeenCalledWith('success', 'Settings saved');
    });
});
