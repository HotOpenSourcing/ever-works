import { Logger } from '@nestjs/common';
import { FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS } from '@ever-works/contracts';
import { FleetNodeHealthService } from '../fleet-node-health.service';
import type { FleetNodeHealthSampleRepository } from '../fleet-node-health-sample.repository';

/**
 * Computer health (FL-03) — the history writer's contract, against a fake
 * repository. The real SQL (roll-up, retention, idempotence) is exercised on
 * sqlite in `fleet-node-health-sample.repository.integration.spec.ts`.
 */
describe('FleetNodeHealthService', () => {
    const NOW = new Date('2026-10-18T09:41:00.000Z');
    let samples: {
        insertRaw: jest.Mock;
        hasHourly: jest.Mock;
        rawInHour: jest.Mock;
        insertHourly: jest.Mock;
        deleteBefore: jest.Mock;
    };
    let warn: jest.SpyInstance;

    beforeEach(() => {
        samples = {
            insertRaw: jest.fn(async () => undefined),
            hasHourly: jest.fn(async () => true),
            rawInHour: jest.fn(async () => []),
            insertHourly: jest.fn(async () => undefined),
            deleteBefore: jest.fn(async () => 0),
        };
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        process.env.FLEET_HEALTH_HISTORY_ENABLED = 'true';
    });

    afterEach(() => {
        warn.mockRestore();
        delete process.env.FLEET_HEALTH_HISTORY_ENABLED;
    });

    const build = () =>
        new FleetNodeHealthService(samples as unknown as FleetNodeHealthSampleRepository);

    describe('shouldSample (FR-18, FR-22)', () => {
        it('samples a node that has never been sampled', () => {
            expect(build().shouldSample(null, NOW)).toBe(true);
            expect(build().shouldSample({}, NOW)).toBe(true);
        });

        it('holds the 55 s floor from the row’s own marker', () => {
            const at = (ms: number) => ({ sampledAt: new Date(NOW.getTime() - ms).toISOString() });
            expect(build().shouldSample(at(FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS - 1), NOW)).toBe(
                false,
            );
            expect(build().shouldSample(at(FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS), NOW)).toBe(true);
            expect(build().shouldSample(at(60_000), NOW)).toBe(true);
        });

        it('never samples with the flag off', () => {
            delete process.env.FLEET_HEALTH_HISTORY_ENABLED;
            expect(build().shouldSample(null, NOW)).toBe(false);
        });
    });

    describe('record (U11)', () => {
        it('writes one raw row', () => {
            build().record('n1', NOW, { cpuPercent: 31 });
            expect(samples.insertRaw).toHaveBeenCalledWith('n1', NOW, { cpuPercent: 31 });
        });

        it('never throws — not on a synchronous throw, not on a rejection', async () => {
            samples.insertRaw.mockImplementationOnce(() => {
                throw new Error('pool exhausted');
            });
            expect(() => build().record('n1', NOW, { cpuPercent: 31 })).not.toThrow();
            samples.insertRaw.mockRejectedValueOnce(new Error('disk full'));
            const service = build();
            expect(() => service.record('n2', NOW, { cpuPercent: 31 })).not.toThrow();
            await new Promise((resolve) => setImmediate(resolve));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
        });

        it('logs a dropped sample once per node per hour, and never the snapshot itself', async () => {
            samples.insertRaw.mockRejectedValue(new Error('disk full'));
            const service = build();
            service.record('n1', NOW, { cpuPercent: 31 });
            service.record('n1', new Date(NOW.getTime() + 60_000), { cpuPercent: 32 });
            service.record('n2', NOW, { cpuPercent: 33 });
            service.record('n1', new Date(NOW.getTime() + 61 * 60_000), { cpuPercent: 34 });
            await new Promise((resolve) => setImmediate(resolve));
            expect(warn).toHaveBeenCalledTimes(3);
            expect(warn.mock.calls.flat().join(' ')).not.toContain('cpuPercent');
        });
    });

    describe('rollupAndPrune', () => {
        it('does nothing at all with the flag off (FR-22)', async () => {
            delete process.env.FLEET_HEALTH_HISTORY_ENABLED;
            expect(await build().rollupAndPrune(NOW)).toEqual({
                enabled: false,
                rolledHours: 0,
                hourlyRows: 0,
                prunedRaw: 0,
                prunedHourly: 0,
            });
            expect(samples.hasHourly).not.toHaveBeenCalled();
            expect(samples.deleteBefore).not.toHaveBeenCalled();
        });

        it('skips hours already rolled up and hours with no samples, and prunes 7 d raw / 90 d hourly', async () => {
            samples.deleteBefore.mockImplementation(async (resolution: string) =>
                resolution === 'raw' ? 5 : 2,
            );
            const summary = await build().rollupAndPrune(NOW);
            expect(summary).toEqual({
                enabled: true,
                rolledHours: 0,
                hourlyRows: 0,
                prunedRaw: 5,
                prunedHourly: 2,
            });
            expect(samples.insertHourly).not.toHaveBeenCalled();
            expect(samples.deleteBefore).toHaveBeenCalledWith(
                'raw',
                new Date(NOW.getTime() - 7 * 24 * 3_600_000),
            );
            expect(samples.deleteBefore).toHaveBeenCalledWith(
                'hourly',
                new Date(NOW.getTime() - 90 * 24 * 3_600_000),
            );
        });

        it('only rolls up hours that have ENDED (with a settle margin), never the current one', async () => {
            samples.hasHourly.mockResolvedValue(false);
            await build().rollupAndPrune(NOW);
            const hours = samples.hasHourly.mock.calls.map(([hour]) =>
                (hour as Date).toISOString(),
            );
            // 09:41 now: the newest hour rolled is 08:00-09:00; 09:00-10:00 is still open.
            expect(hours[hours.length - 1]).toBe('2026-10-18T08:00:00.000Z');
            expect(hours).not.toContain('2026-10-18T09:00:00.000Z');
        });
    });
});
