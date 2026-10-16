import { describe, expect, it, vi } from 'vitest';
import { startRuntimeInOrder } from './start-order';

/**
 * #2598 a — a desktop node must not lease before its first heartbeat has
 * brought the owner's saved limit ceiling (and the version verdict).
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function fakeRuntime(firstBeat: Promise<void>) {
	const order: string[] = [];
	const loop = {
		start: vi.fn(async () => {
			order.push('loop.start');
			await firstBeat;
			order.push('first beat answered');
		})
	};
	const worker = {
		start: vi.fn(async () => {
			order.push('worker.start');
		})
	};
	return { order, loop, worker, runtime: { loop, worker } as never };
}

describe('startRuntimeInOrder', () => {
	it('starts the worker only after the first heartbeat has been answered', async () => {
		const beat = deferred();
		const { order, worker, runtime } = fakeRuntime(beat.promise);

		const started = startRuntimeInOrder(runtime, () => true);
		await Promise.resolve();
		await Promise.resolve();
		expect(worker.start).not.toHaveBeenCalled();

		beat.resolve();
		await started;
		expect(order).toEqual(['loop.start', 'first beat answered', 'worker.start']);
	});

	it('never starts the worker of a runtime disconnected during the first beat', async () => {
		const beat = deferred();
		const { worker, runtime } = fakeRuntime(beat.promise);
		let current = true;

		const started = startRuntimeInOrder(runtime, () => current);
		current = false; // the operator disconnected while the beat was in flight
		beat.resolve();
		await started;

		expect(worker.start).not.toHaveBeenCalled();
	});

	it('a visibility-only runtime (no worker) just starts the heartbeat', async () => {
		const loop = { start: vi.fn(async () => undefined) };
		await expect(startRuntimeInOrder({ loop } as never, () => true)).resolves.toBeUndefined();
		expect(loop.start).toHaveBeenCalledTimes(1);
	});
});
