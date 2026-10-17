/**
 * APW-06 T33 (lane aw-deploy-2) — `AppTargetService`: the four routes behind the web's Deploy tab
 * (`GET`/`PUT app-target`, `POST app-target/check`, `GET app-status`, plan §9.1).
 *
 * The two rules pinned hardest: the kubeconfig is stored write-only through the platform-managed
 * writer and never appears in an answer or a dispatch payload (ACC-06-56), and the check itself is
 * a dispatched `cluster-check` op — the API dials nothing.
 */

import { Logger } from '@nestjs/common';

import { ConfigAppsTierPolicy } from '../app-runtime-worker.adapters';
import { AppTargetService, parseSettings, runtimeStateOf } from '../app-target.service';

const KUBECONFIG = 'apiVersion: v1\nkind: Config\nclusters: []\n# sentinel-secret-7f3a\n';

function harness(row: Record<string, unknown> | null = { target: 'none', targetSettings: {} }) {
    let state = row ? { ...row } : null;
    const states = {
        getOrCreate: jest.fn(async () => (state ? { ...state } : null)),
        patchRuntimeState: jest.fn(async (_workId: string, patch: Record<string, unknown>) => {
            state = { ...(state ?? {}), ...patch };
        }),
    };
    const work = { id: 'w-1', kind: 'app', deployProvider: null as string | null };
    const works = {
        findById: jest.fn(async () => ({ ...work })),
        update: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
            Object.assign(work, patch);
            return work;
        }),
    };
    const deployments = {
        findByWork: jest.fn(async () => [] as Array<Record<string, unknown>>),
        findById: jest.fn(async () => null as Record<string, unknown> | null),
    };
    const k8s = {
        capabilities: ['deployment'],
        supportsApps: true,
        deployApp: jest.fn(),
        destroyApp: jest.fn(),
        getAppStatus: jest.fn(),
        checkAppCluster: jest.fn(),
        runAppJob: jest.fn(),
        getAppLogs: jest.fn(),
        scaleApp: jest.fn(),
    };
    const registry = {
        get: jest.fn((id: string) =>
            id === 'k8s' ? { state: 'loaded', plugin: k8s, manifest: { capabilities: ['deployment'] } } : undefined,
        ),
    };
    const settings = { writePlatformManagedWorkSettings: jest.fn(async () => undefined) };
    const ops = { dispatch: jest.fn(async () => 'run-1'), isEnabled: () => true };
    const service = new AppTargetService(
        states as never,
        works as never,
        deployments as never,
        registry as never,
        settings as never,
        ops,
        new ConfigAppsTierPolicy({}),
    );
    return { service, states, works, deployments, settings, ops, registry, k8s, work };
}

beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('AppTargetService.check (POST app-target/check)', () => {
    it('stores the kubeconfig write-only, points the Work at Your cluster and dispatches cluster-check', async () => {
        const { service, settings, ops, states, works } = harness();

        const result = await service.check('w-1', 'u-1', { kubeconfig: KUBECONFIG, kubeContext: 'prod' });

        expect(result).toMatchObject({ ok: true, httpStatus: 202, dispatched: true });
        expect(settings.writePlatformManagedWorkSettings).toHaveBeenCalledWith('k8s', 'w-1', {
            clusterSource: 'custom-kubeconfig',
            kubeconfig: KUBECONFIG,
            kubeContext: 'prod',
        });
        expect(works.update).toHaveBeenCalledWith('w-1', { deployProvider: 'k8s' });
        expect(states.patchRuntimeState).toHaveBeenCalledWith('w-1', { target: 'your-cluster' });
        expect(ops.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ op: 'cluster-check', workId: 'w-1', userId: 'u-1' }),
        );
        // ACC-06-56: the secret is in no answer and in no dispatch payload.
        expect(JSON.stringify(result)).not.toContain('sentinel-secret-7f3a');
        expect(JSON.stringify(ops.dispatch.mock.calls)).not.toContain('sentinel-secret-7f3a');
    });

    it('re-checks the stored credential when no kubeconfig is sent, writing nothing', async () => {
        const { service, settings, ops } = harness({ target: 'your-cluster' });
        await expect(service.check('w-1', 'u-1', {})).resolves.toMatchObject({ ok: true });
        expect(settings.writePlatformManagedWorkSettings).not.toHaveBeenCalled();
        expect(ops.dispatch).toHaveBeenCalledTimes(1);
    });

    it('refuses an oversized kubeconfig and a deleting Work, and says when no plugin can host it', async () => {
        const big = harness();
        await expect(big.service.check('w-1', 'u-1', { kubeconfig: 'x'.repeat(64 * 1024 + 1) })).resolves.toMatchObject({
            ok: false,
            refusal: { httpStatus: 413, code: 'kubeconfig_too_large' },
        });
        expect(big.ops.dispatch).not.toHaveBeenCalled();

        const deleting = harness({ target: 'your-cluster', deletionRequestedAt: new Date() });
        await expect(deleting.service.check('w-1', 'u-1', { kubeconfig: KUBECONFIG })).resolves.toMatchObject({
            ok: false,
            refusal: { httpStatus: 409, code: 'APP_WORK_DELETING' },
        });

        const noPlugin = harness();
        noPlugin.registry.get.mockReturnValue(undefined);
        await expect(noPlugin.service.check('w-1', 'u-1', { kubeconfig: KUBECONFIG })).resolves.toMatchObject({
            ok: false,
            refusal: { httpStatus: 422, code: 'your_cluster_plugin_unavailable' },
        });
        expect(noPlugin.settings.writePlatformManagedWorkSettings).not.toHaveBeenCalled();
    });
});

describe('AppTargetService.putTarget / getTarget (PUT/GET app-target)', () => {
    it('saves Your cluster with merged settings and prepares the namespace once', async () => {
        const { service, states, ops } = harness({ target: 'none', targetSettings: { tls: 'cert-manager' } });

        const result = await service.putTarget('w-1', 'u-1', {
            target: 'your-cluster',
            settings: { ingressClass: 'nginx', networkIsolation: false },
        });

        expect(result).toMatchObject({
            ok: true,
            body: {
                target: 'your-cluster',
                settings: { tls: 'cert-manager', ingressClass: 'nginx', networkIsolation: false },
                eligibility: { managed: { eligible: false, reasons: ['managedTierDisabled'] } },
            },
        });
        expect(states.patchRuntimeState).toHaveBeenCalledWith('w-1', {
            target: 'your-cluster',
            targetSettings: { tls: 'cert-manager', ingressClass: 'nginx', networkIsolation: false },
        });
        expect(ops.dispatch).toHaveBeenCalledWith(expect.objectContaining({ op: 'prepare-namespace' }));
    });

    it('refuses the managed target while the tier is closed (422 APP_TARGET_REFUSED managed_disabled)', async () => {
        const { service, states } = harness();
        const result = await service.putTarget('w-1', 'u-1', { target: 'ever-works-apps' });

        expect(result).toMatchObject({
            ok: false,
            refusal: { httpStatus: 422, code: 'APP_TARGET_REFUSED', unmet: [{ code: 'managed_disabled' }] },
        });
        expect(states.patchRuntimeState).not.toHaveBeenCalled();
    });

    it('validates the target and the settings bag', async () => {
        const { service } = harness();
        await expect(service.putTarget('w-1', 'u-1', { target: 'mars' })).resolves.toMatchObject({
            refusal: { httpStatus: 400, code: 'invalid_target' },
        });
        await expect(
            service.putTarget('w-1', 'u-1', { target: 'your-cluster', settings: { tls: 'maybe' } }),
        ).resolves.toMatchObject({ refusal: { httpStatus: 400, code: 'invalid_settings' } });
        expect(parseSettings({ namespaceOverride: 'Bad_NS' })).toEqual({
            error: 'namespaceOverride must be a DNS-1123 label.',
        });
    });

    it('answers the cluster check and its time, never a credential', async () => {
        const check = { ok: true, fingerprint: 'fp', missingPermissions: [] };
        const { service } = harness({
            target: 'your-cluster',
            clusterCheck: check,
            clusterCheckedAt: new Date('2026-10-17T10:00:00Z'),
            namespace: 'ew-acme',
        });
        await expect(service.getTarget('w-1', 'u-1')).resolves.toMatchObject({
            target: 'your-cluster',
            namespace: 'ew-acme',
            clusterCheck: check,
            clusterCheckedAt: '2026-10-17T10:00:00.000Z',
        });
    });
});

describe('AppTargetService.getStatus (GET app-status)', () => {
    it('reports a live app with its URL, hosts and the current Deployment', async () => {
        const { service, deployments } = harness({
            target: 'your-cluster',
            currentDeploymentId: 'd-1',
            health: 'healthy',
            statusObservedAt: new Date(),
        });
        const row = {
            id: 'd-1',
            state: 'READY',
            website: 'https://acme.apps.example.com',
            appRender: { phase: 'done', hosts: { primary: 'acme.apps.example.com', extra: [] } },
        };
        deployments.findByWork.mockResolvedValue([row]);
        deployments.findById.mockResolvedValue(row);

        await expect(service.getStatus('w-1')).resolves.toMatchObject({
            state: 'live',
            target: 'your-cluster',
            stale: false,
            url: 'https://acme.apps.example.com',
            hosts: { primary: 'acme.apps.example.com', extra: [] },
            currentDeployment: { id: 'd-1', state: 'READY', phase: 'done' },
        });
    });

    it('maps the row to the seven app states', () => {
        expect(runtimeStateOf(null)).toBe('not-deployed');
        expect(runtimeStateOf({ currentDeploymentId: null })).toBe('not-deployed');
        expect(runtimeStateOf({ currentDeploymentId: 'd', deletionRequestedAt: new Date() })).toBe('deleting');
        expect(runtimeStateOf({ currentDeploymentId: 'd', paused: true })).toBe('paused');
        expect(runtimeStateOf({ currentDeploymentId: 'd', health: 'down' })).toBe('down');
        expect(runtimeStateOf({ currentDeploymentId: 'd', health: 'unreachable' })).toBe('unreachable');
        expect(runtimeStateOf({ currentDeploymentId: 'd', health: 'unknown' })).toBe('live');
    });
});
