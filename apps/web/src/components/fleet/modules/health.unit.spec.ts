import { beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import { getOverviewBlocks, resetFleetRegistryForTests } from '../registry';

// The block itself is tested on its own; here only WHICH module the loader fetches matters.
vi.mock('../health/overview/HealthMetricsBlock', () => ({
    default: function HealthMetricsBlockStub() {
        return null;
    },
}));

/** Computer health (FL-03) — what this epic registers into FL-01's module registry. */
describe('FL-03 registration (components/fleet/modules/health.ts)', () => {
    beforeEach(async () => {
        resetFleetRegistryForTests();
        // A fresh module instance re-runs the registration against the reset registry.
        vi.resetModules();
    });

    it('puts the metrics block first on every computer page, whatever flags are on', async () => {
        const registry = await import('../registry');
        const { HEALTH_METRICS_BLOCK_ID } = await import('./health');
        for (const flags of [{}, { FLEET_HEALTH_HISTORY_ENABLED: true }]) {
            const blocks = registry.getOverviewBlocks('computer', flags);
            expect(blocks[0]).toMatchObject({
                id: HEALTH_METRICS_BLOCK_ID,
                surface: 'computer',
                epic: 'FL-03',
                order: 10,
            });
            expect(blocks[0].flag).toBeUndefined();
        }
        // Not on the hub's own Overview: the hub lists computers, not one machine's metrics.
        expect(registry.getOverviewBlocks('hub', {})).toEqual([]);
    });

    it('is reachable from the one registrations barrel the pages import', async () => {
        await import('./index');
        const registry = await import('../registry');
        expect(registry.getOverviewBlocks('computer', {}).map((block) => block.id)).toContain(
            'fl-03.health-metrics',
        );
    });

    it('loads the metrics block component lazily — that module, on demand', async () => {
        const registry = await import('../registry');
        await import('./health');
        const [block] = registry.getOverviewBlocks('computer', {});
        const loaded = await block.load();
        expect(loaded.default.name).toBe('HealthMetricsBlockStub');
    });

    it('a reset registry holds nothing until the module registers again (control)', () => {
        expect(getOverviewBlocks('computer', {})).toEqual([]);
    });
});

describe('FL-03 strings in en.json (CONTRACTS §11.4)', () => {
    const fleet = (messages as unknown as { fleet: Record<string, unknown> }).fleet;

    function leaves(node: unknown, path: string, out: Array<[string, string]>) {
        if (typeof node === 'string') {
            out.push([path, node]);
            return;
        }
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            expect(key.includes('.'), `${path}.${key} must not contain a dot`).toBe(false);
            expect(key, `${path}.${key} must be camelCase`).toMatch(/^[a-z][A-Za-z0-9]*$/);
            leaves(value, `${path}.${key}`, out);
        }
    }

    it('every FL-03 leaf is a non-empty string with a camelCase, dot-free key', () => {
        const out: Array<[string, string]> = [];
        for (const group of ['states', 'stateSentences', 'fixCommands', 'health']) {
            expect(fleet[group], group).toBeTruthy();
            leaves(fleet[group], `fleet.${group}`, out);
        }
        expect(out.length).toBeGreaterThan(60);
        for (const [path, value] of out) expect(value.trim(), path).not.toBe('');
    });
});
