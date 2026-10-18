import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { testTranslations } = await import('./fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});
vi.mock('@/app/actions/settings/fleet', () => ({ clearFleetNodeModelThrottleAction: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
const fetchHealth = vi.fn();
vi.mock('@/app/actions/fleet-health', () => ({
    fetchFleetNodeHealthAction: (id: string) => fetchHealth(id),
}));

import HealthMetricsBlock from './overview/HealthMetricsBlock';

const node: FleetNodeView = {
    id: 'n1',
    name: 'build-01',
    kind: 'node',
    status: 'online',
    platform: 'linux/x64',
    version: '0.3.0',
    capabilities: [],
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: null,
    persisted: true,
    health: null,
};

/** Computer health (FL-03) — the registry block reads the health view once and offers Try again. */
describe('HealthMetricsBlock', () => {
    beforeEach(() => fetchHealth.mockReset());

    it('loads, then shows the fresh snapshot and the history footprint', async () => {
        fetchHealth.mockResolvedValue({
            success: true,
            data: {
                nodeId: 'n1',
                snapshot: { at: new Date().toISOString(), cpuPercent: 12 },
                stale: false,
                state: { state: 'online', params: {}, action: null },
                historyEnabled: true,
            },
            error: null,
        });
        render(<HealthMetricsBlock node={node} />);
        expect(screen.getByTestId('fleet-health-loading')).toBeTruthy();
        await waitFor(() =>
            expect(screen.getAllByTestId('fleet-health-card')[0].textContent).toBe('CPU12%'),
        );
        expect(screen.getByTestId('fleet-health-footprint').textContent).toContain(
            '7 days by the minute',
        );
        expect(fetchHealth).toHaveBeenCalledWith('n1');
    });

    it('a failed read says so and Try again reads once more', async () => {
        fetchHealth.mockResolvedValueOnce({ success: false, data: null, error: 'down' });
        render(<HealthMetricsBlock node={node} />);
        await waitFor(() => expect(screen.getByTestId('fleet-health-error')).toBeTruthy());
        fetchHealth.mockResolvedValueOnce({
            success: true,
            data: {
                nodeId: 'n1',
                snapshot: null,
                stale: true,
                state: { state: 'online', params: {}, action: null },
                historyEnabled: false,
            },
            error: null,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(screen.getByTestId('fleet-health-no-snapshot')).toBeTruthy());
        expect(fetchHealth).toHaveBeenCalledTimes(2);
    });
});
