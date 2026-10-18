import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import {
    FLEET_LINK_RESUME_WINDOW_MS,
    FLEET_OPERATION_RETENTION_MS,
    isFleetOperationTerminal,
    makeFleetLinkError,
    type FleetLinkError,
    type FleetLinkFamily,
    type FleetLinkOperationProgressValue,
    type FleetOperationCancelResult,
    type FleetOperationView,
} from '@ever-works/contracts';
import { fleetLinkError } from './fleet-link.errors';
import { FleetLinkRegistry, type FleetLinkOperationMessage } from './fleet-link.registry';

/**
 * Fleet node link — long operations (CONTRACTS §3.3, spec FR-17, FR-18).
 *
 * A request the node could not finish within two seconds replied with an
 * `operationId`; from then on the node reports `operation.progress` and
 * `operation.done` on channel 0 and this service keeps the record:
 *
 *  - readable at `GET /api/fleet/operations/:id` by the person it belongs to
 *    (who asked, or the node's owner) until one hour after it completed;
 *    anyone else gets `not_found`, never a hint that it exists;
 *  - cancellable at `DELETE /api/fleet/operations/:id`, which sends
 *    `operation.cancel` to the node; the node's `operation.done` then reads
 *    `cancelled`;
 *  - updated only by the node that runs it — a node cannot touch another
 *    node's operation;
 *  - one the node never finished is failed after
 *    {@link FLEET_OPERATION_MAX_RUNNING_MS} so nothing is "running" forever.
 *
 * Request state, not work: the records live in this process (and, with the
 * relay bus, are visible to every replica through it).
 */

/** An operation still running after this long is failed — the node never said it finished. */
export const FLEET_OPERATION_MAX_RUNNING_MS = 24 * 60 * 60_000;

/** Most operation records one process keeps (oldest finished go first). */
export const FLEET_OPERATION_MAX_RECORDS = 10_000;

const SWEEP_INTERVAL_MS = 60_000;

export interface FleetOperationRecord {
    view: FleetOperationView;
    /** The person who asked (null for a system caller). */
    requesterUserId: string | null;
    /** The node's owner. */
    ownerUserId: string;
    /** Epoch ms of completion, for retention. */
    endedAtMs: number | null;
    startedAtMs: number;
}

export interface FleetOperationsOptions {
    now?: () => number;
    retentionMs?: number;
    maxRunningMs?: number;
    /** How long a dropped link may stay away before its running operations read `interrupted`. */
    resumeWindowMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export const FLEET_OPERATIONS_OPTIONS = 'FLEET_OPERATIONS_OPTIONS' as const;

@Injectable()
export class FleetOperationsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(FleetOperationsService.name);
    private readonly records = new Map<string, FleetOperationRecord>();
    private readonly now: () => number;
    private readonly retentionMs: number;
    private readonly maxRunningMs: number;
    private sweeper: NodeJS.Timeout | null = null;
    private readonly resumeWindowMs: number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private readonly awayTimers = new Map<string, unknown>();
    private readonly unsubscribeLinks: () => void;

    constructor(
        private readonly registry: FleetLinkRegistry,
        @Optional() @Inject(FLEET_OPERATIONS_OPTIONS) options?: FleetOperationsOptions,
    ) {
        this.now = options?.now ?? (() => Date.now());
        this.retentionMs = options?.retentionMs ?? FLEET_OPERATION_RETENTION_MS;
        this.maxRunningMs = options?.maxRunningMs ?? FLEET_OPERATION_MAX_RUNNING_MS;
        this.resumeWindowMs = options?.resumeWindowMs ?? FLEET_LINK_RESUME_WINDOW_MS;
        this.setTimer =
            options?.setTimer ??
            ((callback, ms) => {
                const timer = setTimeout(callback, ms);
                timer.unref?.();
                return timer;
            });
        this.clearTimer =
            options?.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
        this.registry.setOperationSink((nodeId, message) => this.fromNode(nodeId, message));
        // CONTRACTS §3.3 (rev 5): the link or the node went away mid-operation.
        // A fresh node process cannot finish what the old one started; a link
        // that stays away past the resume window is treated the same.
        this.unsubscribeLinks = this.registry.onLinkEvent((event) => {
            const away = this.awayTimers.get(event.nodeId);
            if (away !== undefined) {
                this.clearTimer(away);
                this.awayTimers.delete(event.nodeId);
            }
            if (event.type === 'connected') {
                if (!event.continued)
                    this.interruptNode(
                        event.nodeId,
                        'the computer restarted while this was running',
                    );
                return;
            }
            this.awayTimers.set(
                event.nodeId,
                this.setTimer(() => {
                    this.awayTimers.delete(event.nodeId);
                    if (!this.registry.isConnected(event.nodeId)) {
                        this.interruptNode(
                            event.nodeId,
                            'the computer went away while this was running',
                        );
                    }
                }, this.resumeWindowMs),
            );
        });
    }

    onModuleInit(): void {
        this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        this.sweeper.unref?.();
    }

    onModuleDestroy(): void {
        if (this.sweeper) clearInterval(this.sweeper);
        for (const timer of this.awayTimers.values()) this.clearTimer(timer);
        this.awayTimers.clear();
        this.unsubscribeLinks();
        this.registry.setOperationSink(null);
    }

    /** Start tracking an operation the node just announced. */
    track(input: {
        operationId: string;
        nodeId: string;
        family: FleetLinkFamily;
        verb: string;
        requesterUserId: string | null;
        ownerUserId: string;
    }): FleetOperationView {
        const now = this.now();
        const existing = this.records.get(input.operationId);
        if (existing && existing.view.nodeId === input.nodeId) return { ...existing.view };
        const view: FleetOperationView = {
            id: input.operationId,
            nodeId: input.nodeId,
            family: input.family,
            verb: input.verb,
            state: 'running',
            progress: null,
            startedAt: new Date(now).toISOString(),
            endedAt: null,
            cancelRequested: false,
        };
        this.records.set(input.operationId, {
            view,
            requesterUserId: input.requesterUserId,
            ownerUserId: input.ownerUserId,
            endedAtMs: null,
            startedAtMs: now,
        });
        this.bound();
        return { ...view };
    }

    /** The operation as `userId` may see it, or `not_found`. */
    get(operationId: string, userId: string): FleetOperationView {
        return { ...this.require(operationId, userId).view };
    }

    /**
     * Ask the node to cancel a running operation (spec FR-18). An operation
     * that already ended answers as it is with `sent: false`; one whose node
     * is not connected answers `unreachable`.
     */
    cancel(operationId: string, userId: string): FleetOperationCancelResult {
        const record = this.require(operationId, userId);
        if (isFleetOperationTerminal(record.view.state))
            return { operation: { ...record.view }, sent: false };
        if (!this.registry.cancelOperation(record.view.nodeId, operationId)) {
            throw fleetLinkError(
                'unreachable',
                'the computer is not connected; the operation keeps running there',
                {
                    operationId,
                },
            );
        }
        record.view = { ...record.view, cancelRequested: true };
        return { operation: { ...record.view }, sent: true };
    }

    /** Remove expired records; fail operations the node never finished. Exposed for tests. */
    sweep(): void {
        const now = this.now();
        for (const [id, record] of this.records) {
            if (record.endedAtMs !== null) {
                if (now - record.endedAtMs >= this.retentionMs) this.records.delete(id);
                continue;
            }
            if (now - record.startedAtMs >= this.maxRunningMs) {
                this.end(record, {
                    state: 'failed',
                    error: makeFleetLinkError(
                        'operation_failed',
                        'the computer never reported this operation finished',
                    ),
                });
            }
        }
    }

    /** How many records are kept (tests and health). */
    get size(): number {
        return this.records.size;
    }

    /** Every running operation of a node ends `interrupted`; a late completion no longer changes it. */
    private interruptNode(nodeId: string, hint: string): void {
        for (const record of this.records.values()) {
            if (record.view.nodeId !== nodeId || isFleetOperationTerminal(record.view.state))
                continue;
            this.end(record, {
                state: 'interrupted',
                error: makeFleetLinkError('unreachable', hint),
            });
        }
    }

    private fromNode(nodeId: string, message: FleetLinkOperationMessage): void {
        const record = this.records.get(message.operationId);
        // Only the node that runs an operation may report on it.
        if (!record || record.view.nodeId !== nodeId || isFleetOperationTerminal(record.view.state))
            return;
        if (message.type === 'operation.progress') {
            record.view = {
                ...record.view,
                progress: { ...message.progress } as FleetLinkOperationProgressValue,
            };
            return;
        }
        if (message.error) {
            this.end(record, {
                state: record.view.cancelRequested ? 'cancelled' : 'failed',
                error: message.error,
            });
        } else {
            this.end(record, { state: 'done', result: message.result ?? null });
        }
    }

    private end(
        record: FleetOperationRecord,
        outcome: {
            state: 'done' | 'failed' | 'cancelled' | 'interrupted';
            result?: unknown;
            error?: FleetLinkError;
        },
    ): void {
        const now = this.now();
        const view: FleetOperationView = {
            ...record.view,
            state: outcome.state,
            endedAt: new Date(now).toISOString(),
        };
        if (outcome.error) view.error = outcome.error;
        if (outcome.state === 'done') view.result = outcome.result;
        record.view = view;
        record.endedAtMs = now;
    }

    private require(operationId: string, userId: string): FleetOperationRecord {
        const record = this.records.get(operationId);
        if (!record || (record.requesterUserId !== userId && record.ownerUserId !== userId)) {
            throw fleetLinkError('not_found', 'no such operation');
        }
        return record;
    }

    private bound(): void {
        if (this.records.size <= FLEET_OPERATION_MAX_RECORDS) return;
        // Oldest finished first, then the oldest of all.
        const finished = [...this.records].filter(([, record]) => record.endedAtMs !== null);
        const victims = finished.length > 0 ? finished : [...this.records];
        victims.sort(
            ([, a], [, b]) => (a.endedAtMs ?? a.startedAtMs) - (b.endedAtMs ?? b.startedAtMs),
        );
        while (this.records.size > FLEET_OPERATION_MAX_RECORDS && victims.length > 0) {
            const [id] = victims.shift()!;
            this.records.delete(id);
        }
        this.logger.warn(
            `operation records over ${FLEET_OPERATION_MAX_RECORDS}; the oldest were dropped`,
        );
    }
}
