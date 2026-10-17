/**
 * APW-06 T33 (lane aw-deploy-2, 2026-10-17) — **the App target and status routes' service** (plan
 * §9.1): `GET`/`PUT :id/app-target`, `POST :id/app-target/check` and `GET :id/app-status`.
 *
 * Runs in the **API** process and never dials a cluster: the kubeconfig is stored write-only and
 * the check itself is an `app-cluster-op { op: 'cluster-check' }` the isolated worker runs (§6.2,
 * APW06-G01). The controller (`apps/api/src/works/work-app-runtime.controller.ts`) resolves access
 * first; everything here assumes an App Work the caller may see (`view`) or edit (`edit`).
 *
 * ## 🛑 The kubeconfig rule (ACC-06-56)
 *
 * `check` writes the pasted kubeconfig as the Work-scoped `x-secret` of the your-cluster deployment
 * plugin through `PluginSettingsService.writePlatformManagedWorkSettings`, which encrypts it,
 * validates nothing and connects to nothing — never through
 * `PATCH /api/works/:workId/plugins/:pluginId/settings`, whose connection validation would dial the
 * pasted cluster from the API before §6.1's guard runs. No method here returns it, logs it, or puts
 * it in a dispatch payload.
 *
 * ## The answers (plan §9.1 "Response shapes", the web's `app-runtime.types.ts`)
 *
 * - `getTarget` → `{ target, settings, namespace, clusterCheck, clusterCheckedAt, eligibility }`.
 * - `putTarget` → the same, or a refusal `{ httpStatus: 422, code: 'APP_TARGET_REFUSED', unmet }` /
 *   `{ httpStatus: 409, code: 'APP_WORK_DELETING' }`.
 * - `check` → `{ httpStatus: 202, requestId, dispatched }`, or `413 kubeconfig_too_large` /
 *   `422 your_cluster_plugin_unavailable`.
 * - `getStatus` → `{ state, target, stale, observedAt, url, hosts, sourceOffer, currentDeployment,
 *   snapshot, ops }`.
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AppDeployTarget, AppPrecondition, AppRuntimeState } from '@ever-works/contracts';
import { isAppDeploymentPlugin, PLUGIN_CAPABILITIES, type IDeploymentPlugin } from '@ever-works/plugin';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { WorkDeploymentRepository } from '../database/repositories/work-deployment.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import type {
    AppRuntimeIngressAddress,
    AppRuntimeTargetSettings,
} from '../entities/work-app-runtime-state.entity';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import type { AppClusterOpDispatchGate } from './app-deploy-dispatcher.provider';
import { APP_CLUSTER_OP_DISPATCHER } from './app-runtime-deletion.service';
import { APPS_TIER_POLICY, type AppsTierPolicy } from './ports';

/** The managed tier's capability (`facades/app-runtime.facade.ts` `APP_TIER_CAPABILITY`). */
const APP_TIER_CAPABILITY = 'apps-tier';

/** §9.1: `kubeconfig?: string (≤ 64 KiB)`. */
export const APP_TARGET_KUBECONFIG_MAX_BYTES = 64 * 1024;

/** A snapshot older than this is reported `stale` (the health poll runs every minute). */
export const APP_STATUS_STALE_MS = 3 * 60 * 1000;

/** The settings keys `PUT app-target` accepts, with their type (plan §7.2 `targetSettings`). */
const SETTINGS_STRING_KEYS = [
    'namespaceOverride',
    'ingressClass',
    'controllerNamespace',
    'issuer',
    'storageClass',
    'primaryDomain',
] as const;
const SETTINGS_BOOLEAN_KEYS = [
    'networkIsolation',
    'allowRoot',
    'managedSubdomain',
    'autoDeploy',
    'previews',
] as const;
const TLS_MODES = ['cert-manager', 'external', 'edge', 'none'] as const;
const TARGETS: readonly AppDeployTarget[] = ['none', 'your-cluster', 'ever-works-apps'];

/** The runtime-state row as this service reads and writes it. */
export interface AppTargetStateStore {
    getOrCreate(workId: string): Promise<AppTargetStateRow | null>;
    patchRuntimeState(
        workId: string,
        patch: { target?: AppDeployTarget; targetSettings?: AppRuntimeTargetSettings | null },
    ): Promise<unknown>;
}

/** The row's fields this service reads. */
export interface AppTargetStateRow {
    target?: string | null;
    targetSettings?: AppRuntimeTargetSettings | null;
    namespace?: string | null;
    clusterCheck?: unknown;
    clusterCheckedAt?: Date | string | null;
    currentDeploymentId?: string | null;
    paused?: boolean | null;
    pausedAt?: Date | string | null;
    removedAt?: Date | string | null;
    deletionRequestedAt?: Date | string | null;
    health?: string | null;
    statusSnapshot?: unknown;
    statusObservedAt?: Date | string | null;
    ingressAddress?: AppRuntimeIngressAddress | null;
}

/** `GET app-target`'s body. */
export interface AppTargetBody {
    target: AppDeployTarget;
    settings: AppRuntimeTargetSettings | null;
    namespace: string | null;
    clusterCheck: unknown;
    clusterCheckedAt: string | null;
    eligibility: { managed: { eligible: boolean; reasons: string[] } } | null;
}

/** A refusal the controller answers verbatim. */
export interface AppTargetRefusal {
    httpStatus: number;
    code: string;
    message: string;
    unmet?: AppPrecondition[];
}

/** `GET app-status`'s body. */
export interface AppStatusBody {
    state: AppRuntimeState;
    target: AppDeployTarget;
    stale: boolean;
    observedAt: string | null;
    url: string | null;
    hosts: { primary: string | null; extra: string[] };
    sourceOffer: { url: string } | null;
    currentDeployment: { id: string; state: string; phase?: string; cancelReason?: string } | null;
    snapshot: unknown;
    ops: unknown[];
}

@Injectable()
export class AppTargetService {
    private readonly logger = new Logger(AppTargetService.name);

    constructor(
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: AppTargetStateStore,
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly deployments?: WorkDeploymentRepository,
        @Optional() private readonly registry?: PluginRegistryService,
        @Optional() private readonly settings?: PluginSettingsService,
        @Optional()
        @Inject(APP_CLUSTER_OP_DISPATCHER)
        private readonly ops?: AppClusterOpDispatchGate,
        @Optional()
        @Inject(APPS_TIER_POLICY)
        private readonly tier?: AppsTierPolicy,
    ) {}

    /* ---------------------------------------------------------------------- *
     * GET app-target
     * ---------------------------------------------------------------------- */

    async getTarget(workId: string, userId: string): Promise<AppTargetBody> {
        const row = await this.readState(workId);
        return this.targetBody(row, userId);
    }

    /* ---------------------------------------------------------------------- *
     * PUT app-target
     * ---------------------------------------------------------------------- */

    async putTarget(
        workId: string,
        userId: string,
        body: { target?: unknown; settings?: unknown },
    ): Promise<{ ok: true; body: AppTargetBody } | { ok: false; refusal: AppTargetRefusal }> {
        const target = TARGETS.find((choice) => choice === body?.target);
        if (!target) {
            return refuse(400, 'invalid_target', `target must be one of ${TARGETS.join(', ')}.`);
        }
        const parsed = parseSettings(body?.settings);
        if ('error' in parsed) return refuse(400, 'invalid_settings', parsed.error);

        const row = await this.readState(workId);
        if (!row || !this.states?.patchRuntimeState) {
            return refuse(503, 'app_runtime_state_unavailable', 'The App runtime state is not available.');
        }
        if (row.deletionRequestedAt) {
            return refuse(409, 'APP_WORK_DELETING', 'This App Work is being deleted.');
        }

        if (target === 'ever-works-apps') {
            const unmet = await this.managedRefusals(userId);
            if (unmet.length > 0) {
                return {
                    ok: false,
                    refusal: {
                        httpStatus: 422,
                        code: 'APP_TARGET_REFUSED',
                        message: unmet[0].message,
                        unmet,
                    },
                };
            }
        }

        const previousTarget = text(row.target) || 'none';
        const settings: AppRuntimeTargetSettings = {
            ...(row.targetSettings ?? {}),
            ...(parsed.settings ?? {}),
        };

        if (target === 'your-cluster') {
            // The worker's facade dials the plugin `work.deployProvider` names, so a Work that
            // never chose one is pointed at the your-cluster plugin (resolved by capability).
            await this.ensureDeployProvider(workId);
        }

        await this.states.patchRuntimeState(workId, { target, targetSettings: settings });

        const namespaceChanged =
            parsed.settings?.namespaceOverride !== undefined &&
            parsed.settings.namespaceOverride !== (row.targetSettings?.namespaceOverride ?? undefined);
        if (target !== 'none' && (target !== previousTarget || namespaceChanged)) {
            // §9.1 — after a committed change: the namespace and its baseline policies first, so a
            // dependency provisioned next lands in a namespace that already exists (GAP-06).
            await this.dispatchOp({ op: 'prepare-namespace', workId, userId });
        }

        return { ok: true, body: await this.targetBody(await this.readState(workId), userId) };
    }

    /* ---------------------------------------------------------------------- *
     * POST app-target/check
     * ---------------------------------------------------------------------- */

    async check(
        workId: string,
        userId: string,
        body: { kubeconfig?: unknown; kubeContext?: unknown },
    ): Promise<
        | { ok: true; httpStatus: 202; requestId: string; dispatched: boolean }
        | { ok: false; refusal: AppTargetRefusal }
    > {
        const kubeconfig = typeof body?.kubeconfig === 'string' ? body.kubeconfig : '';
        const kubeContext = typeof body?.kubeContext === 'string' ? body.kubeContext.trim() : '';

        if (kubeconfig && Buffer.byteLength(kubeconfig, 'utf8') > APP_TARGET_KUBECONFIG_MAX_BYTES) {
            return refuse(413, 'kubeconfig_too_large', 'The kubeconfig is larger than 64 KiB.');
        }
        if (kubeContext.length > 253) {
            return refuse(400, 'invalid_kube_context', 'The kube context name is too long.');
        }

        const row = await this.readState(workId);
        if (row?.deletionRequestedAt) {
            return refuse(409, 'APP_WORK_DELETING', 'This App Work is being deleted.');
        }

        if (kubeconfig.trim()) {
            const pluginId = await this.ensureDeployProvider(workId);
            if (!pluginId || !this.settings?.writePlatformManagedWorkSettings) {
                return refuse(
                    422,
                    'your_cluster_plugin_unavailable',
                    'No deployment plugin that can run an App on your own cluster is installed.',
                );
            }
            // Write-only, encrypted, validated against nothing and connected to nothing (§9.1).
            await this.settings.writePlatformManagedWorkSettings(pluginId, workId, {
                clusterSource: 'custom-kubeconfig',
                kubeconfig,
                ...(kubeContext ? { kubeContext } : {}),
            });
            // Connecting a cluster is choosing Your cluster: a Work still on `none` moves to it,
            // so the worker's check can resolve the credential it was just given.
            if (this.states?.patchRuntimeState && (!row?.target || row.target === 'none')) {
                await this.states.patchRuntimeState(workId, { target: 'your-cluster' });
            }
        } else if (kubeContext && this.settings?.writePlatformManagedWorkSettings) {
            const pluginId = await this.ensureDeployProvider(workId);
            if (pluginId) {
                await this.settings.writePlatformManagedWorkSettings(pluginId, workId, { kubeContext });
            }
        }

        const requestId = randomUUID();
        const dispatched = await this.dispatchOp({ op: 'cluster-check', workId, userId, requestId });
        return { ok: true, httpStatus: 202, requestId, dispatched };
    }

    /* ---------------------------------------------------------------------- *
     * GET app-status
     * ---------------------------------------------------------------------- */

    async getStatus(workId: string): Promise<AppStatusBody> {
        const row = await this.readState(workId);
        const target = (TARGETS.find((choice) => choice === row?.target) ?? 'none') as AppDeployTarget;

        const latest = await this.latestDeployment(workId);
        const current = row?.currentDeploymentId
            ? (await this.deploymentById(row.currentDeploymentId)) ?? latest
            : latest;
        const render = (current?.appRender ?? {}) as {
            phase?: unknown;
            hosts?: { primary?: unknown; extra?: unknown };
            cancelledBy?: unknown;
        };
        const live = row?.currentDeploymentId ? await this.deploymentById(row.currentDeploymentId) : null;
        const liveHosts = ((live?.appRender ?? {}) as { hosts?: { primary?: unknown; extra?: unknown } }).hosts;
        const primary = text(liveHosts?.primary) || null;
        const extra = Array.isArray(liveHosts?.extra) ? liveHosts.extra.map(String) : [];

        const observedAt = iso(row?.statusObservedAt);
        const deployed = Boolean(row?.currentDeploymentId) && !row?.removedAt;
        const stale =
            deployed &&
            (!observedAt || Date.now() - new Date(observedAt).getTime() > APP_STATUS_STALE_MS);

        return {
            state: runtimeStateOf(row),
            target,
            stale,
            observedAt,
            url: (live?.website ? String(live.website) : null) ?? (primary ? `https://${primary}` : null),
            hosts: { primary, extra },
            sourceOffer: null,
            currentDeployment: latest
                ? {
                      id: String(latest.id),
                      state: String(latest.state ?? ''),
                      ...(text(((latest.appRender ?? {}) as { phase?: unknown }).phase)
                          ? { phase: text(((latest.appRender ?? {}) as { phase?: unknown }).phase) }
                          : {}),
                      ...(text(render.cancelledBy) ? { cancelReason: text(render.cancelledBy) } : {}),
                  }
                : null,
            snapshot: row?.statusSnapshot ?? null,
            ops: [],
        };
    }

    /* ---------------------------------------------------------------------- *
     * internals
     * ---------------------------------------------------------------------- */

    private async targetBody(row: AppTargetStateRow | null, userId: string): Promise<AppTargetBody> {
        const target = (TARGETS.find((choice) => choice === row?.target) ?? 'none') as AppDeployTarget;
        let eligibility: AppTargetBody['eligibility'] = null;
        if (this.tier?.eligibility) {
            try {
                const answer = await this.tier.eligibility(userId);
                eligibility = {
                    managed: {
                        eligible: answer?.eligible === true && this.tier.isOpen() === true,
                        reasons: [...(answer?.reasons ?? [])],
                    },
                };
            } catch {
                eligibility = null;
            }
        }
        return {
            target,
            settings: row?.targetSettings ?? null,
            namespace: text(row?.namespace) || null,
            // Secret-free by construction (`AppClusterCheck`, plan §6.3).
            clusterCheck: row?.clusterCheck ?? null,
            clusterCheckedAt: iso(row?.clusterCheckedAt),
            eligibility,
        };
    }

    private async managedRefusals(userId: string): Promise<AppPrecondition[]> {
        const open = (() => {
            try {
                return this.tier?.isOpen?.() === true;
            } catch {
                return false;
            }
        })();
        if (!open) {
            return [
                {
                    code: 'managed_disabled',
                    message: 'Ever Works Apps hosting is not available on this installation.',
                },
            ];
        }
        try {
            const answer = await this.tier!.eligibility(userId);
            if (answer?.eligible !== true) {
                return [
                    {
                        code: 'managed_ineligible',
                        names: [...(answer?.reasons ?? [])],
                        message: 'Your account is not eligible for Ever Works Apps hosting.',
                    },
                ];
            }
        } catch {
            return [
                {
                    code: 'managed_ineligible',
                    message: 'Eligibility for Ever Works Apps hosting could not be read.',
                },
            ];
        }
        return [];
    }

    /**
     * The your-cluster deployment plugin for this Work, by capability (`supportsApps` and NOT
     * `apps-tier`), never by a hard-coded id alone; `work.deployProvider` is set to it when the
     * Work has none yet. `null` ⇔ no such plugin is loaded.
     */
    private async ensureDeployProvider(workId: string): Promise<string | null> {
        const work = this.works ? await this.works.findById(workId) : null;
        const current = text(work?.deployProvider);
        const candidates = [current, 'k8s'].filter(Boolean);

        for (const id of [...new Set(candidates)]) {
            if (await this.isYourClusterPlugin(id)) {
                if (work && current !== id) {
                    try {
                        await this.works?.update(workId, { deployProvider: id });
                    } catch (error) {
                        this.logger.warn(`Could not set the deploy provider of ${workId}: ${messageOf(error)}`);
                    }
                }
                return id;
            }
        }
        return null;
    }

    private async isYourClusterPlugin(pluginId: string): Promise<boolean> {
        const registered = this.registry?.get(pluginId);
        if (!registered || registered.state !== 'loaded') return false;
        let plugin = registered.plugin as IDeploymentPlugin & {
            __materialize?: () => Promise<IDeploymentPlugin>;
        };
        if (typeof plugin.__materialize === 'function') {
            try {
                plugin = ((await plugin.__materialize()) ?? plugin) as typeof plugin;
            } catch {
                return false;
            }
        }
        const capabilities = [
            ...(Array.isArray(plugin?.capabilities) ? plugin.capabilities : []),
            ...(Array.isArray(registered.manifest?.capabilities) ? registered.manifest.capabilities : []),
        ];
        return (
            capabilities.includes(PLUGIN_CAPABILITIES.DEPLOYMENT) &&
            !capabilities.includes(APP_TIER_CAPABILITY) &&
            isAppDeploymentPlugin(plugin)
        );
    }

    private async dispatchOp(payload: {
        op: string;
        workId: string;
        userId?: string | null;
        requestId?: string;
    }): Promise<boolean> {
        if (!this.ops?.dispatch) {
            this.logger.warn(`No App cluster-op dispatcher is bound; ${payload.op} for ${payload.workId} was not queued.`);
            return false;
        }
        try {
            const id = await this.ops.dispatch({ ...payload, requestId: payload.requestId ?? randomUUID() });
            return Boolean(id);
        } catch (error) {
            this.logger.warn(`Dispatching ${payload.op} for ${payload.workId} failed: ${messageOf(error)}`);
            return false;
        }
    }

    private async readState(workId: string): Promise<AppTargetStateRow | null> {
        if (!this.states?.getOrCreate) return null;
        try {
            return (await this.states.getOrCreate(workId)) ?? null;
        } catch (error) {
            this.logger.warn(`Reading the App runtime state of ${workId} failed: ${messageOf(error)}`);
            return null;
        }
    }

    private async latestDeployment(workId: string) {
        if (!this.deployments?.findByWork) return null;
        try {
            const rows = await this.deployments.findByWork(workId, { limit: 1 });
            return rows?.[0] ?? null;
        } catch {
            return null;
        }
    }

    private async deploymentById(id: string) {
        if (!this.deployments?.findById) return null;
        try {
            return (await this.deployments.findById(id)) ?? null;
        } catch {
            return null;
        }
    }
}

/** plan §3.1:367-369 — `health` + `paused` + `removedAt` + `deletionRequestedAt` → the app state. */
export function runtimeStateOf(row: AppTargetStateRow | null | undefined): AppRuntimeState {
    if (!row) return 'not-deployed';
    if (row.deletionRequestedAt) return 'deleting';
    if (row.removedAt || !row.currentDeploymentId) return 'not-deployed';
    if (row.paused === true || row.pausedAt) return 'paused';
    switch (row.health) {
        case 'degraded':
            return 'degraded';
        case 'down':
            return 'down';
        case 'unreachable':
            return 'unreachable';
        default:
            // `healthy`, and `unknown` with a READY Deployment on record (not judged yet).
            return 'live';
    }
}

/** `settings` off the wire → the §7.2 bag, or the reason it is not one. */
export function parseSettings(
    raw: unknown,
): { settings: AppRuntimeTargetSettings | null } | { error: string } {
    if (raw === undefined || raw === null) return { settings: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'settings must be an object.' };
    const input = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of SETTINGS_STRING_KEYS) {
        if (!(key in input) || input[key] === undefined) continue;
        const value = input[key];
        if (value === null || value === '') {
            out[key] = null;
            continue;
        }
        if (typeof value !== 'string' || value.length > 253) return { error: `${key} must be a short string.` };
        out[key] = value.trim();
    }
    for (const key of SETTINGS_BOOLEAN_KEYS) {
        if (!(key in input) || input[key] === undefined) continue;
        if (typeof input[key] !== 'boolean') return { error: `${key} must be a boolean.` };
        out[key] = input[key];
    }
    if ('tls' in input && input.tls !== undefined) {
        if (!(TLS_MODES as readonly unknown[]).includes(input.tls)) {
            return { error: `tls must be one of ${TLS_MODES.join(', ')}.` };
        }
        out.tls = input.tls;
    }
    const namespace = out.namespaceOverride;
    if (typeof namespace === 'string' && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) {
        return { error: 'namespaceOverride must be a DNS-1123 label.' };
    }
    return { settings: out as AppRuntimeTargetSettings };
}

function refuse(httpStatus: number, code: string, message: string): { ok: false; refusal: AppTargetRefusal } {
    return { ok: false, refusal: { httpStatus, code, message } };
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function iso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 300);
    return typeof error === 'string' ? error.slice(0, 300) : 'unknown error';
}
