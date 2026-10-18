/**
 * Relay bus (FL-02, CONTRACTS R-7, spec FR-29 … FR-31) — how one API replica
 * reaches the others.
 *
 * Every live relay of the platform keeps its sockets in its own process: the
 * terminal relay, the computer live view, and the node link. With more than
 * one API replica behind the load balancer, the browser's socket and the
 * machine's socket can land on different replicas; the bus is what carries
 * frames between them.
 *
 *  - **Valkey** whenever `getRedisUrl()` answers (`REDIS_URL`, or the
 *    throttler's `THROTTLER_REDIS_URL`) — pub/sub on two channels per
 *    replica set (one broadcast, one addressed to each replica), presence
 *    every few seconds, and `SET … NX PX` for things that must happen once
 *    fleet-wide (a single-use token).
 *  - **In-process** otherwise: no peers, nothing published, the per-process
 *    registries exactly as before. `GET /api/health/ready` says
 *    `fleet_relay: single-replica` so an operator can see the limit.
 *  - `FLEET_RELAY_REQUIRE_BUS=true` makes a missing bus a boot error, never a
 *    silently degraded relay. There is no other mode setting.
 *
 * Delivery is best-effort and at-most-once: local truth never depends on the
 * bus, and a replica trusts what it reads from it the way it trusts the
 * throttler's storage (plan §11, "replica trust"). Payloads are never logged.
 */

export const RELAY_BUS = 'RELAY_BUS' as const;

export type RelayBusMode = 'valkey' | 'single-replica';

/** `up` — every peer can be reached; `degraded` — the bus is configured but its connection is down. */
export type RelayBusStatus = 'up' | 'degraded';

/** What `GET /api/health/ready` reports as `fleet_relay`. */
export interface RelayBusHealth {
    configured: boolean;
    mode: RelayBusMode;
    status: RelayBusStatus;
}

/** A message for `topic` from another replica. */
export type RelayBusHandler = (body: string, fromReplicaId: string) => void;

export interface RelayBus {
    readonly mode: RelayBusMode;
    /** This process on the bus (random per process; never reused). */
    readonly replicaId: string;
    /**
     * Send `body` under `topic` to every OTHER replica. Never loops back.
     * False when nothing went out (no peer, or the bus is down).
     */
    publish(topic: string, body: string): boolean;
    /** Send `body` under `topic` to one replica. False when it could not go out. */
    sendTo(replicaId: string, topic: string, body: string): boolean;
    /** Messages under `topic` from other replicas, broadcast or addressed to this one. Returns the unsubscribe. */
    subscribe(topic: string, handler: RelayBusHandler): () => void;
    /** Replicas heard on the bus within the presence window (this one excluded). */
    peers(): string[];
    /** A replica joined (`true`) or went quiet (`false`). Returns the unsubscribe. */
    onPeerChange(listener: (replicaId: string, present: boolean) => void): () => void;
    health(): RelayBusHealth;
    /**
     * Claim `key` fleet-wide for `ttlMs`: true the first time, false while it
     * is held. Throws when the bus cannot answer — callers fail closed.
     */
    claimOnce(key: string, ttlMs: number): Promise<boolean>;
    close(): Promise<void>;
}

/** How often a replica says it is alive on the bus. */
export const RELAY_BUS_PRESENCE_INTERVAL_MS = 5_000;

/** A replica not heard from for this long is gone. */
export const RELAY_BUS_PRESENCE_TTL_MS = 15_000;

/** Topic of the presence beacon (never handed to subscribers). */
export const RELAY_BUS_PRESENCE_TOPIC = 'relay.presence';

/** Topic a replica sends once when it shuts down. */
export const RELAY_BUS_LEAVE_TOPIC = 'relay.leave';

/** Prefix of every key and channel this bus uses on Valkey. */
export const RELAY_BUS_KEY_PREFIX = 'ew:relay:';

/** Topics: lower-case dotted words — the bus refuses anything else rather than build a channel name from it. */
const TOPIC_PATTERN = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31}){0,3}$/;

export function isRelayBusTopic(value: unknown): value is string {
    return typeof value === 'string' && TOPIC_PATTERN.test(value);
}

/** Replica ids: what {@link newRelayReplicaId} makes. */
const REPLICA_PATTERN = /^r-[0-9a-f-]{36}$/;

export function isRelayReplicaId(value: unknown): value is string {
    return typeof value === 'string' && REPLICA_PATTERN.test(value);
}

/** Separator of the envelope fields; never inside a replica id or a topic. */
const SEPARATOR = '\u001f';
const ENVELOPE_VERSION = '1';

/** `1␟<from>␟<topic>␟<body>` — the envelope every bus message travels in. */
export function encodeRelayEnvelope(from: string, topic: string, body: string): string {
    return `${ENVELOPE_VERSION}${SEPARATOR}${from}${SEPARATOR}${topic}${SEPARATOR}${body}`;
}

/** The envelope's fields, or null for anything this build does not understand. */
export function decodeRelayEnvelope(
    raw: unknown,
): { from: string; topic: string; body: string } | null {
    if (typeof raw !== 'string') return null;
    const first = raw.indexOf(SEPARATOR);
    if (first < 0 || raw.slice(0, first) !== ENVELOPE_VERSION) return null;
    const second = raw.indexOf(SEPARATOR, first + 1);
    if (second < 0) return null;
    const third = raw.indexOf(SEPARATOR, second + 1);
    if (third < 0) return null;
    const from = raw.slice(first + 1, second);
    const topic = raw.slice(second + 1, third);
    if (!isRelayReplicaId(from) || !isRelayBusTopic(topic)) return null;
    return { from, topic, body: raw.slice(third + 1) };
}

export function newRelayReplicaId(uuid: string): string {
    return `r-${uuid.toLowerCase()}`;
}
