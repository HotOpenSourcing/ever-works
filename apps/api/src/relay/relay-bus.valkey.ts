import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import {
    decodeRelayEnvelope,
    encodeRelayEnvelope,
    isRelayBusTopic,
    isRelayReplicaId,
    newRelayReplicaId,
    RELAY_BUS_KEY_PREFIX,
    RELAY_BUS_LEAVE_TOPIC,
    RELAY_BUS_PRESENCE_INTERVAL_MS,
    RELAY_BUS_PRESENCE_TOPIC,
    RELAY_BUS_PRESENCE_TTL_MS,
    type RelayBus,
    type RelayBusHandler,
    type RelayBusHealth,
} from './relay-bus';

/**
 * The relay bus over Valkey (CONTRACTS R-7) — ioredis pub/sub.
 *
 * Two connections, as pub/sub requires: one publishes (and answers
 * `claimOnce`), one only subscribes. Two channels:
 *
 *  - `ew:relay:all` — broadcast; every replica subscribes;
 *  - `ew:relay:to:<replicaId>` — addressed to one replica.
 *
 * Every message is `1␟<from>␟<topic>␟<body>`; a replica drops its own
 * broadcasts. Every {@link RELAY_BUS_PRESENCE_INTERVAL_MS} each replica sends a
 * presence beacon, and answers a newcomer's at once, so `peers()` knows who is
 * there; a replica not heard from for {@link RELAY_BUS_PRESENCE_TTL_MS} is
 * gone. Broadcasts are skipped while nobody else is there.
 *
 * The publisher keeps no offline queue: while Valkey is unreachable a publish
 * is dropped (relays are live, not durable) and `claimOnce` throws, so a
 * single-use token is refused rather than accepted twice. ioredis reconnects
 * on its own; health reads `degraded` meanwhile. The URL is never logged — it
 * may carry a password.
 */

/** The ioredis surface this bus uses — what the spec's double implements. */
export interface RelayRedisClient {
    readonly status: string;
    publish(channel: string, message: string): Promise<number>;
    subscribe(...channels: string[]): Promise<unknown>;
    set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
    on(event: string, listener: (...args: any[]) => void): unknown;
    quit(): Promise<unknown>;
    disconnect(): void;
}

export interface ValkeyRelayBusOptions {
    url: string;
    createClient?: (url: string, role: 'publisher' | 'subscriber') => RelayRedisClient;
    now?: () => number;
    presenceIntervalMs?: number;
    presenceTtlMs?: number;
    replicaId?: string;
}

const BROADCAST_CHANNEL = `${RELAY_BUS_KEY_PREFIX}all`;
const directChannel = (replicaId: string) => `${RELAY_BUS_KEY_PREFIX}to:${replicaId}`;
const ONCE_PREFIX = `${RELAY_BUS_KEY_PREFIX}once:`;

function defaultClient(url: string, role: 'publisher' | 'subscriber'): RelayRedisClient {
    const retryStrategy = (times: number) => Math.min(times * 500, 5_000);
    return new Redis(url, {
        connectTimeout: 5_000,
        retryStrategy,
        // The subscriber queues its SUBSCRIBE until it is connected; the
        // publisher drops what it cannot send now.
        enableOfflineQueue: role === 'subscriber',
        maxRetriesPerRequest: role === 'publisher' ? 1 : null,
        commandTimeout: role === 'publisher' ? 2_000 : undefined,
        autoResubscribe: true,
        connectionName: `ever-works-relay-${role}`,
    }) as unknown as RelayRedisClient;
}

export class ValkeyRelayBus implements RelayBus {
    readonly mode = 'valkey' as const;
    readonly replicaId: string;
    private readonly logger = new Logger('RelayBus');
    private readonly publisher: RelayRedisClient;
    private readonly subscriber: RelayRedisClient;
    private readonly now: () => number;
    private readonly presenceTtlMs: number;
    private readonly handlers = new Map<string, Set<RelayBusHandler>>();
    private readonly heard = new Map<string, number>();
    private readonly peerListeners = new Set<(replicaId: string, present: boolean) => void>();
    private readonly presenceTimer: NodeJS.Timeout;
    private closed = false;
    private lastErrorLogAt = 0;

    constructor(options: ValkeyRelayBusOptions) {
        this.replicaId = options.replicaId ?? newRelayReplicaId(randomUUID());
        this.now = options.now ?? (() => Date.now());
        this.presenceTtlMs = options.presenceTtlMs ?? RELAY_BUS_PRESENCE_TTL_MS;
        const create = options.createClient ?? defaultClient;
        this.publisher = create(options.url, 'publisher');
        this.subscriber = create(options.url, 'subscriber');
        for (const client of [this.publisher, this.subscriber]) {
            client.on('error', (error: Error) => this.logError(error));
        }
        this.subscriber.on('message', (channel: string, message: string) =>
            this.dispatch(channel, message),
        );
        // Say hello as soon as the subscriber is (re)connected, so peers learn
        // of this replica without waiting for the next beacon.
        this.subscriber.on('ready', () => this.beacon());
        void this.subscriber.subscribe(BROADCAST_CHANNEL, directChannel(this.replicaId)).then(
            () => this.beacon(),
            (error: Error) => this.logError(error),
        );
        this.presenceTimer = setInterval(
            () => this.tick(),
            options.presenceIntervalMs ?? RELAY_BUS_PRESENCE_INTERVAL_MS,
        );
        this.presenceTimer.unref?.();
    }

    publish(topic: string, body: string): boolean {
        if (!isRelayBusTopic(topic) || !this.isUp() || this.peers().length === 0) return false;
        return this.send(BROADCAST_CHANNEL, topic, body);
    }

    sendTo(replicaId: string, topic: string, body: string): boolean {
        if (!isRelayReplicaId(replicaId) || replicaId === this.replicaId) return false;
        if (!isRelayBusTopic(topic) || !this.isUp()) return false;
        return this.send(directChannel(replicaId), topic, body);
    }

    subscribe(topic: string, handler: RelayBusHandler): () => void {
        if (!isRelayBusTopic(topic)) throw new Error(`invalid relay bus topic: ${topic}`);
        let set = this.handlers.get(topic);
        if (!set) {
            set = new Set();
            this.handlers.set(topic, set);
        }
        set.add(handler);
        return () => {
            set?.delete(handler);
        };
    }

    peers(): string[] {
        const cutoff = this.now() - this.presenceTtlMs;
        const present: string[] = [];
        for (const [replicaId, at] of this.heard) if (at > cutoff) present.push(replicaId);
        return present;
    }

    onPeerChange(listener: (replicaId: string, present: boolean) => void): () => void {
        this.peerListeners.add(listener);
        return () => {
            this.peerListeners.delete(listener);
        };
    }

    health(): RelayBusHealth {
        return { configured: true, mode: 'valkey', status: this.isUp() ? 'up' : 'degraded' };
    }

    async claimOnce(key: string, ttlMs: number): Promise<boolean> {
        if (this.publisher.status !== 'ready') throw new Error('the relay bus is not connected');
        const answer = await this.publisher.set(
            `${ONCE_PREFIX}${key}`,
            '1',
            'PX',
            Math.max(1, Math.ceil(ttlMs)),
            'NX',
        );
        return answer === 'OK';
    }

    async close(): Promise<void> {
        if (this.closed) return;
        // Say goodbye first, while the bus still counts as up.
        if (this.isUp()) this.send(BROADCAST_CHANNEL, RELAY_BUS_LEAVE_TOPIC, '');
        this.closed = true;
        clearInterval(this.presenceTimer);
        await Promise.all(
            [this.publisher, this.subscriber].map(async (client) => {
                try {
                    await client.quit();
                } catch {
                    client.disconnect();
                }
            }),
        );
        this.handlers.clear();
        this.peerListeners.clear();
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private isUp(): boolean {
        return (
            !this.closed && this.publisher.status === 'ready' && this.subscriber.status === 'ready'
        );
    }

    private send(channel: string, topic: string, body: string): boolean {
        try {
            void this.publisher
                .publish(channel, encodeRelayEnvelope(this.replicaId, topic, body))
                .catch((error: Error) => this.logError(error));
            return true;
        } catch (error) {
            this.logError(error as Error);
            return false;
        }
    }

    private beacon(): void {
        if (!this.closed && this.publisher.status === 'ready') {
            this.send(BROADCAST_CHANNEL, RELAY_BUS_PRESENCE_TOPIC, '');
        }
    }

    private tick(): void {
        this.beacon();
        const cutoff = this.now() - this.presenceTtlMs;
        for (const [replicaId, at] of [...this.heard]) {
            if (at > cutoff) continue;
            this.heard.delete(replicaId);
            this.emitPeer(replicaId, false);
        }
    }

    private dispatch(channel: string, raw: string): void {
        if (channel !== BROADCAST_CHANNEL && channel !== directChannel(this.replicaId)) return;
        const envelope = decodeRelayEnvelope(raw);
        if (!envelope || envelope.from === this.replicaId) return;
        const { from, topic, body } = envelope;
        if (topic === RELAY_BUS_LEAVE_TOPIC) {
            if (this.heard.delete(from)) this.emitPeer(from, false);
            return;
        }
        const known = this.heard.has(from);
        this.heard.set(from, this.now());
        if (!known) {
            this.emitPeer(from, true);
            // A newcomer: answer its beacon directly so it knows this replica now.
            if (this.isUp()) this.send(directChannel(from), RELAY_BUS_PRESENCE_TOPIC, '');
        }
        if (topic === RELAY_BUS_PRESENCE_TOPIC) return;
        for (const handler of [...(this.handlers.get(topic) ?? [])]) {
            try {
                handler(body, from);
            } catch (error) {
                this.logger.warn(
                    `relay bus handler for ${topic} failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
    }

    private emitPeer(replicaId: string, present: boolean): void {
        for (const listener of [...this.peerListeners]) {
            try {
                listener(replicaId, present);
            } catch {
                // a listener's failure is its own
            }
        }
    }

    private logError(error: Error): void {
        // ioredis repeats a connection error on every retry: one line a minute.
        const now = this.now();
        if (now - this.lastErrorLogAt < 60_000) return;
        this.lastErrorLogAt = now;
        this.logger.warn(`relay bus connection: ${error?.message ?? String(error)}`);
    }
}
