import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { DomainEvent } from '../../entities/domain-event.entity';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../../entities/domain-event-relay-state.entity';
import { DomainEventRecorder, type RecordDomainEventInput } from '../domain-event-recorder.service';

/**
 * An in-memory better-sqlite3 database with the whole entity inventory (so
 * the versioned aggregates are real tables) and the relay-state row seeded
 * the way the migration seeds it. Foreign keys are off: these specs never
 * build a full relation graph behind the rows they touch.
 */
export async function createDomainEventsDataSource(): Promise<DataSource> {
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ENTITIES,
        synchronize: true,
        logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('PRAGMA foreign_keys = OFF');
    await dataSource
        .getRepository(DomainEventRelayState)
        .insert({ id: DOMAIN_EVENT_RELAY_STATE_ID, lastSeq: 0, retentionFloorSeq: 0 });
    return dataSource;
}

/** Empty the tables these specs write and re-seed the relay-state row (cheaper than a new schema per test). */
export async function resetDomainEventsTables(dataSource: DataSource): Promise<void> {
    for (const table of [
        'domain_events',
        'plugin_event_cursors',
        'domain_event_relay_state',
        'teams',
        'tenants',
    ]) {
        await dataSource.query(`DELETE FROM "${table}"`);
    }
    await dataSource
        .getRepository(DomainEventRelayState)
        .insert({ id: DOMAIN_EVENT_RELAY_STATE_ID, lastSeq: 0, retentionFloorSeq: 0 });
}

export const ORG_A = '0f4b2c6d-8e1a-4b3c-9d5e-6f7a8b9c0d12';
export const ORG_B = '1a5c3d7e-9f2b-4c4d-8e6f-7a8b9c0d1e23';
export const TENANT = '7c1e9a52-3b0d-4c8e-9f21-5d6a7b8c9d01';

/** A minimal, valid recorder input for a task event. */
export function taskEventInput(
    overrides: Partial<RecordDomainEventInput> = {},
): RecordDomainEventInput {
    const id = randomUUID();
    return {
        type: 'task.updated',
        tenantId: TENANT,
        organizationId: ORG_A,
        aggregate: { type: 'task', id, version: 2 },
        data: { id, title: 'Ship it', visibility: 'organization' },
        changedFields: ['title'],
        previous: { title: 'Ship' },
        actor: { type: 'user', id: randomUUID(), label: 'ruslan' },
        ...overrides,
    };
}

/** Record `count` events through the real recorder (each in its own transaction). */
export async function recordMany(
    dataSource: DataSource,
    count: number,
    overrides: (index: number) => Partial<RecordDomainEventInput> = () => ({}),
): Promise<DomainEvent[]> {
    const recorder = new DomainEventRecorder();
    const rows: DomainEvent[] = [];
    for (let index = 0; index < count; index++) {
        rows.push(
            await dataSource.transaction((manager) =>
                recorder.record(manager, taskEventInput(overrides(index))),
            ),
        );
    }
    return rows;
}
