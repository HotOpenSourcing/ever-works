import { describe, expect, it } from 'vitest';
import type { NeedsALookItem } from '@ever-works/contracts';
import { needsALookCopy } from './needs-a-look.shared';
import { testTranslations } from './fleet-test-intl';
import {
    getOverviewBlocks,
    registerOverviewBlock,
    getComputerTabs,
    registerComputerTab,
} from '../registry';
import { HEALTH_METRICS_BLOCK_ID } from './register';
import messages from '../../../../messages/en.json';

const GIB = 1024 ** 3;
const t = testTranslations('fleet.needsALook.kinds');

function item(
    messageKey: string,
    params: NeedsALookItem['params'],
    nodeName = 'design-mac',
): NeedsALookItem {
    return {
        id: `x:${messageKey}`,
        nodeId: 'n1',
        nodeName,
        severity: 'warn',
        kind: 'disk-low',
        title: 'English title',
        detail: null,
        messageKey,
        params,
        since: '2026-10-18T09:00:00.000Z',
    };
}

const render = (entry: NeedsALookItem) => {
    const copy = needsALookCopy(entry, 'en-GB');
    return copy ? t(copy.key, copy.values) : null;
};

describe('needsALookCopy — FL-03 items in the viewer’s language (spec §5.4)', () => {
    it('disk-low, with and without the percentage the node reported', () => {
        expect(
            render(
                item('diskLowCritical', { percent: 94, freeBytes: 6 * GIB, floorBytes: 5 * GIB }),
            ),
        ).toBe('Disk is 94% full · 6 GiB left, the node stops at 5 GiB');
        expect(
            render(
                item('diskLowCritical', { percent: null, freeBytes: 6 * GIB, floorBytes: 5 * GIB }),
            ),
        ).toBe('6 GiB left on the disk, the node stops at 5 GiB');
        expect(
            render(item('diskLowWarn', { percent: 88, freeBytes: 9 * GIB, floorBytes: null })),
        ).toBe('Disk is 88% full · 9 GiB left');
    });

    it('limited and throttled', () => {
        expect(
            render(item('limited', { cli: 'Claude Code', until: '2026-10-19T01:00:00.000Z' })),
        ).toMatch(/^Waiting for Claude Code's limit to reset at /);
        expect(render(item('throttledCpu', { value: 92, limit: 85 }))).toBe(
            'Pausing new work — CPU is above its ceiling (92% of 85%)',
        );
        expect(render(item('throttledDisk', { value: 3 * GIB, limit: 5 * GIB }))).toBe(
            'Pausing new work — free disk is below its floor (3 GiB of 5 GiB)',
        );
        expect(render(item('throttled', { reason: null }))).toBe('Pausing new work');
    });

    it('quarantined, consent missing and helper untrusted name the computer', () => {
        expect(
            render(item('quarantined', { name: 'design-mac', reason: 'process tree unproven' })),
        ).toBe('design-mac stopped itself: process tree unproven');
        expect(render(item('quarantined', { name: 'design-mac', reason: null }))).toBe(
            'design-mac stopped itself',
        );
        expect(render(item('consentMissing', { name: 'win-lab' }, 'win-lab'))).toBe(
            'win-lab only reports health. Start it with --work, --attend or --manage to do more.',
        );
        expect(render(item('helperUntrusted', {}))).toBe(
            "design-mac's screen helper runs with reduced trust",
        );
    });

    it('answers null for an item it does not own, so the renderer shows the English title', () => {
        expect(needsALookCopy(item('somethingElse', {}), 'en-GB')).toBeNull();
        expect(needsALookCopy({ ...item('x', {}), messageKey: undefined }, 'en-GB')).toBeNull();
    });

    it('every action label key the producers send exists', () => {
        const actions = (
            messages as unknown as { fleet: { needsALook: { actions: Record<string, string> } } }
        ).fleet.needsALook.actions;
        for (const key of [
            'open',
            'clearLimitNow',
            'clearLimitsNow',
            'changeLimits',
            'showCommand',
        ]) {
            expect(actions[key], key).toBeTruthy();
        }
    });
});

describe('Fleet UI registry (seam owned by FL-01)', () => {
    it('FL-03 registers its metrics block first on the Overview tab', () => {
        const blocks = getOverviewBlocks();
        expect(blocks[0]).toMatchObject({ id: HEALTH_METRICS_BLOCK_ID, epic: 'FL-03', order: 10 });
        expect(typeof blocks[0].load).toBe('function');
    });

    it('orders entries and replaces one registered twice under the same id', () => {
        const load = async () => ({ default: () => null });
        registerOverviewBlock({ id: 'zz-late', order: 90, epic: 'FL-99', load });
        registerOverviewBlock({ id: 'aa-early', order: 5, epic: 'FL-99', load });
        registerOverviewBlock({ id: 'zz-late', order: 1, epic: 'FL-99', load });
        const ids = getOverviewBlocks().map((entry) => entry.id);
        expect(ids.slice(0, 3)).toEqual(['zz-late', 'aa-early', HEALTH_METRICS_BLOCK_ID]);
        expect(ids.filter((id) => id === 'zz-late')).toHaveLength(1);

        registerComputerTab({
            id: 'overview',
            order: 0,
            epic: 'FL-01',
            labelKey: 'fleet.computer.tabs.overview',
            load,
        });
        expect(getComputerTabs().map((entry) => entry.id)).toContain('overview');
    });
});

describe('fleet strings in en.json (CONTRACTS §11.4)', () => {
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
        for (const group of ['states', 'stateSentences', 'fixCommands', 'health', 'needsALook']) {
            expect(fleet[group], group).toBeTruthy();
            leaves(fleet[group], `fleet.${group}`, out);
        }
        expect(out.length).toBeGreaterThan(80);
        for (const [path, value] of out) expect(value.trim(), path).not.toBe('');
    });
});
