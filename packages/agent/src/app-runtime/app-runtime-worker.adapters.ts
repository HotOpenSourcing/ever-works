/**
 * APW-06 T71 / T73 / T44 / T28 / T29 (A0.7, 2026-10-17) — **the real implementations behind the
 * isolated App runtime worker's remaining ports**.
 *
 * `TriggerAppRuntimeModule` bound the §6.4 ports to `default-ports.ts`'s fail-closed classes and
 * left eight seams unbound, so every dequeued Deployment stopped before it reached the cluster.
 * Each class below is the narrow, real answer for one of those seams. They live in the agent
 * package (not in `packages/tasks`) so the API-side halves sit beside the worker-side halves and a
 * spec can construct them without a Nest context.
 *
 * | Class | Token | Process |
 * | --- | --- | --- |
 * | {@link ConfigAppsTierPolicy} | `APPS_TIER_POLICY` | worker + API |
 * | {@link AppBuildPullCredentialSource} | `APP_IMAGE_PULL_CREDENTIAL_SOURCE` | worker |
 * | {@link AppRuntimeTargetAdapter} | `APP_RUNTIME_TARGET` | worker |
 * | {@link AppRuntimeNotificationProducersAdapter} | `APP_RUNTIME_NOTIFICATIONS` | worker (writes via the proxied `NotificationService`) |
 * | {@link PublicGitHubCommitAncestry} | `APP_COMMIT_ANCESTRY` | worker |
 * | {@link AppRuntimeEventRelayService} | — (the API end of `APP_RUNTIME_EVENT_SINK`) | API |
 * | {@link AppDeployDispatchRelay} | — (the API end of the worker's `APP_DEPLOY_DISPATCHER`) | API |
 *
 * None of them holds a credential longer than one call, and none logs one.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppLimitRangeInput, AppQuotaInput, AppTargetRef } from '@ever-works/plugin';

import { NotificationCategory, NotificationType } from '../entities/notification.types';
import type { AppDeployBuildSource } from './app-deploy-preconditions.service';
import { APP_DEPLOY_DISPATCHER } from './app-deploy-request.service';
import { APP_CLUSTER_OP_DISPATCHER } from './app-runtime-deletion.service';
import type {
    AppCommitAncestry,
    AppDeployOrchestratorDispatcher,
    AppRuntimeNotificationProducers,
} from './app-deploy.orchestrator';
import { parseBearerChallenge, parseImageReference } from './app-image-reference.resolver';
import {
    AppPortUnavailableError,
    type AppImagePullCredentialSource,
    type AppRuntimeEventSink,
    type AppRuntimeTargetPort,
    type AppRuntimeTargetUnavailable,
    type AppsTierPolicy,
} from './ports';
import { DisabledAppsTierPolicy } from './default-ports';
import { isAppClusterWorkerContext } from './worker-context';

/* -------------------------------------------------------------------------- *
 * APPS_TIER_POLICY — APW-10's minimal policy (T44)
 * -------------------------------------------------------------------------- */

/** The env switch that opens the managed **Ever Works Apps** target (default off). */
export const APPS_MANAGED_ENABLED_ENV = 'EVER_WORKS_APPS_MANAGED_ENABLED';

// APW-10 lite (2026-10-17, lane aw-managed-deps): sized for the App AND its in-namespace
// dependencies — Postgres (10Gi), Redis (1Gi) and object storage (20Gi) by default, each with
// the LimitRange's 1-CPU default limit when it declares none — so a typical App with all three
// fits. Every number is an operator override (`managedQuotaFromEnv`).
const MANAGED_QUOTA: AppQuotaInput = {
    'requests.cpu': '2',
    'limits.cpu': '8',
    'requests.memory': '4Gi',
    'limits.memory': '10Gi',
    pods: 20,
    persistentvolumeclaims: 8,
    'requests.storage': '50Gi',
    'services.loadbalancers': 0,
    'services.nodeports': 0,
    'count/jobs.batch': 20,
    'count/cronjobs.batch': 20,
    secrets: 30,
    configmaps: 30,
};

const MANAGED_LIMIT_RANGE: AppLimitRangeInput = {
    defaultRequest: { cpu: '100m', memory: '128Mi' },
    defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
    max: { cpu: '2', memory: '4Gi' },
};

/**
 * The minimal APW-10 policy: the managed target is **closed** unless
 * `EVER_WORKS_APPS_MANAGED_ENABLED=true`, and closed it behaves exactly like
 * `DisabledAppsTierPolicy` (so every consumer answers the existing `managed_disabled` /
 * `tier_closed` codes). Open, it reads the rest of its policy from the environment of the process
 * that hosts it — the operator's own managed cluster:
 *
 * - `EVER_WORKS_APPS_MANAGED_KUBECONFIG` (**secret**) — the control-namespace credential;
 * - `EVER_WORKS_APPS_MANAGED_RUNTIME_CLASS` — the sandbox runtime class (unset ⇒ R-24's
 *   `managed_sandbox_unavailable`);
 * - `EVER_WORKS_APPS_MANAGED_INGRESS_CLASS` / `…_INGRESS_NAMESPACE` (default `nginx` / `ingress-nginx`);
 * - `EVER_WORKS_APPS_MANAGED_SCOPE` — `verified-blueprints`, or the default `any` (APW-10 lite,
 *   2026-10-17: the licence rule — green only, amber/red/unknown refused even when attested — is
 *   what admits an app; `verified-blueprints` is the operator's opt-in narrowing);
 * - `EVER_WORKS_APPS_MANAGED_QUOTA_*` / `EVER_WORKS_APPS_MANAGED_LIMIT_*` — override the
 *   per-namespace ResourceQuota / LimitRange defaults below (see `managedQuotaFromEnv`).
 *
 * **The kubeconfig is read only inside the isolated App runtime worker** (APW-10 lite): in any
 * other process {@link resolveClusterCredential} refuses `cluster_credential_unavailable` before
 * the variable is touched, so the API never holds it. It may be the YAML itself or its base64
 * (`EVER_WORKS_APPS_MANAGED_KUBECONFIG` is documented as base64, the form a Secret carries), and
 * it is never logged or echoed.
 *
 * Read at call time, never cached, so flipping the switch needs no redeploy of the code.
 */
export class ConfigAppsTierPolicy implements AppsTierPolicy {
    private readonly closed = new DisabledAppsTierPolicy();

    constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

    isOpen(): boolean {
        return this.env[APPS_MANAGED_ENABLED_ENV] === 'true';
    }

    managedScope(): 'verified-blueprints' | 'any' {
        if (!this.isOpen()) return 'verified-blueprints';
        return this.env.EVER_WORKS_APPS_MANAGED_SCOPE === 'verified-blueprints'
            ? 'verified-blueprints'
            : 'any';
    }

    async resolveClusterCredential(workId: string): Promise<string> {
        if (!this.isOpen()) return this.closed.resolveClusterCredential(workId);

        if (!this.workerOnly()) {
            throw new AppPortUnavailableError(
                'cluster_credential_unavailable',
                'The Ever Works Apps cluster credential is read only inside the isolated App runtime worker.',
                workId,
            );
        }

        const credential = decodeKubeconfig(this.env.EVER_WORKS_APPS_MANAGED_KUBECONFIG ?? '');
        if (!credential) {
            throw new AppPortUnavailableError(
                'cluster_credential_unavailable',
                'Ever Works Apps is open but EVER_WORKS_APPS_MANAGED_KUBECONFIG is not set or not a kubeconfig.',
                workId,
            );
        }
        return credential;
    }

    /** Overridable for specs; production answers whether this process is the isolated worker. */
    protected workerOnly(): boolean {
        return isAppClusterWorkerContext();
    }

    podPolicy(): {
        runtimeClassName: string | null;
        quota: AppQuotaInput;
        limitRange: AppLimitRangeInput;
    } {
        if (!this.isOpen()) return this.closed.podPolicy();

        const runtimeClassName = (this.env.EVER_WORKS_APPS_MANAGED_RUNTIME_CLASS ?? '').trim();
        return {
            runtimeClassName: runtimeClassName || null,
            quota: managedQuotaFromEnv(this.env),
            limitRange: managedLimitRangeFromEnv(this.env),
        };
    }

    ingress(): { className: string; controllerNamespace: string; edgeTlsMode: 'edge' } {
        if (!this.isOpen()) return this.closed.ingress();

        return {
            className: (this.env.EVER_WORKS_APPS_MANAGED_INGRESS_CLASS ?? '').trim() || 'nginx',
            controllerNamespace:
                (this.env.EVER_WORKS_APPS_MANAGED_INGRESS_NAMESPACE ?? '').trim() ||
                'ingress-nginx',
            edgeTlsMode: 'edge',
        };
    }

    async eligibility(userId: string): Promise<{ eligible: boolean; reasons: string[] }> {
        if (!this.isOpen()) return this.closed.eligibility(userId);
        return { eligible: true, reasons: [] };
    }
}

/** Does this text look like a kubeconfig document? */
const KUBECONFIG_KEY = /^\s*(apiVersion|kind|clusters|contexts|current-context|users)\s*:/m;

/**
 * The managed kubeconfig as YAML: the value itself when it already is YAML, else its base64
 * decoding. Empty or undecodable answers `''`. Never logged.
 */
export function decodeKubeconfig(raw: string): string {
    const value = (raw ?? '').trim();
    if (!value) return '';
    if (KUBECONFIG_KEY.test(value)) return value;
    try {
        const decoded = Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf-8').trim();
        return KUBECONFIG_KEY.test(decoded) ? decoded : '';
    } catch {
        return '';
    }
}

/** A Kubernetes quantity (`2`, `500m`, `4Gi`) — what an override must look like to be used. */
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$/;

function quantity(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
    const value = (env[name] ?? '').trim();
    return QUANTITY.test(value) ? value : fallback;
}

function count(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const raw = (env[name] ?? '').trim();
    const value = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isInteger(value) ? value : fallback;
}

/**
 * The per-namespace ResourceQuota, with operator overrides —
 * `EVER_WORKS_APPS_MANAGED_QUOTA_{CPU_REQUESTS,CPU_LIMITS,MEMORY_REQUESTS,MEMORY_LIMITS,STORAGE,PODS,PVCS}`.
 * A malformed value is ignored (the default stands) rather than rendered.
 */
export function managedQuotaFromEnv(env: NodeJS.ProcessEnv = process.env): AppQuotaInput {
    const base = MANAGED_QUOTA as unknown as Record<string, string | number>;
    return {
        ...MANAGED_QUOTA,
        'requests.cpu': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_CPU_REQUESTS',
            String(base['requests.cpu']),
        ),
        'limits.cpu': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_CPU_LIMITS',
            String(base['limits.cpu']),
        ),
        'requests.memory': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_MEMORY_REQUESTS',
            String(base['requests.memory']),
        ),
        'limits.memory': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_MEMORY_LIMITS',
            String(base['limits.memory']),
        ),
        'requests.storage': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_STORAGE',
            String(base['requests.storage']),
        ),
        pods: count(env, 'EVER_WORKS_APPS_MANAGED_QUOTA_PODS', Number(base.pods)),
        persistentvolumeclaims: count(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_PVCS',
            Number(base.persistentvolumeclaims),
        ),
    } as AppQuotaInput;
}

/**
 * The per-namespace LimitRange, with operator overrides —
 * `EVER_WORKS_APPS_MANAGED_LIMIT_{REQUEST_CPU,REQUEST_MEMORY,DEFAULT_CPU,DEFAULT_MEMORY,MAX_CPU,MAX_MEMORY}`.
 */
export function managedLimitRangeFromEnv(env: NodeJS.ProcessEnv = process.env): AppLimitRangeInput {
    const base = MANAGED_LIMIT_RANGE as {
        defaultRequest: Record<string, string>;
        defaultLimit: Record<string, string>;
        max: Record<string, string>;
    };
    return {
        defaultRequest: {
            ...base.defaultRequest,
            cpu: quantity(
                env,
                'EVER_WORKS_APPS_MANAGED_LIMIT_REQUEST_CPU',
                base.defaultRequest.cpu,
            ),
            memory: quantity(
                env,
                'EVER_WORKS_APPS_MANAGED_LIMIT_REQUEST_MEMORY',
                base.defaultRequest.memory,
            ),
        },
        defaultLimit: {
            ...base.defaultLimit,
            cpu: quantity(env, 'EVER_WORKS_APPS_MANAGED_LIMIT_DEFAULT_CPU', base.defaultLimit.cpu),
            memory: quantity(
                env,
                'EVER_WORKS_APPS_MANAGED_LIMIT_DEFAULT_MEMORY',
                base.defaultLimit.memory,
            ),
        },
        max: {
            ...base.max,
            cpu: quantity(env, 'EVER_WORKS_APPS_MANAGED_LIMIT_MAX_CPU', base.max.cpu),
            memory: quantity(env, 'EVER_WORKS_APPS_MANAGED_LIMIT_MAX_MEMORY', base.max.memory),
        },
    } as AppLimitRangeInput;
}

/* -------------------------------------------------------------------------- *
 * APP_IMAGE_PULL_CREDENTIAL_SOURCE — a Build's image (T73)
 * -------------------------------------------------------------------------- */

/** The Work facts the pull-credential source reads. */
export interface AppPullCredentialWorkView {
    id: string;
    userId?: string | null;
    gitProvider?: string | null;
    owner?: string | null;
}

/** `GitFacadeService.getAccessToken`, as far as this source reads it. */
export interface AppPullCredentialGitTokens {
    getAccessToken(options: {
        userId: string;
        providerId: string;
        workId?: string;
    }): Promise<string | null>;
}

type FetchLike = (
    input: string,
    init?: Record<string, unknown>,
) => Promise<{
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
}>;

/**
 * The pull credential of a **Build's** image (APW-05 pushes it to
 * `ghcr.io/<owner>/<repo>/ever-works-app`).
 *
 * 1. The image is probed anonymously (the registry's own token dance, the same as T72's
 *    resolver). Pullable without a credential ⇒ `null` — "a public image", and nothing is
 *    written to the cluster.
 * 2. Otherwise, for `ghcr.io`, the App Work owner's git access token (the GitHub App
 *    installation token when the Work is linked, else the member's connected account) is the
 *    read credential — the only per-Work credential the platform holds for that package today.
 *    Logged by name only.
 * 3. Anything else refuses with `pull_credential_unavailable`, which the render-input builder
 *    turns into the precondition of the same name.
 */
export class AppBuildPullCredentialSource implements AppImagePullCredentialSource {
    private readonly logger = new Logger(AppBuildPullCredentialSource.name);

    constructor(
        private readonly builds: AppDeployBuildSource | undefined,
        private readonly works:
            | { findById(id: string): Promise<AppPullCredentialWorkView | null> }
            | undefined,
        private readonly git: AppPullCredentialGitTokens | undefined,
        private readonly fetchImpl?: FetchLike,
        // Lane aw-deploy-3 — APW-05 T17's stored, read-only registry pull token (preferred).
        private readonly storedTokens?: {
            read(workId: string): Promise<{ token: string; username?: string | null } | null>;
        },
    ) {}

    /**
     * Which credential the last `resolve` used for a Work: `public` (none), `pull-token` (APW-05's
     * stored token) or `owner-token` (the fallback). The render-input builder reads it and records
     * the warning `pull_credential_owner_token` on the Deployment when the fallback was used.
     */
    readonly lastSource = new Map<string, 'public' | 'pull-token' | 'owner-token'>();

    async resolve(
        workId: string,
        buildId: string,
    ): Promise<{ server: string; username: string; password: string } | null> {
        const build = this.builds ? await this.builds.getBuild(workId, buildId) : null;
        const reference = typeof build?.imageReference === 'string' ? build.imageReference : '';
        const parsed = parseImageReference(reference);
        if (!parsed) {
            throw new AppPortUnavailableError(
                'pull_credential_unavailable',
                `Build ${buildId} names no pullable image reference.`,
                `${workId}:${buildId}`,
            );
        }

        if (
            await this.isPublic(
                parsed.registry,
                parsed.repository,
                parsed.tag ?? parsed.digest ?? 'latest',
            )
        ) {
            this.lastSource.set(workId, 'public');
            return null;
        }

        // Lane aw-deploy-3 — the owner's stored read-only pull token wins (APW-05 T17, §4.12): it
        // is scoped to the image, where the GitHub token is the member's whole account.
        const stored = this.storedTokens?.read
            ? await this.storedTokens.read(workId).catch(() => null)
            : null;
        if (stored?.token) {
            const owner = this.works ? await this.works.findById(workId).catch(() => null) : null;
            this.lastSource.set(workId, 'pull-token');
            this.logger.log(
                `App Work ${workId}: pulling the private Build image with the stored pull token.`,
            );
            return {
                server: parsed.registry,
                username:
                    (stored.username && String(stored.username)) ||
                    (owner?.owner && String(owner.owner)) ||
                    parsed.repository.split('/')[0] ||
                    'x-access-token',
                password: stored.token,
            };
        }

        if (parsed.registry !== 'ghcr.io') {
            throw new AppPortUnavailableError(
                'pull_credential_unavailable',
                `No pull credential is known for the registry ${parsed.registry}.`,
                `${workId}:${buildId}`,
            );
        }

        const work = this.works ? await this.works.findById(workId) : null;
        const userId = work?.userId ? String(work.userId) : '';
        const token =
            userId && this.git
                ? await this.git.getAccessToken({
                      userId,
                      providerId: work?.gitProvider ? String(work.gitProvider) : 'github',
                      workId,
                  })
                : null;

        if (!token) {
            throw new AppPortUnavailableError(
                'pull_credential_unavailable',
                `The image of Build ${buildId} is private and the App Work owner has no usable GitHub token.`,
                `${workId}:${buildId}`,
            );
        }

        this.lastSource.set(workId, 'owner-token');
        this.logger.warn(
            `App Work ${workId}: no pull token is stored, so the private Build image is pulled with the owner's GitHub token (name only).`,
        );
        return {
            server: 'ghcr.io',
            username:
                (work?.owner && String(work.owner)) ||
                parsed.repository.split('/')[0] ||
                'x-access-token',
            password: token,
        };
    }

    /** One anonymous manifest `HEAD` (with the anonymous-token retry); any failure ⇒ "not public". */
    private async isPublic(registry: string, repository: string, ref: string): Promise<boolean> {
        const fetchImpl: FetchLike =
            this.fetchImpl ?? ((globalThis as unknown as { fetch: FetchLike }).fetch as FetchLike);
        const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry;
        const url = `https://${host}/v2/${repository}/manifests/${ref}`;
        const accept =
            'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, ' +
            'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';

        try {
            let answer = await fetchImpl(url, { method: 'HEAD', headers: { Accept: accept } });
            if (answer.status === 401) {
                const challenge = parseBearerChallenge(answer.headers.get('www-authenticate'));
                if (!challenge) return false;
                const query = new URLSearchParams();
                if (challenge.service) query.set('service', challenge.service);
                query.set('scope', challenge.scope || `repository:${repository}:pull`);
                const tokenAnswer = (await fetchImpl(`${challenge.realm}?${query.toString()}`, {
                    method: 'GET',
                })) as Awaited<ReturnType<FetchLike>> & { json?: () => Promise<unknown> };
                if (!tokenAnswer.ok || typeof tokenAnswer.json !== 'function') return false;
                const body = (await tokenAnswer.json().catch(() => null)) as {
                    token?: string;
                } | null;
                if (!body?.token) return false;
                answer = await fetchImpl(url, {
                    method: 'HEAD',
                    headers: { Accept: accept, Authorization: `Bearer ${body.token}` },
                });
            }
            return answer.ok;
        } catch {
            return false;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * APP_RUNTIME_TARGET — the dependency target (T73, §9.9)
 * -------------------------------------------------------------------------- */

/** `AppRuntimeFacadeService.resolveClusterAccess`, as far as this adapter reads it. */
export interface AppRuntimeTargetAccessSource {
    resolveClusterAccess(workId: string): Promise<
        | {
              outcome: 'access';
              access: { ref: AppTargetRef; credential: string; plugin: unknown };
          }
        | { outcome: 'refused'; refusal: string }
    >;
}

/** The labels every App pod carries (`packages/plugins/k8s/src/app/app-names.ts` `appLabels`). */
export function appDependencyPodLabels(workId: string): Record<string, string> {
    return { 'ever-works.io/work-id': String(workId), 'ever-works.io/kind': 'app' };
}

/** The limit range a dependency namespace gets on Your cluster (the renderer's default). */
const DEPENDENCY_NAMESPACE_LIMIT_RANGE: AppLimitRangeInput = {
    defaultRequest: { cpu: '100m', memory: '128Mi' },
    defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
    max: { cpu: '2', memory: '4Gi' },
};

/**
 * §9.9's `prepareDependencyTarget`: the App Work's cluster access through T20's facade (the one
 * place a credential is assembled), then the plugin's `prepareAppNamespace` so APW-07's provider
 * is handed a namespace whose baseline policies already exist — which is what breaks the
 * namespace↔dependency ordering cycle (GAP-06). Resolves an `unavailable` discriminant, never
 * throws.
 */
export class AppRuntimeTargetAdapter implements AppRuntimeTargetPort {
    private readonly logger = new Logger(AppRuntimeTargetAdapter.name);

    constructor(
        private readonly access: AppRuntimeTargetAccessSource | undefined,
        private readonly states?: {
            getOrCreate(workId: string): Promise<{
                targetSettings?: { networkIsolation?: boolean | null } | null;
            } | null>;
        },
    ) {}

    async prepareDependencyTarget(
        workId: string,
    ): Promise<
        | { ref: AppTargetRef; podLabels: Record<string, string> }
        | { unavailable: AppRuntimeTargetUnavailable }
    > {
        if (!this.access?.resolveClusterAccess) return { unavailable: 'target_none' };

        let answer: Awaited<ReturnType<AppRuntimeTargetAccessSource['resolveClusterAccess']>>;
        try {
            answer = await this.access.resolveClusterAccess(workId);
        } catch (error) {
            this.logger.warn(`Cluster access for work ${workId} failed: ${messageOf(error)}`);
            return { unavailable: 'cluster_unreachable' };
        }

        if (answer.outcome !== 'access') return { unavailable: unavailableFor(answer.refusal) };

        const { ref, credential, plugin } = answer.access;
        const prepare = (
            plugin as {
                prepareAppNamespace?: (
                    ref: AppTargetRef,
                    credential: string,
                    opts: { isolation: boolean; limitRange: AppLimitRangeInput },
                ) => Promise<unknown>;
            }
        )?.prepareAppNamespace;

        if (typeof prepare === 'function') {
            let isolation = true;
            try {
                const state = await this.states?.getOrCreate(workId);
                isolation = state?.targetSettings?.networkIsolation !== false;
            } catch {
                // The default (isolated) is the safe answer when the row cannot be read.
            }

            try {
                await prepare.call(plugin, ref, credential, {
                    isolation,
                    limitRange: {
                        defaultRequest: { ...DEPENDENCY_NAMESPACE_LIMIT_RANGE.defaultRequest },
                        defaultLimit: { ...DEPENDENCY_NAMESPACE_LIMIT_RANGE.defaultLimit },
                        max: { ...DEPENDENCY_NAMESPACE_LIMIT_RANGE.max },
                    },
                });
            } catch (error) {
                const code = (error as { code?: unknown })?.code;
                this.logger.warn(
                    `prepareAppNamespace for work ${workId} failed (${typeof code === 'string' ? code : 'error'}): ${messageOf(error)}`,
                );
                return {
                    unavailable:
                        code === 'namespace_foreign' || code === 'namespace_owned_elsewhere'
                            ? 'namespace_owned_elsewhere'
                            : 'cluster_unreachable',
                };
            }
        }

        return { ref, podLabels: appDependencyPodLabels(workId) };
    }
}

function unavailableFor(refusal: string): AppRuntimeTargetUnavailable {
    switch (refusal) {
        case 'target_none':
        case 'not_found':
            return 'target_none';
        case 'target_not_checked':
            return 'target_not_checked';
        case 'namespace_owned_elsewhere':
            return 'namespace_owned_elsewhere';
        default:
            return 'cluster_unreachable';
    }
}

/* -------------------------------------------------------------------------- *
 * APP_RUNTIME_NOTIFICATIONS — the two producers (T29)
 * -------------------------------------------------------------------------- */

/** `NotificationService.create`, as far as the producers write it. */
export interface AppRuntimeNotificationWriter {
    create(dto: {
        userId: string;
        type: NotificationType;
        category: NotificationCategory;
        title: string;
        message: string;
        actionUrl?: string;
        actionLabel?: string;
        isPersistent?: boolean;
        deduplicationKey?: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
}

/**
 * §9.4:1335-1336's `notifyAppDeployFailed` (not urgent) and `notifyAppRollbackFailed` (**urgent**,
 * persistent — ACC-06-24), written through `NotificationService.create` (proxied to the API in the
 * worker). Dedupe key `app-deploy:<deploymentId>` and a Deploy-tab link, as T29 states.
 */
export class AppRuntimeNotificationProducersAdapter implements AppRuntimeNotificationProducers {
    constructor(private readonly writer: AppRuntimeNotificationWriter | undefined) {}

    async notifyAppDeployFailed(args: {
        userId: string;
        workId: string;
        deploymentId: string;
        code?: string | null;
    }): Promise<void> {
        if (!this.writer?.create) return;
        await this.writer.create({
            userId: args.userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SYSTEM,
            title: 'App deployment failed',
            message: args.code
                ? `A Deployment of your App failed (${String(args.code).slice(0, 60)}).`
                : 'A Deployment of your App failed.',
            actionUrl: deployTabUrl(args.workId),
            actionLabel: 'Open Deploy',
            deduplicationKey: `app-deploy:${args.deploymentId}`,
            metadata: {
                eventKey: 'app_deploy_failed',
                workId: args.workId,
                deploymentId: args.deploymentId,
            },
        });
    }

    async notifyAppRollbackFailed(args: {
        userId: string;
        workId: string;
        deploymentId: string;
    }): Promise<void> {
        if (!this.writer?.create) return;
        await this.writer.create({
            userId: args.userId,
            type: NotificationType.ERROR,
            category: NotificationCategory.SYSTEM,
            title: 'App rollback failed',
            message:
                'A failed Deployment of your App could not be rolled back. Check the Deploy tab now.',
            actionUrl: deployTabUrl(args.workId),
            actionLabel: 'Open Deploy',
            isPersistent: true,
            deduplicationKey: `app-deploy:${args.deploymentId}`,
            metadata: {
                eventKey: 'app_rollback_failed',
                urgent: true,
                workId: args.workId,
                deploymentId: args.deploymentId,
            },
        });
    }
}

function deployTabUrl(workId: string): string {
    return `/works/${encodeURIComponent(String(workId))}/deploy`;
}

/* -------------------------------------------------------------------------- *
 * APP_COMMIT_ANCESTRY — the upstream-sync verdict's range check (§5.6:841-843)
 * -------------------------------------------------------------------------- */

/**
 * `isAncestorCommit(owner, repo, ancestorSha, commitSha)` over GitHub's public compare API
 * (`GET /repos/{owner}/{repo}/compare/{ancestor}...{commit}`): `ahead`/`identical` ⇒ `true`,
 * `behind`/`diverged` ⇒ `false`, anything else (a private upstream, a rate limit, a network
 * failure) ⇒ `null`, which the orchestrator reads as "unsupported" and falls back to equality.
 * A fork's commits are addressable through the parent repository within one fork network, which
 * is what lets the upstream's coordinates answer for the fork's commit. An optional
 * `GITHUB_TOKEN` in the worker's environment only raises the rate limit.
 */
export class PublicGitHubCommitAncestry implements AppCommitAncestry {
    constructor(
        private readonly fetchImpl?: (
            input: string,
            init?: Record<string, unknown>,
        ) => Promise<{
            ok: boolean;
            json(): Promise<unknown>;
        }>,
        private readonly token: string | undefined = process.env.GITHUB_TOKEN,
    ) {}

    async isAncestorCommit(
        owner: string,
        repo: string,
        ancestorSha: string,
        commitSha: string,
    ): Promise<boolean | null> {
        const safe = (value: string) => /^[A-Za-z0-9_.-]+$/.test(String(value ?? ''));
        const sha = (value: string) => /^[a-f0-9]{7,40}$/i.test(String(value ?? ''));
        if (!safe(owner) || !safe(repo) || !sha(ancestorSha) || !sha(commitSha)) return null;
        if (ancestorSha === commitSha) return true;

        const fetchImpl =
            this.fetchImpl ??
            (
                globalThis as unknown as {
                    fetch: NonNullable<PublicGitHubCommitAncestry['fetchImpl']>;
                }
            ).fetch;

        try {
            const answer = await fetchImpl(
                `https://api.github.com/repos/${owner}/${repo}/compare/${ancestorSha}...${commitSha}`,
                {
                    method: 'GET',
                    headers: {
                        Accept: 'application/vnd.github+json',
                        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
                    },
                },
            );
            if (!answer.ok) return null;
            const body = (await answer.json()) as { status?: unknown } | null;
            if (body?.status === 'ahead' || body?.status === 'identical') return true;
            if (body?.status === 'behind' || body?.status === 'diverged') return false;
            return null;
        } catch {
            return null;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * API side — the event relay (T28) and the dispatch relay (T31 for the worker's dequeue)
 * -------------------------------------------------------------------------- */

/** Keys a relayed payload may never carry (ACC-06-41: names and ids only, never values). */
export const APP_RUNTIME_EVENT_FORBIDDEN_KEYS = [
    'value',
    'values',
    'env',
    'log',
    'logs',
    'kubeconfig',
    'token',
    'password',
    'secret',
    'credential',
] as const;

/** The `app.*` names the worker may relay (§9.4's catalogue, as the worker emits it). */
export const APP_RUNTIME_RELAYED_EVENTS: ReadonlySet<string> = new Set([
    'app.deploy.started',
    'app.deploy.succeeded',
    'app.deploy.failed',
    'app.deploy.rolled_back',
    'app.deploy.paused',
    'app.deploy.resumed',
    'app.deploy.removed',
    'app.job.succeeded',
    'app.job.failed',
    'app.smoke.passed',
    'app.smoke.failed',
    'app.health.changed',
    'app.dependency.ready',
    'app.dependency.failed',
    'app.dependency.removed',
]);

/**
 * The API end of the worker's `APP_RUNTIME_EVENT_SINK` (`remoteMap.AppRuntimeEventRelayService`):
 * accepts only a catalogued `app.*` name, refuses a payload carrying a forbidden key at any depth
 * (ACC-06-41), and re-emits through `EventEmitter2` so API-side listeners (Activity, the web's
 * live updates) see the worker's events as if they were local.
 */
@Injectable()
export class AppRuntimeEventRelayService implements AppRuntimeEventSink {
    private readonly logger = new Logger(AppRuntimeEventRelayService.name);

    constructor(@Optional() private readonly emitter?: EventEmitter2) {}

    async emit(event: { name: string; payload: Record<string, unknown> }): Promise<void> {
        const name = typeof event?.name === 'string' ? event.name : '';
        if (!APP_RUNTIME_RELAYED_EVENTS.has(name)) {
            throw new Error(
                `Refusing to relay an unknown App runtime event '${name.slice(0, 60)}'.`,
            );
        }
        const payload = (event?.payload ?? {}) as Record<string, unknown>;
        const forbidden = forbiddenKey(payload, 0);
        if (forbidden) {
            throw new Error(
                `Refusing to relay ${name}: its payload carries the forbidden key '${forbidden}'.`,
            );
        }
        if (!this.emitter) {
            this.logger.warn(`No EventEmitter2 is bound, so ${name} was not relayed.`);
            return;
        }
        this.emitter.emit(name, payload);
    }
}

function forbiddenKey(value: unknown, depth: number): string | null {
    if (depth > 4 || value === null || typeof value !== 'object') return null;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if ((APP_RUNTIME_EVENT_FORBIDDEN_KEYS as readonly string[]).includes(key.toLowerCase()))
            return key;
        const nested = forbiddenKey(entry, depth + 1);
        if (nested) return nested;
    }
    return null;
}

/**
 * The API end of the worker's `APP_DEPLOY_DISPATCHER` (`remoteMap.AppDeployDispatchRelay`): the
 * orchestrator's §5.6 step 7 dequeue dispatches the adopted queued Deployment through the API's
 * own gate (Trigger.dev or the local worker), so the worker never needs a job-runtime binding of
 * its own and the production attestation is checked where it always is.
 */
@Injectable()
export class AppDeployDispatchRelay {
    constructor(
        @Optional()
        @Inject(APP_DEPLOY_DISPATCHER)
        private readonly dispatcher?: AppDeployOrchestratorDispatcher,
    ) {}

    async dispatchAppDeploy(
        payload: Parameters<NonNullable<AppDeployOrchestratorDispatcher['dispatchAppDeploy']>>[0],
        opts?: { delayMs?: number },
    ): Promise<string | null> {
        const gate = this.dispatcher;
        if (!gate) return null;
        if (typeof gate.isEnabled === 'function' && gate.isEnabled() === false) return null;
        const resolved = (typeof gate.resolve === 'function' ? gate.resolve() : gate) as
            | AppDeployOrchestratorDispatcher
            | null
            | undefined;
        if (typeof resolved?.dispatchAppDeploy !== 'function') return null;
        return resolved.dispatchAppDeploy(payload, opts);
    }
}

/**
 * The worker's `APP_DEPLOY_DISPATCHER` view over {@link AppDeployDispatchRelay}'s proxy — the
 * orchestrator reads `isEnabled()` + `resolve().dispatchAppDeploy`.
 */
export function workerAppDeployDispatcher(relay: {
    dispatchAppDeploy: NonNullable<AppDeployOrchestratorDispatcher['dispatchAppDeploy']>;
}): AppDeployOrchestratorDispatcher {
    return {
        isEnabled: () => Boolean(relay),
        resolve: () => ({
            dispatchAppDeploy: (payload, opts) => relay.dispatchAppDeploy(payload, opts),
        }),
    };
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 300);
    return typeof error === 'string' ? error.slice(0, 300) : 'unknown error';
}

/**
 * APW-06 T31 (lane aw-deploy-2) — the API end of the worker's `APP_CLUSTER_OP_DISPATCHER`
 * (`remoteMap.AppClusterOpDispatchRelay`). The worker re-dispatches ops (T58's deletion retries,
 * T26's `ingress-reconcile`, `resume`'s wait) through the API's own gate, exactly as
 * {@link AppDeployDispatchRelay} does for the dequeue, so the worker needs no job-runtime binding.
 */
@Injectable()
export class AppClusterOpDispatchRelay {
    constructor(
        @Optional()
        @Inject(APP_CLUSTER_OP_DISPATCHER)
        private readonly gate?: {
            dispatch(
                payload: { op: string; workId: string; [key: string]: unknown },
                opts?: { delayMs?: number },
            ): Promise<string | null>;
        },
    ) {}

    async dispatch(
        payload: { op: string; workId: string; [key: string]: unknown },
        opts?: { delayMs?: number },
    ): Promise<string | null> {
        if (!this.gate?.dispatch) return null;
        if (!payload || typeof payload.op !== 'string' || typeof payload.workId !== 'string')
            return null;
        return this.gate.dispatch(payload, opts);
    }
}
