/**
 * QA guard (found in the v8.0.0 user-journey pass): `titan --version` told a
 * brand-new v8 user they had 7.2.2, because TITAN_VERSION lives in
 * constants.ts while the real version lives in package.json. This test
 * pins them together so the drift class is extinct.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { TITAN_VERSION } from '../src/utils/constants.js';

describe('version consistency', () => {
    it('TITAN_VERSION matches package.json', () => {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
        expect(TITAN_VERSION).toBe(pkg.version);
    });
});
