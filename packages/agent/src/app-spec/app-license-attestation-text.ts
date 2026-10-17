/**
 * The attestation text an App Work's owner is asked to confirm, for the web's
 * attestation dialog (APW-03 T44 / APW-06 T37, R-3).
 *
 * The attest route (`POST /api/works/:id/app-license/attest`, lane aw-catalog)
 * records `textId` / `textSha256` from the registry text of the CURRENT
 * classification; the dialog must show that same text before the owner
 * confirms, so the read side resolves it with the same rule:
 *
 *  - every license id in the SPDX expression is looked up in the bundled
 *    registry snapshot, and the row with the most restrictive class wins
 *    (`LICENSE_CLASS_RANK`), so an `MIT OR AGPL-3.0` reads the AGPL text;
 *  - an expression with no registry row — or no license at all — reads the
 *    registry's `unknown` text.
 *
 * Kept as a pure function in this barrel (rather than in `app-license/`) so the
 * API can import it through the existing `@ever-works/agent/app-spec` subpath.
 * It mirrors `attestationTextFor` in `app-license/app-license.service.ts`
 * (aw-catalog); once both are on one branch, that service should call this.
 */

import { LICENSE_CLASS_RANK, type LicenseClass } from '@ever-works/contracts';
import {
    LICENSE_REGISTRY_SNAPSHOT,
    type LicenseRegistryAttestation,
} from '../app-license/license-registry.snapshot';

/** The attestation text for one licence; re-exported shape so callers need no deep import. */
export type AppLicenseAttestationText = LicenseRegistryAttestation;

/** The bare license ids of an SPDX expression (`AND` / `OR` / `WITH` and parentheses dropped). */
export function spdxLicenseIds(spdx: string | null | undefined): string[] {
    if (typeof spdx !== 'string' || spdx.trim() === '') return [];
    return spdx
        .replace(/[()]/g, ' ')
        .split(/\s+/)
        .filter((token) => token !== '' && !/^(AND|OR|WITH)$/i.test(token));
}

/** The registry text the owner attests for this classification, or `null` when the registry has none. */
export function appLicenseAttestationTextFor(spdx: string | null | undefined): AppLicenseAttestationText | null {
    let best: { rank: number; attestation: LicenseRegistryAttestation } | null = null;
    for (const id of spdxLicenseIds(spdx)) {
        const row = LICENSE_REGISTRY_SNAPSHOT.licenses.find(
            (license) => license.spdx.toLowerCase() === id.toLowerCase(),
        );
        if (!row?.attestation) continue;
        const rank = LICENSE_CLASS_RANK[row.class as LicenseClass] ?? 0;
        if (!best || rank > best.rank) best = { rank, attestation: row.attestation };
    }
    return best?.attestation ?? LICENSE_REGISTRY_SNAPSHOT.unknown?.attestation ?? null;
}
