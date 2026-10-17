import { appLicenseAttestationTextFor, spdxLicenseIds } from '../app-license-attestation-text';

/**
 * The text the attestation dialog shows must be the text the attest route
 * hashes: the registry row of the most restrictive id, else `unknown`'s.
 */
describe('appLicenseAttestationTextFor', () => {
    it('reads the registry text of an amber licence', () => {
        expect(appLicenseAttestationTextFor('BUSL-1.1')?.textId).toBe('busl-1.1-v1');
    });

    it('takes the most restrictive id of a compound expression', () => {
        expect(appLicenseAttestationTextFor('BUSL-1.1 OR PolyForm-Noncommercial-1.0.0')?.textId).toBe(
            'polyform-noncommercial-v1',
        );
    });

    it('falls back to the unknown-licence text for no licence or an unlisted one', () => {
        expect(appLicenseAttestationTextFor(null)?.textId).toBe('unknown-license-v1');
        expect(appLicenseAttestationTextFor('')?.textId).toBe('unknown-license-v1');
        expect(appLicenseAttestationTextFor('LicenseRef-Proprietary')?.textId).toBe('unknown-license-v1');
    });

    it('matches ids case-insensitively', () => {
        expect(appLicenseAttestationTextFor('busl-1.1')?.textId).toBe('busl-1.1-v1');
    });
});

describe('spdxLicenseIds', () => {
    it('drops operators and parentheses', () => {
        expect(spdxLicenseIds('(MIT OR Apache-2.0) AND GPL-2.0-only WITH Classpath-exception-2.0')).toEqual([
            'MIT',
            'Apache-2.0',
            'GPL-2.0-only',
            'Classpath-exception-2.0',
        ]);
        expect(spdxLicenseIds(undefined)).toEqual([]);
    });
});
