'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { DOMAIN_EVENT_TYPES } from '@ever-works/contracts';
import type { TeamsOrganization } from '@/lib/api/teams';
import type { WebhookDelivery, WebhookSubscription } from '@/lib/api/webhooks';
import {
    createWebhook,
    deleteWebhook,
    listWebhookDeliveries,
    redeliverWebhook,
    rotateWebhookSecret,
    testWebhook,
    updateWebhook,
} from '@/app/actions/webhooks';

interface Props {
    initialSubscriptions: WebhookSubscription[];
    organizations: TeamsOrganization[];
}

/** The opt-in type a `<prefix>.*` pattern never includes (delivered only when named). */
const RUNTIME_TYPE = 'task.runtime_updated';

/** `<prefix>.*` patterns offered in the create dialog, from the event catalog. */
export function eventPatternOptions(types: readonly string[] = DOMAIN_EVENT_TYPES): string[] {
    return [...new Set(types.map((type) => `${type.split('.')[0]}.*`))].sort();
}

const STATUS_STYLE: Record<WebhookSubscription['status'], string> = {
    active: 'text-green-600',
    paused: 'text-muted-foreground',
    failed: 'text-red-600',
    disabled: 'text-red-600',
};

/**
 * Settings → Webhooks (EW-P1-5). Lists every subscription (active, paused,
 * failed, disabled), creates v2 domain-event subscriptions, pauses / resumes,
 * test-fires, rotates the signing secret (shown once), and shows a
 * subscription's deliveries with redelivery.
 */
export function WebhooksSettings({ initialSubscriptions, organizations }: Props) {
    const [subscriptions, setSubscriptions] = useState(initialSubscriptions);
    const [creating, setCreating] = useState(false);
    const [secret, setSecret] = useState<{ subscriptionId: string; value: string } | null>(null);
    const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
    const [notice, setNotice] = useState<Record<string, { ok: boolean; message: string }>>({});
    const [pending, startTransition] = useTransition();

    const orgName = useMemo(() => {
        const byId = new Map(organizations.map((org) => [org.id, org.displayName || org.slug]));
        return (id: string) => byId.get(id) ?? id;
    }, [organizations]);

    function replace(subscription: WebhookSubscription) {
        setSubscriptions((prev) => prev.map((s) => (s.id === subscription.id ? subscription : s)));
    }

    function note(id: string, ok: boolean, message: string) {
        setNotice((prev) => ({ ...prev, [id]: { ok, message } }));
    }

    function setStatus(sub: WebhookSubscription, status: 'active' | 'paused') {
        startTransition(async () => {
            const result = await updateWebhook(sub.id, { status });
            if (result.success && result.subscription) {
                replace(result.subscription);
                note(sub.id, true, status === 'active' ? 'Resumed' : 'Paused');
            } else {
                note(sub.id, false, result.error ?? 'Update failed');
            }
        });
    }

    function test(sub: WebhookSubscription) {
        startTransition(async () => {
            const result = await testWebhook(sub.id);
            if (result.result) {
                note(
                    sub.id,
                    result.result.ok,
                    `${result.result.ok ? 'Delivered' : 'Failed'}: ${result.result.outcome}${
                        result.result.status ? ` (HTTP ${result.result.status})` : ''
                    }`,
                );
            } else {
                note(sub.id, false, result.error ?? 'Test failed');
            }
        });
    }

    function rotate(sub: WebhookSubscription) {
        startTransition(async () => {
            const result = await rotateWebhookSecret(sub.id);
            if (result.success && result.signingSecret) {
                setSecret({ subscriptionId: sub.id, value: result.signingSecret });
                note(
                    sub.id,
                    true,
                    sub.version === 2
                        ? 'Secret rotated; the previous one keeps signing for 24 h'
                        : 'Secret rotated',
                );
            } else {
                note(sub.id, false, result.error ?? 'Rotation failed');
            }
        });
    }

    function remove(sub: WebhookSubscription) {
        startTransition(async () => {
            const result = await deleteWebhook(sub.id);
            if (result.success) {
                setSubscriptions((prev) => prev.filter((s) => s.id !== sub.id));
            } else {
                note(sub.id, false, result.error ?? 'Delete failed');
            }
        });
    }

    return (
        <div className="space-y-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-lg font-semibold">Webhooks</h2>
                    <p className="text-sm text-muted-foreground">
                        Signed HTTPS callbacks. Domain-event webhooks (v2) carry the event envelope
                        and are signed <code>X-Ever-Works-Signature: t=…,v1=…</code>.
                    </p>
                </div>
                <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
                    onClick={() => setCreating(true)}
                >
                    New webhook
                </button>
            </div>

            {secret && (
                <div
                    role="status"
                    className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950"
                >
                    <p className="font-medium">Signing secret — shown once</p>
                    <p className="text-muted-foreground">
                        Store it now; it cannot be read again. Rotate it to get a new one.
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                        <code className="break-all rounded bg-background px-2 py-1" data-testid="webhook-secret">
                            {secret.value}
                        </code>
                        <button
                            type="button"
                            className="text-sm underline"
                            onClick={() => void navigator.clipboard?.writeText(secret.value)}
                        >
                            Copy
                        </button>
                        <button type="button" className="text-sm underline" onClick={() => setSecret(null)}>
                            Done
                        </button>
                    </div>
                </div>
            )}

            {subscriptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No webhooks yet.</p>
            ) : (
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b text-left">
                            <th className="py-2">Endpoint</th>
                            <th className="py-2">Events</th>
                            <th className="py-2">Status</th>
                            <th className="py-2 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {subscriptions.map((sub) => {
                            const info = notice[sub.id];
                            return (
                                <WebhookRow
                                    key={sub.id}
                                    sub={sub}
                                    orgName={orgName}
                                    info={info}
                                    busy={pending}
                                    deliveriesOpen={openDeliveries === sub.id}
                                    onToggleDeliveries={() =>
                                        setOpenDeliveries((prev) => (prev === sub.id ? null : sub.id))
                                    }
                                    onPause={() => setStatus(sub, 'paused')}
                                    onResume={() => setStatus(sub, 'active')}
                                    onTest={() => test(sub)}
                                    onRotate={() => rotate(sub)}
                                    onDelete={() => remove(sub)}
                                />
                            );
                        })}
                    </tbody>
                </table>
            )}

            {creating && (
                <CreateWebhookDialog
                    organizations={organizations}
                    onClose={() => setCreating(false)}
                    onCreated={(subscription, signingSecret) => {
                        setSubscriptions((prev) => [...prev, subscription]);
                        setSecret({ subscriptionId: subscription.id, value: signingSecret });
                        setCreating(false);
                    }}
                />
            )}
        </div>
    );
}

function WebhookRow({
    sub,
    orgName,
    info,
    busy,
    deliveriesOpen,
    onToggleDeliveries,
    onPause,
    onResume,
    onTest,
    onRotate,
    onDelete,
}: {
    sub: WebhookSubscription;
    orgName: (id: string) => string;
    info?: { ok: boolean; message: string };
    busy: boolean;
    deliveriesOpen: boolean;
    onToggleDeliveries: () => void;
    onPause: () => void;
    onResume: () => void;
    onTest: () => void;
    onRotate: () => void;
    onDelete: () => void;
}) {
    const canResume = sub.status === 'paused' || sub.status === 'failed';
    return (
        <>
            <tr className="border-b align-top">
                <td className="py-2">
                    <div className="break-all font-medium">{sub.url}</div>
                    {sub.description && (
                        <div className="text-xs text-muted-foreground">{sub.description}</div>
                    )}
                    {sub.version === 2 && sub.organizationIds && (
                        <div className="text-xs text-muted-foreground">
                            {sub.organizationIds.map(orgName).join(', ')}
                        </div>
                    )}
                </td>
                <td className="py-2">
                    {sub.version === 2 ? (
                        <span className="text-xs">{(sub.events ?? []).join(', ')}</span>
                    ) : (
                        <span className="text-xs text-muted-foreground">Work &amp; deployment (v1)</span>
                    )}
                </td>
                <td className="py-2">
                    <span className={STATUS_STYLE[sub.status]}>{sub.status}</span>
                    {sub.consecutiveFailures > 0 && (
                        <div className="text-xs text-muted-foreground">
                            {sub.consecutiveFailures} failed in a row
                        </div>
                    )}
                </td>
                <td className="py-2 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-3">
                        {info && (
                            <span className={info.ok ? 'text-xs text-green-600' : 'text-xs text-red-600'}>
                                {info.message}
                            </span>
                        )}
                        {sub.status === 'active' && (
                            <button type="button" className="text-sm" disabled={busy} onClick={onPause}>
                                Pause
                            </button>
                        )}
                        {canResume && (
                            <button type="button" className="text-sm" disabled={busy} onClick={onResume}>
                                Resume
                            </button>
                        )}
                        <button type="button" className="text-sm" disabled={busy} onClick={onTest}>
                            Test
                        </button>
                        <button type="button" className="text-sm" disabled={busy} onClick={onRotate}>
                            Rotate secret
                        </button>
                        <button type="button" className="text-sm" onClick={onToggleDeliveries}>
                            {deliveriesOpen ? 'Hide deliveries' : 'Deliveries'}
                        </button>
                        <button
                            type="button"
                            className="text-sm text-red-600"
                            disabled={busy}
                            onClick={onDelete}
                        >
                            Delete
                        </button>
                    </div>
                </td>
            </tr>
            {deliveriesOpen && (
                <tr className="border-b">
                    <td colSpan={4} className="py-2">
                        <DeliveriesPanel subscriptionId={sub.id} />
                    </td>
                </tr>
            )}
        </>
    );
}

function DeliveriesPanel({ subscriptionId }: { subscriptionId: string }) {
    const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [redelivered, setRedelivered] = useState<Record<string, string>>({});
    const [, startRedeliver] = useTransition();

    useEffect(() => {
        let cancelled = false;
        void listWebhookDeliveries(subscriptionId).then((result) => {
            if (cancelled) return;
            if (result.success) {
                setDeliveries(result.deliveries ?? []);
                setError(null);
            } else {
                setError(result.error ?? 'Failed to load deliveries');
            }
        });
        return () => {
            cancelled = true;
        };
    }, [subscriptionId]);

    function redeliver(id: string) {
        startRedeliver(async () => {
            const result = await redeliverWebhook(id);
            setRedelivered((prev) => ({
                ...prev,
                [id]: result.success ? 'Re-sent' : (result.error ?? 'Failed'),
            }));
        });
    }

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (deliveries === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
    if (deliveries.length === 0) {
        return <p className="text-sm text-muted-foreground">No deliveries yet.</p>;
    }
    return (
        <table className="w-full text-xs">
            <thead>
                <tr className="text-left">
                    <th className="py-1">Event</th>
                    <th className="py-1">Status</th>
                    <th className="py-1">Attempts</th>
                    <th className="py-1">Response</th>
                    <th className="py-1">Created</th>
                    <th className="py-1" />
                </tr>
            </thead>
            <tbody>
                {deliveries.map((d) => (
                    <tr key={d.id}>
                        <td className="py-1">{d.event}</td>
                        <td className="py-1">{d.status}</td>
                        <td className="py-1">{d.attempts}</td>
                        <td className="py-1">
                            {d.lastResponseStatus ?? d.lastOutcome ?? '—'}
                            {d.lastError ? ` · ${d.lastError}` : ''}
                        </td>
                        <td className="py-1">{new Date(d.createdAt).toLocaleString()}</td>
                        <td className="py-1 text-right">
                            {redelivered[d.id] ?? (
                                <button type="button" className="underline" onClick={() => redeliver(d.id)}>
                                    Redeliver
                                </button>
                            )}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function CreateWebhookDialog({
    organizations,
    onClose,
    onCreated,
}: {
    organizations: TeamsOrganization[];
    onClose: () => void;
    onCreated: (subscription: WebhookSubscription, signingSecret: string) => void;
}) {
    const patterns = useMemo(() => eventPatternOptions(), []);
    const [url, setUrl] = useState('');
    const [description, setDescription] = useState('');
    const [orgIds, setOrgIds] = useState<string[]>(organizations.length === 1 ? [organizations[0].id] : []);
    const [events, setEvents] = useState<string[]>(['task.*']);
    const [excludeTags, setExcludeTags] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, startSubmit] = useTransition();

    function toggle(list: string[], value: string): string[] {
        return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    }

    function submit() {
        setError(null);
        if (!/^https?:\/\//i.test(url.trim())) {
            setError('Enter the https:// URL of your endpoint.');
            return;
        }
        if (orgIds.length === 0) {
            setError('Pick at least one organization.');
            return;
        }
        if (events.length === 0) {
            setError('Pick at least one event group.');
            return;
        }
        startSubmit(async () => {
            const result = await createWebhook({
                url: url.trim(),
                description: description.trim() || null,
                organizationIds: orgIds,
                events,
                excludeOriginTags: excludeTags
                    .split(',')
                    .map((t) => t.trim())
                    .filter((t) => t.length > 0),
            });
            if (result.success && result.subscription && result.signingSecret) {
                onCreated(result.subscription, result.signingSecret);
            } else {
                setError(result.error ?? 'Failed to create the webhook');
            }
        });
    }

    return (
        <div role="dialog" aria-label="New webhook" className="space-y-4 rounded-md border p-4">
            <h3 className="font-semibold">New webhook</h3>
            <label className="block text-sm">
                Endpoint URL
                <input
                    type="url"
                    className="mt-1 w-full rounded-md border px-2 py-1"
                    placeholder="https://example.com/ever-works"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                />
            </label>
            <label className="block text-sm">
                Description
                <input
                    type="text"
                    className="mt-1 w-full rounded-md border px-2 py-1"
                    maxLength={500}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                />
            </label>
            <fieldset className="text-sm">
                <legend className="font-medium">Organizations</legend>
                {organizations.length === 0 && (
                    <p className="text-muted-foreground">You have no organizations yet.</p>
                )}
                {organizations.map((org) => (
                    <label key={org.id} className="mr-4 inline-flex items-center gap-1">
                        <input
                            type="checkbox"
                            checked={orgIds.includes(org.id)}
                            onChange={() => setOrgIds((prev) => toggle(prev, org.id))}
                        />
                        {org.displayName || org.slug}
                    </label>
                ))}
            </fieldset>
            <fieldset className="text-sm">
                <legend className="font-medium">Events</legend>
                {patterns.map((pattern) => (
                    <label key={pattern} className="mr-4 inline-flex items-center gap-1">
                        <input
                            type="checkbox"
                            checked={events.includes(pattern)}
                            onChange={() => setEvents((prev) => toggle(prev, pattern))}
                        />
                        <code>{pattern}</code>
                    </label>
                ))}
                <label className="mr-4 inline-flex items-center gap-1">
                    <input
                        type="checkbox"
                        checked={events.includes(RUNTIME_TYPE)}
                        onChange={() => setEvents((prev) => toggle(prev, RUNTIME_TYPE))}
                    />
                    <code>{RUNTIME_TYPE}</code>
                    <span className="text-muted-foreground">(PR / CI / run state — chatty)</span>
                </label>
            </fieldset>
            <label className="block text-sm">
                Skip events from these origins (comma-separated, optional)
                <input
                    type="text"
                    className="mt-1 w-full rounded-md border px-2 py-1"
                    placeholder="gauzy:<connection-id>"
                    value={excludeTags}
                    onChange={(e) => setExcludeTags(e.target.value)}
                />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
                <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                    disabled={submitting}
                    onClick={submit}
                >
                    {submitting ? 'Creating…' : 'Create'}
                </button>
                <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={onClose}>
                    Cancel
                </button>
            </div>
        </div>
    );
}
