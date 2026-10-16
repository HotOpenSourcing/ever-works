import { Test } from '@nestjs/testing';
import { DefaultInboundEmailDispatcher } from './default-inbound-email-dispatcher.service';
import { deriveThreadKey, INBOUND_EMAIL_TASK_SPAWNER } from './agent-inbound-email-dispatcher';
import {
    TenantEmailAddressRepository,
    AgentEmailAssignmentRepository,
    EmailMessageRepository,
    EmailConversationRepository,
} from '@src/database';

/**
 * EW-670 / T25 — inbound dispatcher coverage: address resolution,
 * task-spawn vs conversation branching, and the deriveThreadKey helper.
 *
 * PLG-1 follow-up — the destination is the address the webhook was
 * AUTHENTICATED for (`payload.recipient`, from `EmailFacadeService.parseInbound`),
 * never one re-derived from the attacker-controlled `to` list. The cases below
 * used to stub `findByAddress` for `to[0]` (that re-derivation was the bypass);
 * they now name the authenticated address and stub `findById` for it. What
 * each case asserts about branching is unchanged.
 */
describe('DefaultInboundEmailDispatcher', () => {
    let addresses: any;
    let assignments: any;
    let messages: any;
    let conversations: any;
    let taskSpawner: any;

    // The authenticated address: inbound, on the webhook's plugin, owned by u1.
    const inboundAddress = {
        id: 'addr-1',
        userId: 'u1',
        pluginId: 'postmark',
        direction: 'inbound',
        disabledAt: null,
    };

    const basePayload = {
        pluginId: 'postmark',
        recipient: { emailAddressId: 'addr-1', userId: 'u1' } as {
            emailAddressId: string;
            userId: string;
        } | null,
        providerMessageId: 'pm-in-1',
        from: 'human@example.com',
        to: ['triage@acme.com'],
        subject: 'Need help with X',
        bodyText: 'please assist',
        receivedAt: new Date('2026-05-28T10:00:00Z'),
    };

    async function build(withSpawner: boolean) {
        addresses = { findByAddress: jest.fn(), findById: jest.fn() };
        assignments = { findByEmailAddress: jest.fn() };
        messages = {
            save: jest.fn().mockResolvedValue({ id: 'msg-1' }),
            updateDeliveryStatus: jest.fn().mockResolvedValue(undefined),
            findByMessageIdHeaders: jest.fn().mockResolvedValue([]),
            linkTask: jest.fn().mockResolvedValue(true),
        };
        conversations = {
            findById: jest.fn().mockResolvedValue(null),
            findByThreadKey: jest.fn(),
            save: jest.fn().mockResolvedValue({ id: 'conv-1' }),
            touchLastMessageAt: jest.fn().mockResolvedValue(undefined),
        };
        taskSpawner = {
            spawnTaskForInboundEmail: jest.fn().mockResolvedValue({ taskId: 'task-1' }),
        };

        const providers: any[] = [
            DefaultInboundEmailDispatcher,
            { provide: TenantEmailAddressRepository, useValue: addresses },
            { provide: AgentEmailAssignmentRepository, useValue: assignments },
            { provide: EmailMessageRepository, useValue: messages },
            { provide: EmailConversationRepository, useValue: conversations },
        ];
        if (withSpawner) {
            providers.push({ provide: INBOUND_EMAIL_TASK_SPAWNER, useValue: taskSpawner });
        }
        const moduleRef = await Test.createTestingModule({ providers }).compile();
        return moduleRef.get(DefaultInboundEmailDispatcher);
    }

    it('returns handled:false when no inbound address matches', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(null);
        const res = await svc.dispatch(basePayload);
        expect(res.handled).toBe(false);
        expect(res.reason).toMatch(/no matching inbound address/);
    });

    it('returns handled:false when the address has no inbound assignment', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([]);
        const res = await svc.dispatch(basePayload);
        expect(res.handled).toBe(false);
        expect(res.reason).toMatch(/no inbound agent assignment/);
    });

    it('task-spawn mode persists the message + delegates to the task spawner', async () => {
        const svc = await build(true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        const res = await svc.dispatch(basePayload);
        expect(res).toMatchObject({
            handled: true,
            agentId: 'agent-1',
            mode: 'task-spawn',
            emailMessageId: 'msg-1',
            taskId: 'task-1',
        });
        expect(messages.save).toHaveBeenCalledTimes(1);
        expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'agent-1', emailMessageId: 'msg-1' }),
        );
    });

    it('task-spawn mode without a spawner persists but does not create a task', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        const res = await svc.dispatch(basePayload);
        expect(res.handled).toBe(true);
        expect(res.taskId).toBeUndefined();
        expect(messages.save).toHaveBeenCalledTimes(1);
    });

    it('conversation mode creates a thread + links the message', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'conversation' },
        ]);
        conversations.findByThreadKey.mockResolvedValue(null);
        const res = await svc.dispatch(basePayload);
        expect(res).toMatchObject({
            handled: true,
            mode: 'conversation',
            conversationId: 'conv-1',
            emailMessageId: 'msg-1',
        });
        expect(conversations.save).toHaveBeenCalledTimes(1);
        expect(conversations.touchLastMessageAt).toHaveBeenCalledWith(
            'conv-1',
            basePayload.receivedAt,
        );
        expect(taskSpawner?.spawnTaskForInboundEmail).not.toHaveBeenCalled();
    });

    it('conversation mode reuses an existing thread', async () => {
        const svc = await build(false);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'conversation' },
        ]);
        conversations.findByThreadKey.mockResolvedValue({ id: 'conv-existing' });
        const res = await svc.dispatch(basePayload);
        expect(res.conversationId).toBe('conv-existing');
        expect(conversations.save).not.toHaveBeenCalled();
    });

    // EW-P4-3 — the spawned Task is written back onto the message.
    it('task-spawn mode links the message to the Task it spawned', async () => {
        const svc = await build(true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        await svc.dispatch(basePayload);
        expect(messages.linkTask).toHaveBeenCalledWith('msg-1', 'task-1');
    });

    it('a failing back-link never fails the dispatch', async () => {
        const svc = await build(true);
        addresses.findById.mockResolvedValue(inboundAddress);
        assignments.findByEmailAddress.mockResolvedValue([
            { agentId: 'agent-1', dispatchMode: 'task-spawn' },
        ]);
        messages.linkTask.mockRejectedValue(new Error('db down'));
        await expect(svc.dispatch(basePayload)).resolves.toMatchObject({
            handled: true,
            taskId: 'task-1',
        });
    });

    describe('RFC threading (EW-P4-3)', () => {
        const reply = {
            ...basePayload,
            providerMessageId: 'pm-in-2',
            subject: 'A completely different subject',
            messageIdHeader: 'reply-2@client.test',
            inReplyTo: 'out-1@acme.test',
            references: ['root@client.test', 'out-1@acme.test'],
        };

        async function taskSpawnAgent(withAppend: boolean) {
            const svc = await build(true);
            if (withAppend) {
                taskSpawner.appendInboundEmailToTask = jest
                    .fn()
                    .mockImplementation(async ({ taskId }: { taskId: string }) => ({ taskId }));
            }
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'task-spawn' },
            ]);
            return svc;
        }

        it('persists the threading ids on the inbound row', async () => {
            const svc = await taskSpawnAgent(false);
            await svc.dispatch(reply);
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    messageIdHeader: 'reply-2@client.test',
                    inReplyTo: 'out-1@acme.test',
                    references: ['root@client.test', 'out-1@acme.test'],
                }),
            );
        });

        it('looks up In-Reply-To first, then References newest-first, owner-scoped, never its own id', async () => {
            const svc = await taskSpawnAgent(true);
            await svc.dispatch({
                ...reply,
                references: ['root@client.test', 'reply-2@client.test', 'out-1@acme.test'],
            });
            expect(messages.findByMessageIdHeaders).toHaveBeenCalledWith('u1', [
                'out-1@acme.test',
                'root@client.test',
            ]);
        });

        it('task-spawn: a reply to a message linked to a Task joins that Task', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'msg-out-1',
                    agentId: 'agent-1',
                    taskId: 'task-original',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);

            const res = await svc.dispatch(reply);

            expect(res).toMatchObject({
                handled: true,
                mode: 'task-spawn',
                taskId: 'task-original',
                threaded: true,
            });
            expect(taskSpawner.appendInboundEmailToTask).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: 'task-original',
                    agentId: 'agent-1',
                    userId: 'u1',
                    emailMessageId: 'msg-1',
                }),
            );
            expect(taskSpawner.spawnTaskForInboundEmail).not.toHaveBeenCalled();
            expect(messages.linkTask).toHaveBeenCalledWith('msg-1', 'task-original');
        });

        it('task-spawn: prefers the In-Reply-To match over an older References match', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-root',
                    agentId: 'agent-1',
                    taskId: 'task-root',
                    messageIdHeader: 'root@client.test',
                },
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    taskId: 'task-out',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            await expect(svc.dispatch(reply)).resolves.toMatchObject({ taskId: 'task-out' });
        });

        it("task-spawn: never joins another Agent's thread", async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-x',
                    agentId: 'agent-2',
                    taskId: 'task-of-agent-2',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            const res = await svc.dispatch(reply);
            expect(res).toMatchObject({ taskId: 'task-1' });
            expect(res.threaded).toBeUndefined();
            expect(taskSpawner.appendInboundEmailToTask).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
        });

        it('task-spawn: falls back to a new Task when appending fails (the reply is never lost)', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    taskId: 'task-original',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            taskSpawner.appendInboundEmailToTask.mockRejectedValue(new Error('secret detected'));

            const res = await svc.dispatch(reply);

            expect(res).toMatchObject({ handled: true, taskId: 'task-1' });
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
            expect(messages.linkTask).toHaveBeenCalledWith('msg-1', 'task-1');
            expect(messages.linkTask).not.toHaveBeenCalledWith('msg-1', 'task-original');
        });

        it('task-spawn: a spawner without appendInboundEmailToTask keeps one Task per message', async () => {
            const svc = await taskSpawnAgent(false);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    taskId: 'task-original',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            await expect(svc.dispatch(reply)).resolves.toMatchObject({ taskId: 'task-1' });
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
        });

        it('a failing thread lookup falls back instead of failing the dispatch', async () => {
            const svc = await taskSpawnAgent(true);
            messages.findByMessageIdHeaders.mockRejectedValue(new Error('db down'));
            await expect(svc.dispatch(reply)).resolves.toMatchObject({
                handled: true,
                taskId: 'task-1',
            });
        });

        it("conversation: a reply joins the parent's conversation whatever its subject", async () => {
            const svc = await build(false);
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'conversation' },
            ]);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    conversationId: 'conv-thread',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            conversations.findById.mockResolvedValue({ id: 'conv-thread', agentId: 'agent-1' });

            const res = await svc.dispatch(reply);

            expect(res).toMatchObject({ conversationId: 'conv-thread', threaded: true });
            expect(conversations.findByThreadKey).not.toHaveBeenCalled();
            expect(conversations.save).not.toHaveBeenCalled();
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({ conversationId: 'conv-thread' }),
            );
        });

        it('conversation: ignores a conversation that belongs to another Agent and falls back to the subject', async () => {
            const svc = await build(false);
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'conversation' },
            ]);
            messages.findByMessageIdHeaders.mockResolvedValue([
                {
                    id: 'm-out',
                    agentId: 'agent-1',
                    conversationId: 'conv-foreign',
                    messageIdHeader: 'out-1@acme.test',
                },
            ]);
            conversations.findById.mockResolvedValue({ id: 'conv-foreign', agentId: 'agent-2' });
            conversations.findByThreadKey.mockResolvedValue({ id: 'conv-by-subject' });

            const res = await svc.dispatch(reply);

            expect(res.conversationId).toBe('conv-by-subject');
            expect(res.threaded).toBeUndefined();
        });

        it('a message with no threading headers does no lookup', async () => {
            const svc = await taskSpawnAgent(true);
            await svc.dispatch(basePayload);
            expect(messages.findByMessageIdHeaders).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledTimes(1);
        });
    });

    describe('routes only to the authenticated address (PLG-1 follow-up)', () => {
        it("never re-derives the destination from the payload's `to` list", async () => {
            const svc = await build(true);
            // Another tenant's registered mailbox is listed first.
            addresses.findByAddress.mockResolvedValue({
                id: 'addr-victim',
                userId: 'victim',
                pluginId: 'postmark',
                direction: 'inbound',
                disabledAt: null,
            });
            addresses.findById.mockResolvedValue(inboundAddress);
            assignments.findByEmailAddress.mockImplementation(async (id: string) => [
                { agentId: `agent-of-${id}`, dispatchMode: 'task-spawn' },
            ]);

            const res = await svc.dispatch({
                ...basePayload,
                to: ['victim@example.com', 'triage@acme.com'],
            });

            expect(addresses.findByAddress).not.toHaveBeenCalled();
            expect(addresses.findById).toHaveBeenCalledWith('addr-1');
            expect(res).toMatchObject({ handled: true, agentId: 'agent-of-addr-1' });
            expect(messages.save).toHaveBeenCalledWith(
                expect.objectContaining({ emailAddressId: 'addr-1', userId: 'u1' }),
            );
            expect(taskSpawner.spawnTaskForInboundEmail).toHaveBeenCalledWith(
                expect.objectContaining({ agentId: 'agent-of-addr-1', userId: 'u1' }),
            );
        });

        it.each([
            ['no authenticated address', null],
            ['an authenticated address without an id', { emailAddressId: '', userId: 'u1' }],
        ])('dispatches nothing for %s', async (_case, recipient) => {
            const svc = await build(true);
            addresses.findByAddress.mockResolvedValue(inboundAddress);

            const res = await svc.dispatch({ ...basePayload, recipient });

            expect(res).toMatchObject({ handled: false, reason: 'no matching inbound address' });
            expect(addresses.findByAddress).not.toHaveBeenCalled();
            expect(messages.save).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).not.toHaveBeenCalled();
        });

        it.each([
            ['belongs to another owner', { userId: 'someone-else' }],
            ['is registered with another provider', { pluginId: 'mailgun' }],
            ['is disabled', { disabledAt: new Date('2026-09-01T00:00:00Z') }],
            ['is outbound-only', { direction: 'outbound' }],
        ])('refuses an authenticated address that %s', async (_case, patch) => {
            const svc = await build(true);
            addresses.findById.mockResolvedValue({ ...inboundAddress, ...patch });
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'task-spawn' },
            ]);

            const res = await svc.dispatch(basePayload);

            expect(res).toMatchObject({ handled: false, reason: 'no matching inbound address' });
            expect(messages.save).not.toHaveBeenCalled();
            expect(taskSpawner.spawnTaskForInboundEmail).not.toHaveBeenCalled();
        });

        it('accepts an authenticated address that handles both directions', async () => {
            const svc = await build(true);
            addresses.findById.mockResolvedValue({ ...inboundAddress, direction: 'both' });
            assignments.findByEmailAddress.mockResolvedValue([
                { agentId: 'agent-1', dispatchMode: 'task-spawn' },
            ]);

            await expect(svc.dispatch(basePayload)).resolves.toMatchObject({
                handled: true,
                agentId: 'agent-1',
            });
        });
    });
});

describe('deriveThreadKey', () => {
    it('strips Re:/Fwd: prefixes and normalizes', () => {
        expect(deriveThreadKey('Re: Re: Hello World')).toBe('hello world');
        expect(deriveThreadKey('FWD:  Spaced   Out ')).toBe('spaced out');
    });
    it('falls back for an empty subject', () => {
        expect(deriveThreadKey('   ')).toBe('(no subject)');
    });

    it.each<[string, string]>([
        ['re:fwd:FW: x', 'x'],
        ['  Re :  Fwd:\tRe:\nHello', 'hello'],
        ['Re: Re', 're'],
        ['Re Hello', 're hello'],
        ['Fwd:', '(no subject)'],
        ['Refund: Re: x', 'refund: re: x'],
        ['fw: fwd: fwx: y', 'fwx: y'],
    ])('keys %p as %p', (subject, key) => {
        expect(deriveThreadKey(subject)).toBe(key);
    });

    // The subject is sender-controlled (any inbound email). CodeQL flagged the
    // prefix pattern as polynomial on whitespace runs; these are the shapes it
    // names. V8 answers them in linear time with the old pattern too (well
    // under 10 ms at 20,000 characters, measured 2026-10-09), so this pins
    // linearity against a later rewrite that really does backtrack — e.g. a
    // regex trim, `/\s+$/` over an interior whitespace run, needs ~40 s at this
    // size on a dev box. Sized rather than tightly timed: a "< 200 ms" at
    // 50,000 was one scheduler stall on a CPU-throttled CI runner from red
    // (develop CI, 2026-10-09); 2 s at 200,000 is neither.
    it.each<[string, string]>([
        ['whitespace before a non-prefix', `${' '.repeat(200_000)}x`],
        ['a prefix, then whitespace, then a partial prefix', `re:${' '.repeat(200_000)}r`],
        ['many prefixes', 're: '.repeat(200_000)],
        ['a prefix word and whitespace with no colon', `re${' '.repeat(200_000)}x`],
    ])('keys a subject of %s in linear time', (_, subject) => {
        const started = performance.now();
        deriveThreadKey(subject);
        const elapsedMs = performance.now() - started;

        expect(elapsedMs).toBeLessThan(2_000);
    });
});
