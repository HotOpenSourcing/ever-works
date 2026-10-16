import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes, createHash } from 'crypto';
import {
    ApiKeyRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import type { ApiKey, Organization } from '@ever-works/agent/entities';
import {
    INTEGRATION_API_KEY_KIND,
    INTEGRATION_KEY_MAX_ORGANIZATIONS,
    INTEGRATION_KEY_PREFIX,
    INTEGRATION_KEYS_MAX_PER_TENANT,
    integrationActorLabel,
    isIntegrationKind,
    isIntegrationScope,
    type CreateIntegrationKeyRequest,
    type CreateIntegrationKeyResponse,
    type IntegrationKeyOrganization,
    type IntegrationKeySummary,
    type IntegrationKind,
    type IntegrationScope,
} from '@ever-works/contracts';

/**
 * In-process event emitted when an integration key is revoked, so owners of
 * things that hang off a key (webhooks v2 subscriptions, EW-P1-5) can disable
 * them. Payload: {@link IntegrationKeyRevokedEvent}.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INTEGRATION_KEY_REVOKED_EVENT = 'integration-key.revoked';

export interface IntegrationKeyRevokedEvent {
    keyId: string;
    tenantId: string | null;
    revokedByUserId: string;
}

/**
 * EW-P1-2 — creating, listing and revoking integration keys (`ew_int_…`).
 * Validation and rotation live in `ApiKeyService`, shared with personal keys.
 *
 * **Who may create:** the Tenant owner only. Ever Works has no per-Organization
 * admin role yet (`ORGANIZATION_MEMBER_ROLES = ['member']`); when owner/admin
 * roles land (EW-P2-6) they widen {@link assertCanManage}.
 *
 * **Pins:** at least one, at most 50, every one an Organization of the
 * creator's Tenant. **Scopes:** at least one, every one from vocabulary v1;
 * `goals:activate`, `missions:activate` and `ideas:build` do not exist in it,
 * so they can never be granted.
 *
 * **Cap:** 20 active integration keys per Tenant. They do NOT count against
 * the creator's ten personal keys.
 *
 * **Revoke** switches the row off (`isActive = false`) instead of deleting it:
 * the activity rows and webhook subscriptions that point at the key keep a
 * target, and the same `isActive` check that refuses a revoked personal key
 * refuses it immediately.
 */
@Injectable()
export class IntegrationKeyService {
    private readonly logger = new Logger(IntegrationKeyService.name);

    constructor(
        private readonly apiKeys: ApiKeyRepository,
        private readonly tenants: TenantRepository,
        private readonly organizations: OrganizationRepository,
        private readonly users: UserRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    async create(
        userId: string,
        input: CreateIntegrationKeyRequest,
    ): Promise<CreateIntegrationKeyResponse> {
        const tenantId = await this.assertCanManage(userId);

        const scopes = this.normalizeScopes(input.scopes);
        const integrationKind: IntegrationKind = input.integrationKind ?? 'generic';
        if (!isIntegrationKind(integrationKind)) {
            throw new BadRequestException(`Unknown integrationKind: ${String(integrationKind)}`);
        }
        const tenantOrgs = await this.organizations.findByTenantId(tenantId);
        const organizationIds = this.normalizeOrganizationIds(input.organizationIds, tenantOrgs);

        const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
        if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
            throw new BadRequestException('Expiration date must be in the future');
        }

        const active = await this.apiKeys.countActiveIntegrationKeysByTenant(tenantId);
        if (active >= INTEGRATION_KEYS_MAX_PER_TENANT) {
            throw new BadRequestException(
                `Maximum of ${INTEGRATION_KEYS_MAX_PER_TENANT} integration keys allowed per workspace`,
            );
        }

        const rawKey = INTEGRATION_KEY_PREFIX + randomBytes(32).toString('hex');
        const row = await this.apiKeys.create({
            userId,
            name: input.name.trim(),
            hashedKey: createHash('sha256').update(rawKey).digest('hex'),
            prefix: rawKey.substring(0, 12),
            expiresAt,
            kind: INTEGRATION_API_KEY_KIND,
            scopes,
            organizationIds,
            integrationKind,
            description: input.description?.trim() || null,
            tenantId,
            // The pins are the authorization; the scalar column stays NULL so
            // nothing mistakes the key for one bound to a single Organization.
            organizationId: null,
        });

        // The count above and the insert are not one atomic step, so two
        // overlapping creates could both pass it. Re-count with the new row in
        // place and withdraw it when the cap is exceeded: the request fails
        // closed (it never returned a secret), and a retry succeeds once a slot
        // is really free.
        const afterInsert = await this.apiKeys.countActiveIntegrationKeysByTenant(tenantId);
        if (afterInsert > INTEGRATION_KEYS_MAX_PER_TENANT) {
            await this.apiKeys.deleteByIdAndUserId(row.id, userId);
            throw new BadRequestException(
                `Maximum of ${INTEGRATION_KEYS_MAX_PER_TENANT} integration keys allowed per workspace`,
            );
        }

        const summary = this.toSummary(row, tenantOrgs);
        await this.audit(
            userId,
            ActivityActionType.INTEGRATION_KEY_CREATED,
            row,
            'Integration key created',
        );
        return { ...summary, key: rawKey };
    }

    /** The Tenant's active integration keys. Only the Tenant owner sees them. */
    async list(userId: string): Promise<IntegrationKeySummary[]> {
        const tenant = await this.ownedTenant(userId);
        if (!tenant) return [];
        const [rows, orgs] = await Promise.all([
            this.apiKeys.findIntegrationKeysByTenant(tenant.id),
            this.organizations.findByTenantId(tenant.id),
        ]);
        return rows.map((row) => this.toSummary(row, orgs));
    }

    /**
     * Revoke an integration key of the caller's Tenant. Returns `false` when
     * `id` is not an active integration key the caller manages (the controller
     * falls back to the personal-key path, then 404s).
     */
    async revoke(id: string, userId: string): Promise<boolean> {
        // A non-uuid id cannot be a key; answer before a uuid column sees it
        // (Postgres would reject the cast) so the caller's 404 stays a 404.
        if (!UUID_RE.test(id)) return false;
        const row = await this.apiKeys.findByIdAndUserId(id, userId);
        if (!row || row.kind !== INTEGRATION_API_KEY_KIND) return false;
        const deactivated = await this.apiKeys.deactivateById(row.id);
        // Already revoked: the request is handled (idempotent 200). It must
        // NOT fall through to the personal-key delete, which would destroy the
        // row the audit trail and webhook subscriptions point at. The event and
        // the audit row are written only by the revoke that switched it off.
        if (!deactivated) return true;
        const event: IntegrationKeyRevokedEvent = {
            keyId: row.id,
            tenantId: row.tenantId ?? null,
            revokedByUserId: userId,
        };
        this.events?.emit(INTEGRATION_KEY_REVOKED_EVENT, event);
        await this.audit(
            userId,
            ActivityActionType.INTEGRATION_KEY_REVOKED,
            row,
            'Integration key revoked',
        );
        return true;
    }

    /**
     * Record a rotation of an integration key (the rotation itself is
     * `ApiKeyService.rotateKey`). Best-effort end to end, the lookup included:
     * it runs after the new secret is saved, and the caller must still get
     * that secret back whatever happens here.
     */
    async recordRotation(userId: string, keyId: string): Promise<void> {
        if (!UUID_RE.test(keyId)) return;
        try {
            const row = await this.apiKeys.findByIdAndUserId(keyId, userId);
            if (!row || row.kind !== INTEGRATION_API_KEY_KIND) return;
            await this.audit(
                userId,
                ActivityActionType.INTEGRATION_KEY_ROTATED,
                row,
                'Integration key rotated',
            );
        } catch (err) {
            this.logger.warn(
                `Failed to record the rotation of integration key ${keyId}: ${(err as Error).message}`,
            );
        }
    }

    // ── internals ────────────────────────────────────────────────────────

    /** The caller's Tenant id, or 403 when the caller does not own it. */
    private async assertCanManage(userId: string): Promise<string> {
        const tenant = await this.ownedTenant(userId);
        if (!tenant) {
            throw new ForbiddenException(
                'Only the workspace owner can create integration keys. Create an organization first if you have none.',
            );
        }
        return tenant.id;
    }

    private async ownedTenant(userId: string) {
        const user = await this.users.findById(userId);
        if (!user?.tenantId) return null;
        const tenant = await this.tenants.findById(user.tenantId);
        return tenant && tenant.ownerUserId === userId ? tenant : null;
    }

    private normalizeScopes(raw: unknown): IntegrationScope[] {
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new BadRequestException('scopes must list at least one scope');
        }
        const unknownScopes = raw.filter((scope) => !isIntegrationScope(scope));
        if (unknownScopes.length > 0) {
            throw new BadRequestException(
                `Unknown or non-grantable scopes: ${unknownScopes.join(', ')}`,
            );
        }
        return [...new Set(raw as IntegrationScope[])];
    }

    private normalizeOrganizationIds(raw: unknown, tenantOrgs: Organization[]): string[] {
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new BadRequestException(
                'organizationIds must pin the key to at least one organization',
            );
        }
        const ids = [...new Set(raw.filter((id): id is string => typeof id === 'string'))];
        if (ids.length > INTEGRATION_KEY_MAX_ORGANIZATIONS) {
            throw new BadRequestException(
                `A key may be pinned to at most ${INTEGRATION_KEY_MAX_ORGANIZATIONS} organizations`,
            );
        }
        const owned = new Set(tenantOrgs.map((org) => org.id));
        const foreign = ids.filter((id) => !owned.has(id));
        if (foreign.length > 0 || ids.length !== raw.length) {
            // Same answer for "missing" and "someone else's": no existence leak.
            throw new BadRequestException(
                'organizationIds must be organizations of your workspace',
            );
        }
        return ids;
    }

    private toSummary(row: ApiKey, tenantOrgs: Organization[]): IntegrationKeySummary {
        const pins = Array.isArray(row.organizationIds) ? row.organizationIds : [];
        const byId = new Map(tenantOrgs.map((org) => [org.id, org]));
        const organizations: IntegrationKeyOrganization[] = pins
            .map((id) => byId.get(id))
            .filter((org): org is Organization => !!org)
            .map((org) => ({ id: org.id, slug: org.slug, displayName: org.displayName }));
        return {
            id: row.id,
            name: row.name,
            description: row.description ?? null,
            prefix: row.prefix,
            kind: INTEGRATION_API_KEY_KIND,
            integrationKind: isIntegrationKind(row.integrationKind)
                ? row.integrationKind
                : 'generic',
            scopes: (Array.isArray(row.scopes) ? row.scopes : []).filter(isIntegrationScope),
            organizationIds: pins,
            organizations,
            createdByUserId: row.userId,
            createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
            lastUsedAt: toIso(row.lastUsedAt),
            expiresAt: toIso(row.expiresAt),
            rotatedAt: toIso(row.rotatedAt),
            previousKeyGraceUntil: toIso(row.previousKeyGraceUntil),
        };
    }

    private async audit(
        userId: string,
        actionType: ActivityActionType,
        row: ApiKey,
        summary: string,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                actionType,
                action: actionType,
                status: ActivityStatus.COMPLETED,
                summary: `${summary}: ${integrationActorLabel(row.integrationKind, row.name)}`,
                details: {
                    resourceType: 'integration_key',
                    resourceId: row.id,
                    keyId: row.id,
                    name: row.name,
                    prefix: row.prefix,
                    integrationKind: row.integrationKind ?? null,
                    scopes: row.scopes ?? [],
                    organizationIds: row.organizationIds ?? [],
                },
                actorKind: 'user',
                tenantId: row.tenantId ?? null,
                organizationId: null,
            });
        } catch (err) {
            // Audit is best-effort here: the key operation already happened.
            this.logger.warn(
                `Failed to write ${actionType} activity row: ${(err as Error).message}`,
            );
        }
    }
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
