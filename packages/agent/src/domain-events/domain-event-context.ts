import { AsyncLocalStorage } from 'node:async_hooks';
import type { DomainEventActor } from '@ever-works/contracts';

/**
 * Who and what caused the changes made inside one request or job, for the
 * domain events it records (EW-P1-1).
 *
 * Set once per HTTP request by the API's `DomainEventContextInterceptor`
 * (actor from the authenticated principal, `originTag` from `X-Sync-Origin`,
 * `correlationId` from the request id), or by a background job around its own
 * work with {@link runWithDomainEventContext}. The recorder reads it when a
 * caller does not pass an actor or origin explicitly.
 *
 * A module-level `AsyncLocalStorage` rather than a request-scoped provider for
 * the same reason as the API's `ScopeContextService`: request-scoped DI would
 * make every service that records an event request-scoped too.
 */
export interface DomainEventContext {
    readonly actor?: DomainEventActor;
    /** `X-Sync-Origin` of the request, e.g. `gauzy:<connectionId>`. */
    readonly originTag?: string | null;
    /** The integration key the request authenticated with. */
    readonly integrationKeyId?: string | null;
    readonly correlationId?: string | null;
}

const storage = new AsyncLocalStorage<DomainEventContext>();

/** Run `fn` with `context` as the active domain event context. Nested calls replace it. */
export function runWithDomainEventContext<T>(context: DomainEventContext, fn: () => T): T {
    return storage.run(context, fn);
}

/** The active context, or `undefined` outside any {@link runWithDomainEventContext}. */
export function getDomainEventContext(): DomainEventContext | undefined {
    return storage.getStore();
}

/**
 * Normalise an `X-Sync-Origin` header value: trimmed, at most 100 printable
 * ASCII characters, else `null` (an invalid origin is dropped rather than
 * failing the write — it only steers loop prevention).
 */
export function normalizeSyncOrigin(value: unknown): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 100 || !/^[\x21-\x7e]+$/.test(trimmed)) return null;
    return trimmed;
}
