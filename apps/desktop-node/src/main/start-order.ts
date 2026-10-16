import type { NodeRuntime } from 'ever-works-node';

/**
 * Start a freshly connected runtime in the order the CLI uses: the FIRST
 * heartbeat, then the worker (#2598 a).
 *
 * The first heartbeat's answer carries what must be in force before the
 * first lease: the owner's saved limit ceiling (slice AS) and the version
 * verdict (slice AR). `HeartbeatLoop.start()` resolves once that beat has
 * been answered and applied (it never rejects: a failed beat is reported
 * through the loop's state). Starting the worker alongside it instead let
 * a desktop with local concurrency 4 and a saved ceiling of 1 lease four
 * jobs before the ceiling arrived, and those jobs ran to completion.
 *
 * `isCurrent` guards a disconnect that lands while the first beat is in
 * flight: the worker of a runtime that is no longer the connected one is
 * never started.
 */
export async function startRuntimeInOrder(
	runtime: Pick<NodeRuntime, 'loop' | 'worker'>,
	isCurrent: () => boolean
): Promise<void> {
	await runtime.loop.start();
	if (!isCurrent()) return;
	await runtime.worker?.start();
}
