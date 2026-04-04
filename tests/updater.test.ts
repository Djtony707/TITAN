import { describe, it, expect, vi, afterEach } from 'vitest';
import { getUpdateInfo, checkForUpdates } from '../src/utils/updater.js';
import { TITAN_VERSION } from '../src/utils/constants.js';

describe('Updater utility', () => {
    it('getUpdateInfo should return the current version and correct boolean', async () => {
        const info = await getUpdateInfo();
        expect(info).toHaveProperty('current');
        expect(info.current).toBe(TITAN_VERSION);
        expect(info).toHaveProperty('latest');
        expect(info).toHaveProperty('isNewer');
        if (info.latest === null) {
            expect(info.isNewer).toBe(false);
        }
    });

    describe('getUpdateInfo with mocked fetch', () => {
        afterEach(() => vi.restoreAllMocks());

        it('returns isNewer=true when registry has newer version', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ version: '9999.99.99' }), { status: 200 }),
            );
            const info = await getUpdateInfo();
            expect(info.current).toBe(TITAN_VERSION);
            expect(info.latest).toBe('9999.99.99');
            expect(info.isNewer).toBe(true);
        });

        it('returns isNewer=false when current is newer than registry', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ version: '0.9.0' }), { status: 200 }),
            );
            const info = await getUpdateInfo();
            expect(info.isNewer).toBe(false);
        });

        it('returns isNewer=false when versions are equal', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ version: TITAN_VERSION }), { status: 200 }),
            );
            const info = await getUpdateInfo();
            expect(info.isNewer).toBe(false);
            expect(info.latest).toBe(TITAN_VERSION);
        });

        it('returns null latest when fetch fails', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
            const info = await getUpdateInfo();
            expect(info.latest).toBeNull();
            expect(info.isNewer).toBe(false);
        });

        it('returns null latest when response is not ok', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response('Not Found', { status: 404 }),
            );
            const info = await getUpdateInfo();
            expect(info.latest).toBeNull();
            expect(info.isNewer).toBe(false);
        });

        it('returns null latest when version is missing from response', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({}), { status: 200 }),
            );
            const info = await getUpdateInfo();
            expect(info.latest).toBeNull();
            expect(info.isNewer).toBe(false);
        });
    });

    describe('checkForUpdates', () => {
        afterEach(() => vi.restoreAllMocks());

        it('prints update box when newer version available', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ version: '9999.99.99' }), { status: 200 }),
            );
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await checkForUpdates();
            expect(consoleSpy).toHaveBeenCalled();
            const output = consoleSpy.mock.calls[0][0];
            expect(output).toContain('Update available');
        });

        it('prints nothing when up to date', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ version: TITAN_VERSION }), { status: 200 }),
            );
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await checkForUpdates();
            expect(consoleSpy).not.toHaveBeenCalled();
        });

        it('prints nothing when fetch fails', async () => {
            vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            await checkForUpdates();
            expect(consoleSpy).not.toHaveBeenCalled();
        });
    });
});
