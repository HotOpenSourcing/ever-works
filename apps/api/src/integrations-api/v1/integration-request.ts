import type { AuthenticatedUser, IntegrationPrincipal } from '../../auth/types/auth.types';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import { InvalidCursorError } from '@ever-works/agent/integrations-api';

/**
 * Request helpers of `/api/integrations/v1` (EW-P1-4). The guards
 * (`IntegrationOnlyGuard`, `IntegrationPrincipalGuard`) have already
 * authenticated the key, checked its scopes and resolved the pinned
 * organization into the request's ownership scope.
 */

/** The integration principal of the request (`401 invalid_key` when absent). */
export function principalOf(user: AuthenticatedUser | undefined): IntegrationPrincipal {
    const principal = user?.integration;
    if (!principal) {
        throw new IntegrationHttpException(401, 'invalid_key', 'Invalid integration key.');
    }
    return principal;
}

/** The pinned organization the request acts in (`403 org_not_pinned` when none). */
export function pinnedOrganizationOf(organizationId: string | null | undefined): string {
    if (!organizationId) {
        throw new IntegrationHttpException(
            403,
            'org_not_pinned',
            'Name one of the organizations this key is pinned to in X-Scope-Slug (or X-Organization-Id).',
        );
    }
    return organizationId;
}

/**
 * The `externalLinks` / `links` source of the key: `ever-gauzy` keys link as
 * `gauzy` (contract v1: the link `source` comes from the key's integrationKind).
 */
export function linkSourceOf(principal: IntegrationPrincipal): string {
    return principal.integrationKind === 'ever-gauzy'
        ? 'gauzy'
        : principal.integrationKind || 'generic';
}

/** `?updatedSince=<ISO>` → Date (`400 validation_failed` when not a date). */
export function parseUpdatedSince(value: string | undefined): Date | null {
    if (value === undefined || value === '') return null;
    const time = Date.parse(value);
    if (!Number.isFinite(time))
        throw validationFailed('updatedSince', 'must be an ISO 8601 date-time');
    return new Date(time);
}

/** `?limit=` → number | undefined (`400 validation_failed` when not an integer). */
export function parseLimit(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    if (!/^\d{1,6}$/.test(value)) throw validationFailed('limit', 'must be a positive integer');
    return Number(value);
}

/** Comma-separated or repeated query values, trimmed, empties dropped. */
export function listParam(value: string | string[] | undefined): string[] {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return values
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

export function validationFailed(path: string, message: string): IntegrationHttpException {
    return new IntegrationHttpException(400, 'validation_failed', `${path} ${message}`, {
        fields: [{ path, message }],
    });
}

/** Re-throws {@link InvalidCursorError} as `400 validation_failed` on `cursor`. */
export function rethrowCursor(error: unknown): never {
    if (error instanceof InvalidCursorError) throw validationFailed('cursor', error.message);
    throw error;
}
