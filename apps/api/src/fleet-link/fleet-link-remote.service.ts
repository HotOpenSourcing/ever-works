import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
    FLEET_LINK_CHANNEL_OPEN_TIMEOUT_MS,
    FLEET_LINK_CLOSE_CODES,
    FLEET_LINK_REQUEST_TIMEOUT_MS,
    isFleetLinkFamily,
    isFleetLinkFrameKind,
    normalizeFleetConsents,
    normalizeFleetLinkError,
    type FleetConsents,
    type FleetLinkCloseReason,
    type FleetLinkError,
    type FleetLinkExtensionMessage,
    type FleetLinkFamily,
    type FleetLinkFrameKind,
    type FleetLinkReply,
    type FleetNodeLinkView,
    type FleetOperationView,
} from '@ever-works/contracts';
import { RELAY_BUS, type RelayBus } from '../relay/relay-bus';
import { InProcessRelayBus } from '../relay/relay-bus.in-process';
import type { FleetLinkChannel, FleetLinkChannelEvents } from './fleet-link-channel';
import { FleetLinkException, fleetLinkError } from './fleet-link.errors';
import {
    FleetLinkRegistry,
    type FleetLinkEvent,
    type FleetLinkLinkSnapshot,
} from './fleet-link.registry';
import type { FleetLinkRequirement } from './fleet-link.types';

/**
 * Fleet node link across API replicas (FL-02, CONTRACTS R-7, spec FR-29, S7).
 *
 * A node's link lands on one replica; a viewer's socket, a REST call or a
 * heartbeat can land on any. Over the relay bus this service:
 *
 *  - **keeps a directory** of which replica holds which node's link: a
 *    replica announces each link it accepts and each it loses, re-sends its
 *    whole list every {@link FLEET_LINK_DIRECTORY_SYNC_MS} (and at once to a
 *    replica that just joined), and an entry not refreshed for
 *    {@link FLEET_LINK_DIRECTORY_TTL_MS} — or whose replica left — is gone.
 *    A link accepted on one replica closes an older one for the same node on
 *    another (`4010`), so a node has one link fleet-wide;
 *  - **forwards** a request, a channel (open, frames both ways, close,
 *    resume) and a channel-0 control to the holder, and answers the caller as
 *    if the link were local. The caller was authorised on its own replica
 *    before anything is forwarded; the holder applies its registry's own
 *    rules (channel count, the link being there);
 *  - **fans out** what every replica must act on for a node it may hold:
 *    consents a heartbeat reported, drain-all, a node that is gone;
 *  - **replicates operation records** so `GET /api/fleet/operations/:id`
 *    answers on any replica.
 *
 * Channel-0 family messages from a node (`onNodeControl`) are handled on the
 * replica that holds its link only — never replayed elsewhere, so nothing a
 * node reports is processed twice. A link that moves to another replica does
 * not carry its resumable channels with it: they close `resume_failed` and
 * their viewers reattach (resume works when the node comes back to the same
 * replica).
 *
 * With the single-replica bus every method answers "not held elsewhere" and
 * sends nothing.
 */

/** How often a replica re-sends the list of links it holds. */
export const FLEET_LINK_DIRECTORY_SYNC_MS = 10_000;

/** A directory entry not refreshed for this long is gone. */
export const FLEET_LINK_DIRECTORY_TTL_MS = 30_000;

/** Extra time a forwarded call waits for the bus round trip, beyond the holder's own timeout. */
export const FLEET_LINK_REMOTE_MARGIN_MS = 2_000;

/** How long a forwarded channel-0 control waits for the holder's answer. */
export const FLEET_LINK_REMOTE_CONTROL_TIMEOUT_MS = 3_000;

const DIRECTORY_TOPIC = 'fleet-link.dir';
const RPC_TOPIC = 'fleet-link.rpc';
const FAN_TOPIC = 'fleet-link.fan';
const OPS_TOPIC = 'fleet-link.ops';

/** A link another replica holds, as its directory entry says. */
export interface FleetLinkRemoteEntry {
    replicaId: string;
    link: FleetLinkLinkSnapshot;
    seenAt: number;
}

/** An operation record as it travels between replicas. */
export interface FleetOperationSnapshot {
    view: FleetOperationView;
    requesterUserId: string | null;
    ownerUserId: string;
    startedAtMs: number;
    endedAtMs: number | null;
}

export interface FleetLinkRemoteOptions {
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    syncIntervalMs?: number;
    entryTtlMs?: number;
}

export const FLEET_LINK_REMOTE_OPTIONS = 'FLEET_LINK_REMOTE_OPTIONS' as const;

type Json = Record<string, unknown>;

interface Pending {
    holder: string;
    resolve(value: unknown): void;
    reject(error: FleetLinkException): void;
    timer: unknown;
}

interface Served {
    origin: string;
    ref: string;
    channel: FleetLinkChannel;
}

function parse(body: string): Json | null {
    try {
        const value: unknown = JSON.parse(body);
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
    } catch {
        return null;
    }
}

const isString = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256;

function asError(value: unknown): FleetLinkError {
    return (
        normalizeFleetLinkError(value) ?? {
            code: 'unreachable',
            hint: 'the computer did not answer',
        }
    );
}

function snapshotOf(value: unknown): FleetLinkLinkSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Json;
    const consents = normalizeFleetConsents(record.consents);
    if (
        !isString(record.nodeId) ||
        typeof record.generation !== 'number' ||
        typeof record.connectedAt !== 'number' ||
        consents === null
    ) {
        return null;
    }
    const count = (field: unknown) =>
        typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : 0;
    return {
        nodeId: record.nodeId,
        generation: record.generation,
        connectedAt: record.connectedAt,
        consents,
        bytesIn: count(record.bytesIn),
        bytesOut: count(record.bytesOut),
        openChannels: count(record.openChannels),
    };
}

@Injectable()
export class FleetLinkRemote implements OnModuleDestroy {
    private readonly logger = new Logger(FleetLinkRemote.name);
    private readonly bus: RelayBus;
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private readonly entryTtlMs: number;
    private readonly directory = new Map<string, FleetLinkRemoteEntry>();
    private readonly pending = new Map<string, Pending>();
    private readonly opened = new Map<string, RemoteFleetLinkChannel>();
    private readonly served = new Map<string, Served>();
    private readonly linkListeners = new Set<(event: FleetLinkEvent) => void>();
    private readonly operationListeners = new Set<(snapshot: FleetOperationSnapshot) => void>();
    private readonly cancelListeners = new Set<(operationId: string) => void>();
    private readonly unsubscribe: Array<() => void> = [];
    private syncTimer: unknown = null;
    private readonly syncIntervalMs: number;

    constructor(
        private readonly registry: FleetLinkRegistry,
        @Optional() @Inject(RELAY_BUS) bus?: RelayBus,
        @Optional() @Inject(FLEET_LINK_REMOTE_OPTIONS) options?: FleetLinkRemoteOptions,
    ) {
        this.bus = bus ?? new InProcessRelayBus();
        this.now = options?.now ?? (() => Date.now());
        this.setTimer =
            options?.setTimer ??
            ((callback, ms) => {
                const timer = setTimeout(callback, ms);
                timer.unref?.();
                return timer;
            });
        this.clearTimer =
            options?.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
        this.entryTtlMs = options?.entryTtlMs ?? FLEET_LINK_DIRECTORY_TTL_MS;
        this.syncIntervalMs = options?.syncIntervalMs ?? FLEET_LINK_DIRECTORY_SYNC_MS;
        if (this.bus.mode === 'single-replica') return;
        this.unsubscribe.push(
            this.bus.subscribe(DIRECTORY_TOPIC, (body, from) => this.onDirectory(body, from)),
            this.bus.subscribe(RPC_TOPIC, (body, from) => this.onRpc(body, from)),
            this.bus.subscribe(FAN_TOPIC, (body) => this.onFan(body)),
            this.bus.subscribe(OPS_TOPIC, (body) => this.onOps(body)),
            this.bus.onPeerChange((replicaId, present) => this.onPeer(replicaId, present)),
            this.registry.onLinkEvent((event) => this.onLocalLink(event)),
        );
        this.scheduleSync();
    }

    onModuleDestroy(): void {
        for (const stop of this.unsubscribe.splice(0)) stop();
        if (this.syncTimer !== null) this.clearTimer(this.syncTimer);
        this.syncTimer = null;
        for (const [rid, pending] of this.pending) {
            this.clearTimer(pending.timer);
            pending.reject(fleetLinkError('unreachable', 'the API is shutting down'));
            this.pending.delete(rid);
        }
        for (const channel of [...this.opened.values()]) channel.end('normal');
        for (const served of [...this.served.values()]) served.channel.close('normal');
    }

    get replicaId(): string {
        return this.bus.replicaId;
    }

    // ─── Directory ─────────────────────────────────────────────────────────

    /** The replica holding `nodeId`'s link, or null (held here, or nowhere this replica knows). */
    holderOf(nodeId: string): string | null {
        if (this.registry.isConnected(nodeId)) return null;
        const entry = this.directory.get(nodeId);
        if (!entry) return null;
        if (this.now() - entry.seenAt >= this.entryTtlMs) {
            this.forget(nodeId, 'directory entry expired');
            return null;
        }
        return entry.replicaId;
    }

    /** True when another replica holds `nodeId`'s link. */
    isHeldElsewhere(nodeId: string): boolean {
        return this.holderOf(nodeId) !== null;
    }

    /** The consents the node's link presented on the replica that holds it. */
    liveConsents(nodeId: string): FleetConsents | null {
        return this.holderOf(nodeId) !== null
            ? { ...this.directory.get(nodeId)!.link.consents }
            : null;
    }

    /** The link as the holding replica last described it, or null. */
    linkView(nodeId: string): FleetNodeLinkView | null {
        if (this.holderOf(nodeId) === null) return null;
        const { link } = this.directory.get(nodeId)!;
        return {
            state: 'connected',
            since: new Date(link.connectedAt).toISOString(),
            linkGeneration: link.generation,
            bytesIn: link.bytesIn,
            bytesOut: link.bytesOut,
            openChannels: link.openChannels,
        };
    }

    /** Links coming and going on OTHER replicas (`continued` is always true: only the holder can tell). */
    onLinkEvent(listener: (event: FleetLinkEvent) => void): () => void {
        this.linkListeners.add(listener);
        return () => {
            this.linkListeners.delete(listener);
        };
    }

    // ─── Forwarding (the caller's side) ────────────────────────────────────

    /** One request on the node's `machine` channel, on the replica that holds the link. */
    request(input: {
        nodeId: string;
        verb: string;
        params: Record<string, unknown>;
        requestedBy: string;
        timeoutMs?: number;
    }): Promise<FleetLinkReply> {
        const holder = this.requireHolder(input.nodeId);
        const timeoutMs = input.timeoutMs ?? FLEET_LINK_REQUEST_TIMEOUT_MS;
        return this.call<FleetLinkReply>(
            holder,
            { op: 'mreq', ...input, timeoutMs },
            timeoutMs + FLEET_LINK_REMOTE_MARGIN_MS,
        );
    }

    /** Open a channel of `family` on the replica that holds the link. */
    async openChannel(input: {
        nodeId: string;
        family: FleetLinkFamily;
        params: Record<string, unknown>;
        requirement: FleetLinkRequirement;
        requestedBy: string;
        events?: FleetLinkChannelEvents;
    }): Promise<FleetLinkChannel> {
        const holder = this.requireHolder(input.nodeId);
        const ref = randomUUID();
        const channel = new RemoteFleetLinkChannel(this, holder, ref, input.nodeId, input.family);
        if (input.events) channel.listen(input.events);
        this.opened.set(ref, channel);
        try {
            const answer = await this.call<{ channel: number; generation: number | null }>(
                holder,
                {
                    op: 'open',
                    ref,
                    nodeId: input.nodeId,
                    family: input.family,
                    params: input.params,
                    requirement: input.requirement,
                    requestedBy: input.requestedBy,
                },
                FLEET_LINK_CHANNEL_OPEN_TIMEOUT_MS + FLEET_LINK_REMOTE_MARGIN_MS,
                ref,
            );
            channel.markOpen(answer.channel, answer.generation);
            return channel;
        } catch (error) {
            this.opened.delete(ref);
            channel.end('normal', undefined, false);
            throw error;
        }
    }

    /** Send a channel-0 control to the node on the replica that holds the link. */
    async sendNodeControl(nodeId: string, message: FleetLinkExtensionMessage): Promise<boolean> {
        const holder = this.holderOf(nodeId);
        if (!holder) return false;
        try {
            return (
                (
                    await this.call<{ sent: boolean }>(
                        holder,
                        { op: 'ctl', nodeId, message },
                        FLEET_LINK_REMOTE_CONTROL_TIMEOUT_MS,
                    )
                ).sent === true
            );
        } catch {
            return false;
        }
    }

    /** Ask the holder to cancel an operation (it marks the record first, then tells the node). */
    async cancelOperation(nodeId: string, operationId: string): Promise<boolean> {
        const holder = this.holderOf(nodeId);
        if (!holder) return false;
        try {
            return (
                (
                    await this.call<{ sent: boolean }>(
                        holder,
                        { op: 'cancel', nodeId, operationId },
                        FLEET_LINK_REMOTE_CONTROL_TIMEOUT_MS,
                    )
                ).sent === true
            );
        } catch {
            return false;
        }
    }

    // ─── Fan-out ───────────────────────────────────────────────────────────

    /** A heartbeat's consents for a node whose link another replica holds. */
    forwardConsents(nodeId: string, consents: FleetConsents): void {
        const holder = this.holderOf(nodeId);
        if (holder) this.send(holder, FAN_TOPIC, { op: 'consents', nodeId, consents });
    }

    /** Drain-all on every replica's links. */
    broadcastDrain(nodeIds: readonly string[], graceSec: number): void {
        if (nodeIds.length > 0)
            this.broadcast(FAN_TOPIC, { op: 'drain', nodeIds: [...nodeIds], graceSec });
    }

    /** A node removed or re-keyed: whichever replica holds its link closes it. */
    broadcastGone(nodeId: string, reason: string): void {
        this.broadcast(FAN_TOPIC, { op: 'gone', nodeId, reason });
    }

    // ─── Operations ────────────────────────────────────────────────────────

    publishOperation(snapshot: FleetOperationSnapshot): void {
        this.broadcast(OPS_TOPIC, { op: 'view', snapshot });
    }

    onOperation(listener: (snapshot: FleetOperationSnapshot) => void): () => void {
        this.operationListeners.add(listener);
        return () => {
            this.operationListeners.delete(listener);
        };
    }

    /** A peer asked this replica (the holder) to cancel an operation: mark it before telling the node. */
    onCancelRequest(listener: (operationId: string) => void): () => void {
        this.cancelListeners.add(listener);
        return () => {
            this.cancelListeners.delete(listener);
        };
    }

    // ─── Internals the remote channel calls ────────────────────────────────

    /** @internal */
    sendOnChannel(holder: string, message: Json): boolean {
        return this.send(holder, RPC_TOPIC, message);
    }

    /** @internal */
    callOnChannel<T>(holder: string, message: Json, timeoutMs: number, ref: string): Promise<T> {
        return this.call<T>(holder, message, timeoutMs, ref);
    }

    /** @internal */
    forgetChannel(ref: string): void {
        this.opened.delete(ref);
    }

    // ─── Bus plumbing ──────────────────────────────────────────────────────

    private requireHolder(nodeId: string): string {
        const holder = this.holderOf(nodeId);
        if (!holder) throw fleetLinkError('unreachable', 'the computer is not connected');
        return holder;
    }

    private call<T>(holder: string, message: Json, timeoutMs: number, ref?: string): Promise<T> {
        const rid = randomUUID();
        return new Promise<T>((resolve, reject) => {
            const timer = this.setTimer(() => {
                if (!this.pending.delete(rid)) return;
                reject(
                    fleetLinkError(
                        'unreachable',
                        'the API replica holding this computer did not answer',
                    ),
                );
            }, timeoutMs);
            this.pending.set(rid, {
                holder,
                resolve: resolve as (value: unknown) => void,
                reject,
                timer,
            });
            if (!this.send(holder, RPC_TOPIC, { ...message, rid, ...(ref ? { ref } : {}) })) {
                this.pending.delete(rid);
                this.clearTimer(timer);
                reject(fleetLinkError('unreachable', 'the relay bus could not carry the request'));
            }
        });
    }

    private settle(rid: unknown, outcome: { value: unknown } | { error: FleetLinkError }): void {
        if (typeof rid !== 'string') return;
        const pending = this.pending.get(rid);
        if (!pending) return;
        this.pending.delete(rid);
        this.clearTimer(pending.timer);
        if ('error' in outcome) pending.reject(new FleetLinkException(outcome.error));
        else pending.resolve(outcome.value);
    }

    private send(replicaId: string, topic: string, message: Json): boolean {
        try {
            return this.bus.sendTo(replicaId, topic, JSON.stringify(message));
        } catch {
            return false;
        }
    }

    private broadcast(topic: string, message: Json): boolean {
        try {
            return this.bus.publish(topic, JSON.stringify(message));
        } catch {
            return false;
        }
    }

    private scheduleSync(): void {
        this.syncTimer = this.setTimer(() => {
            this.syncTimer = null;
            this.broadcastSync();
            this.expire();
            this.scheduleSync();
        }, this.syncIntervalMs);
    }

    private localSnapshots(): FleetLinkLinkSnapshot[] {
        const out: FleetLinkLinkSnapshot[] = [];
        for (const nodeId of this.registry.connectedNodeIds()) {
            const snapshot = this.registry.describeLink(nodeId);
            if (snapshot) out.push(snapshot);
        }
        return out;
    }

    private broadcastSync(to?: string): void {
        const message = { op: 'sync', links: this.localSnapshots() };
        if (to) this.send(to, DIRECTORY_TOPIC, message);
        else this.broadcast(DIRECTORY_TOPIC, message);
    }

    private expire(): void {
        const cutoff = this.now() - this.entryTtlMs;
        for (const [nodeId, entry] of [...this.directory]) {
            if (entry.seenAt <= cutoff) this.forget(nodeId, 'directory entry expired');
        }
    }

    private remember(replicaId: string, link: FleetLinkLinkSnapshot): void {
        const known = this.directory.get(link.nodeId);
        this.directory.set(link.nodeId, { replicaId, link, seenAt: this.now() });
        // One link per node fleet-wide: a newer link elsewhere replaces ours.
        const local = this.registry.describeLink(link.nodeId);
        if (
            local &&
            (link.connectedAt > local.connectedAt ||
                (link.connectedAt === local.connectedAt && replicaId > this.bus.replicaId))
        ) {
            this.registry.closeNode(
                link.nodeId,
                FLEET_LINK_CLOSE_CODES.replaced,
                'replaced by a newer link on another API replica',
            );
        }
        if (!known || known.replicaId !== replicaId) {
            this.emitLink({
                type: 'connected',
                nodeId: link.nodeId,
                linkGeneration: link.generation,
                continued: true,
            });
        }
    }

    private forget(nodeId: string, reason: string): void {
        const entry = this.directory.get(nodeId);
        if (!entry) return;
        this.directory.delete(nodeId);
        for (const channel of [...this.opened.values()]) {
            if (channel.nodeId === nodeId && channel.holder === entry.replicaId)
                channel.end('resume_failed', 'the link to the computer dropped');
        }
        this.emitLink({ type: 'dropped', nodeId, reason });
    }

    private onPeer(replicaId: string, present: boolean): void {
        if (present) {
            // A replica that just joined learns this one's links at once.
            this.broadcastSync(replicaId);
            return;
        }
        for (const [nodeId, entry] of [...this.directory]) {
            if (entry.replicaId === replicaId) this.forget(nodeId, 'its API replica left');
        }
        for (const [rid, pending] of [...this.pending]) {
            if (pending.holder !== replicaId) continue;
            this.pending.delete(rid);
            this.clearTimer(pending.timer);
            pending.reject(
                fleetLinkError('unreachable', 'the API replica holding this computer went away'),
            );
        }
        for (const channel of [...this.opened.values()]) {
            if (channel.holder === replicaId)
                channel.end('resume_failed', 'the API replica holding this computer went away');
        }
        for (const [key, served] of [...this.served]) {
            if (served.origin !== replicaId) continue;
            this.served.delete(key);
            served.channel.close('normal');
        }
    }

    private onLocalLink(event: FleetLinkEvent): void {
        if (event.type === 'connected') {
            const link = this.registry.describeLink(event.nodeId);
            if (link) this.broadcast(DIRECTORY_TOPIC, { op: 'up', link });
            return;
        }
        this.broadcast(DIRECTORY_TOPIC, { op: 'down', nodeId: event.nodeId });
    }

    private emitLink(event: FleetLinkEvent): void {
        for (const listener of [...this.linkListeners]) {
            try {
                listener(event);
            } catch (error) {
                this.logger.warn(`remote link listener failed: ${describe(error)}`);
            }
        }
    }

    // ─── Receiving ─────────────────────────────────────────────────────────

    private onDirectory(body: string, from: string): void {
        const message = parse(body);
        if (!message) return;
        if (message.op === 'up') {
            const link = snapshotOf(message.link);
            if (link) this.remember(from, link);
            return;
        }
        if (message.op === 'down' && isString(message.nodeId)) {
            if (this.directory.get(message.nodeId)?.replicaId === from)
                this.forget(message.nodeId, 'its link closed');
            return;
        }
        if (message.op === 'sync' && Array.isArray(message.links)) {
            const listed = new Set<string>();
            for (const raw of message.links.slice(0, 100_000)) {
                const link = snapshotOf(raw);
                if (!link) continue;
                listed.add(link.nodeId);
                this.remember(from, link);
            }
            for (const [nodeId, entry] of [...this.directory]) {
                if (entry.replicaId === from && !listed.has(nodeId))
                    this.forget(nodeId, 'no longer held');
            }
        }
    }

    private onFan(body: string): void {
        const message = parse(body);
        if (!message) return;
        if (message.op === 'consents' && isString(message.nodeId)) {
            const consents = normalizeFleetConsents(message.consents);
            if (consents) this.registry.applyConsents(message.nodeId, consents);
            return;
        }
        if (message.op === 'drain' && Array.isArray(message.nodeIds)) {
            const graceSec = typeof message.graceSec === 'number' ? message.graceSec : 60;
            this.registry.drainNodes(message.nodeIds.filter(isString), graceSec);
            return;
        }
        if (message.op === 'gone' && isString(message.nodeId)) {
            this.registry.closeNode(
                message.nodeId,
                FLEET_LINK_CLOSE_CODES.auth,
                typeof message.reason === 'string' ? message.reason.slice(0, 64) : 'node removed',
            );
        }
    }

    private onOps(body: string): void {
        const message = parse(body);
        if (!message || message.op !== 'view' || !message.snapshot) return;
        const snapshot = message.snapshot as FleetOperationSnapshot;
        if (!snapshot.view || !isString(snapshot.view.id) || !isString(snapshot.view.nodeId))
            return;
        for (const listener of [...this.operationListeners]) {
            try {
                listener(snapshot);
            } catch (error) {
                this.logger.warn(`operation replication failed: ${describe(error)}`);
            }
        }
    }

    private onRpc(body: string, from: string): void {
        const message = parse(body);
        if (!message || typeof message.op !== 'string') return;
        switch (message.op) {
            // Answers to this replica's calls.
            case 'ok':
                this.settle(message.rid, { value: message.value });
                return;
            case 'err':
                this.settle(message.rid, { error: asError(message.error) });
                return;
            // Events on a channel this replica opened elsewhere.
            case 'json':
            case 'bin':
            case 'closed':
            case 'resumed': {
                const channel = isString(message.ref) ? this.opened.get(message.ref) : undefined;
                if (channel && channel.holder === from) channel.deliver(message);
                return;
            }
            // Calls from a peer, on this replica's links.
            case 'mreq':
                void this.serveMachineRequest(from, message);
                return;
            case 'open':
                void this.serveOpen(from, message);
                return;
            case 'ctl':
            case 'cancel':
                this.serveControl(from, message);
                return;
            case 'send.json':
            case 'send.bin':
            case 'close':
            case 'req':
                this.serveChannel(from, message);
                return;
            default:
                return;
        }
    }

    private answer(
        to: string,
        rid: unknown,
        outcome: { value: unknown } | { error: unknown },
    ): void {
        if (typeof rid !== 'string') return;
        const error =
            'error' in outcome
                ? outcome.error instanceof FleetLinkException
                    ? outcome.error.linkError
                    : asError(
                          (outcome.error as { linkError?: unknown })?.linkError ?? {
                              code: 'internal',
                              hint: 'the API replica holding this computer failed the request',
                          },
                      )
                : null;
        this.send(
            to,
            RPC_TOPIC,
            error
                ? { op: 'err', rid, error }
                : { op: 'ok', rid, value: (outcome as { value: unknown }).value },
        );
    }

    private async serveMachineRequest(from: string, message: Json): Promise<void> {
        try {
            if (!isString(message.nodeId) || !isString(message.verb)) {
                throw fleetLinkError('invalid', 'a forwarded request was malformed');
            }
            const channel = await this.registry.machineChannel(
                message.nodeId,
                isString(message.requestedBy) ? message.requestedBy : 'system:relay',
            );
            const reply = await channel.request(
                message.verb,
                message.params && typeof message.params === 'object'
                    ? (message.params as Json)
                    : {},
                {
                    timeoutMs:
                        typeof message.timeoutMs === 'number' ? message.timeoutMs : undefined,
                },
            );
            this.answer(from, message.rid, { value: reply });
        } catch (error) {
            this.answer(from, message.rid, { error });
        }
    }

    private async serveOpen(from: string, message: Json): Promise<void> {
        const ref = message.ref;
        if (!isString(ref) || !isString(message.nodeId) || !isFleetLinkFamily(message.family)) {
            this.answer(from, message.rid, {
                error: fleetLinkError('invalid', 'a forwarded open was malformed'),
            });
            return;
        }
        const key = `${from}|${ref}`;
        const forward = (payload: Json) => this.send(from, RPC_TOPIC, { ...payload, ref });
        try {
            const channel = await this.registry.openChannel({
                nodeId: message.nodeId,
                family: message.family,
                params:
                    message.params && typeof message.params === 'object'
                        ? (message.params as Json)
                        : {},
                requirement: message.requirement as FleetLinkRequirement,
                requestedBy: isString(message.requestedBy) ? message.requestedBy : 'system:relay',
                events: {
                    json: (m) => forward({ op: 'json', m }),
                    binary: (k, payload) =>
                        forward({ op: 'bin', k, p: Buffer.from(payload).toString('base64') }),
                    close: (reason, hint) => {
                        this.served.delete(key);
                        forward({ op: 'closed', reason, ...(hint ? { hint } : {}) });
                    },
                    resume: (generation) => forward({ op: 'resumed', generation }),
                },
            });
            this.served.set(key, { origin: from, ref, channel });
            this.answer(from, message.rid, {
                value: { channel: channel.channel, generation: channel.linkGeneration },
            });
        } catch (error) {
            this.answer(from, message.rid, { error });
        }
    }

    private serveControl(from: string, message: Json): void {
        if (!isString(message.nodeId)) {
            this.answer(from, message.rid, { value: { sent: false } });
            return;
        }
        if (message.op === 'cancel') {
            if (!isString(message.operationId)) {
                this.answer(from, message.rid, { value: { sent: false } });
                return;
            }
            for (const listener of [...this.cancelListeners]) {
                try {
                    listener(message.operationId);
                } catch {
                    // the record's own problem
                }
            }
            this.answer(from, message.rid, {
                value: { sent: this.registry.cancelOperation(message.nodeId, message.operationId) },
            });
            return;
        }
        const control = message.message as FleetLinkExtensionMessage | undefined;
        const sent =
            !!control && typeof control.type === 'string'
                ? this.registry.sendNodeControl(message.nodeId, control)
                : false;
        this.answer(from, message.rid, { value: { sent } });
    }

    private serveChannel(from: string, message: Json): void {
        const served = isString(message.ref)
            ? this.served.get(`${from}|${message.ref}`)
            : undefined;
        if (!served) {
            if (message.op === 'req')
                this.answer(from, message.rid, {
                    error: fleetLinkError('unreachable', 'the channel is closed'),
                });
            return;
        }
        const { channel } = served;
        switch (message.op) {
            case 'send.json':
                if (message.m && typeof message.m === 'object') channel.sendJson(message.m as Json);
                return;
            case 'send.bin': {
                if (!isFleetLinkFrameKind(message.k) || typeof message.p !== 'string') return;
                channel.sendBinary(message.k, Buffer.from(message.p, 'base64'));
                return;
            }
            case 'close':
                this.served.delete(`${from}|${message.ref}`);
                channel.close(
                    (message.reason as FleetLinkCloseReason) ?? 'normal',
                    typeof message.hint === 'string' ? message.hint : undefined,
                );
                return;
            case 'req':
                if (!isString(message.verb)) return;
                channel
                    .request(
                        message.verb,
                        message.params && typeof message.params === 'object'
                            ? (message.params as Json)
                            : {},
                        {
                            timeoutMs:
                                typeof message.timeoutMs === 'number'
                                    ? message.timeoutMs
                                    : undefined,
                        },
                    )
                    .then(
                        (reply) => this.answer(from, message.rid, { value: reply }),
                        (error) => this.answer(from, message.rid, { error }),
                    );
                return;
        }
    }
}

/**
 * A channel opened on the replica that holds the node's link, seen from the
 * replica that asked (the viewer's, the REST caller's). Frames go both ways
 * over the relay bus; events that arrive while the open is still being
 * answered are kept and delivered, in order, once it is.
 */
export class RemoteFleetLinkChannel implements FleetLinkChannel {
    private state: 'opening' | 'open' | 'closed' = 'opening';
    private number = 0;
    private generation: number | null = null;
    private readonly listeners = new Set<FleetLinkChannelEvents>();
    private early: Json[] = [];

    constructor(
        private readonly remote: FleetLinkRemote,
        readonly holder: string,
        private readonly ref: string,
        readonly nodeId: string,
        readonly family: FleetLinkFamily,
    ) {}

    get channel(): number {
        return this.number;
    }

    get isOpen(): boolean {
        return this.state === 'open';
    }

    get isClosed(): boolean {
        return this.state === 'closed';
    }

    get linkGeneration(): number | null {
        return this.generation;
    }

    request(
        verb: string,
        params: Record<string, unknown> = {},
        options: { timeoutMs?: number } = {},
    ): Promise<FleetLinkReply> {
        if (this.state !== 'open') {
            return Promise.reject(fleetLinkError('unreachable', 'the channel is closed'));
        }
        const timeoutMs = options.timeoutMs ?? FLEET_LINK_REQUEST_TIMEOUT_MS;
        return this.remote.callOnChannel<FleetLinkReply>(
            this.holder,
            { op: 'req', verb, params, timeoutMs },
            timeoutMs + FLEET_LINK_REMOTE_MARGIN_MS,
            this.ref,
        );
    }

    sendJson(message: Record<string, unknown>): boolean {
        if (this.state !== 'open') return false;
        return this.remote.sendOnChannel(this.holder, {
            op: 'send.json',
            ref: this.ref,
            m: message,
        });
    }

    sendBinary(kind: FleetLinkFrameKind, payload: Uint8Array): boolean {
        if (this.state !== 'open') return false;
        return this.remote.sendOnChannel(this.holder, {
            op: 'send.bin',
            ref: this.ref,
            k: kind,
            p: Buffer.from(payload).toString('base64'),
        });
    }

    close(reason: FleetLinkCloseReason = 'normal', hint?: string): void {
        if (this.state === 'closed') return;
        this.remote.sendOnChannel(this.holder, {
            op: 'close',
            ref: this.ref,
            reason,
            ...(hint ? { hint } : {}),
        });
        this.end(reason, hint);
    }

    listen(events: FleetLinkChannelEvents): () => void {
        this.listeners.add(events);
        return () => {
            this.listeners.delete(events);
        };
    }

    /** @internal — the holder accepted the open. */
    markOpen(channel: number, generation: number | null): void {
        if (this.state !== 'opening') return;
        this.state = 'open';
        this.number = channel;
        this.generation = generation;
        const early = this.early;
        this.early = [];
        for (const message of early) this.deliver(message);
    }

    /** @internal — a message from the holder about this channel. */
    deliver(message: Json): void {
        if (this.state === 'closed') return;
        if (this.state === 'opening') {
            if (this.early.length < 1_024) this.early.push(message);
            return;
        }
        switch (message.op) {
            case 'json':
                if (message.m && typeof message.m === 'object')
                    this.emit((listener) => listener.json?.(message.m as Json));
                return;
            case 'bin':
                if (isFleetLinkFrameKind(message.k) && typeof message.p === 'string') {
                    const payload = new Uint8Array(Buffer.from(message.p, 'base64'));
                    this.emit((listener) =>
                        listener.binary?.(message.k as FleetLinkFrameKind, payload),
                    );
                }
                return;
            case 'resumed':
                if (typeof message.generation === 'number') {
                    this.generation = message.generation;
                    this.emit((listener) => listener.resume?.(message.generation as number));
                }
                return;
            case 'closed':
                this.end(
                    (message.reason as FleetLinkCloseReason) ?? 'normal',
                    typeof message.hint === 'string' ? message.hint : undefined,
                );
                return;
        }
    }

    /** @internal — the channel is over, whichever side ended it. */
    end(reason: FleetLinkCloseReason, hint?: string, notify = true): void {
        if (this.state === 'closed') return;
        this.state = 'closed';
        this.early = [];
        this.remote.forgetChannel(this.ref);
        if (notify) this.emit((listener) => listener.close?.(reason, hint));
        this.listeners.clear();
    }

    private emit(deliver: (listener: FleetLinkChannelEvents) => void): void {
        for (const listener of [...this.listeners]) {
            try {
                deliver(listener);
            } catch {
                // a listener's failure is its own
            }
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
