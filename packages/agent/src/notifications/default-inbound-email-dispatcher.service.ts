import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    TenantEmailAddressRepository,
    AgentEmailAssignmentRepository,
    EmailMessageRepository,
    EmailConversationRepository,
} from '@src/database';
import type { EmailMessage } from '@src/entities/email-message.entity';
import type { EmailConversation } from '@src/entities/email-conversation.entity';
import type { TenantEmailAddress } from '@src/entities/tenant-email-address.entity';
import {
    AGENT_INBOUND_EMAIL_DISPATCHER,
    INBOUND_EMAIL_TASK_SPAWNER,
    deriveThreadKey,
    type AgentInboundEmailDispatcher,
    type AgentInboundEmailDispatchPayload,
    type AgentInboundEmailDispatchResult,
    type InboundEmailTaskSpawner,
    type InboundEmailTaskSpawnerInput,
} from './agent-inbound-email-dispatcher';

/** Address directions that receive inbound mail. */
const INBOUND_DIRECTIONS: readonly string[] = ['inbound', 'both'];

/** Most thread ids looked up per inbound message (newest first). */
const MAX_THREAD_LOOKUP_IDS = 20;

/**
 * EW-P4-3 — the ids an inbound message threads on, most specific first:
 * `In-Reply-To`, then `References` from newest to oldest. Its own
 * `Message-ID` is never one of them (a message is not its own parent).
 */
function threadLookupIds(payload: AgentInboundEmailDispatchPayload): string[] {
    const ids: string[] = [];
    if (payload.inReplyTo) ids.push(payload.inReplyTo);
    const references = payload.references ?? [];
    for (let i = references.length - 1; i >= 0; i -= 1) ids.push(references[i]);
    const own = payload.messageIdHeader;
    return [...new Set(ids.filter((id) => typeof id === 'string' && id && id !== own))].slice(
        0,
        MAX_THREAD_LOOKUP_IDS,
    );
}

/**
 * Why `address` may not receive a webhook verified as `userId` on `pluginId`,
 * or `null` when it may.
 */
function whyNotDeliverable(
    address: TenantEmailAddress,
    userId: string,
    pluginId: string,
): string | null {
    if (address.userId !== userId) return 'owned by another user';
    if (address.pluginId !== pluginId) return `registered with ${address.pluginId}`;
    if (address.disabledAt) return 'disabled';
    if (!INBOUND_DIRECTIONS.includes(address.direction)) return `${address.direction}-only`;
    return null;
}

/**
 * Default binding for {@link AGENT_INBOUND_EMAIL_DISPATCHER} (EW-670 / T25).
 *
 * Loads the tenant address the webhook was AUTHENTICATED for
 * (`payload.recipient`) → its inbound agent assignment, persists the
 * inbound `email_messages` row, and branches on the assignment's
 * `dispatchMode`:
 *  - `task-spawn` (default): delegate Task creation + agent-task-execute
 *    enqueue to the optional {@link INBOUND_EMAIL_TASK_SPAWNER} adapter.
 *  - `conversation`: find/create the per-agent `email_conversations`
 *    thread, link the message, and bump `lastMessageAt` (the agent's
 *    chat-reply path consumes the thread).
 *
 * RFC threading (EW-P4-3): before either, the message's `In-Reply-To` /
 * `References` are matched against the SAME owner's and Agent's messages. A
 * match joins that thread: its conversation, or its Task (through the
 * spawner's optional `appendInboundEmailToTask`, falling back to a new Task
 * when that is absent or fails). The subject is only the fallback. After a
 * Task is spawned or joined, the message is linked to it (`taskId`).
 *
 * Mirrors `task-dispatcher.ts` — heavy downstream side-effects live
 * behind optional injected adapters so this stays free of the
 * tasks-domain + Trigger.dev cycle.
 */
@Injectable()
export class DefaultInboundEmailDispatcher implements AgentInboundEmailDispatcher {
    private readonly logger = new Logger(DefaultInboundEmailDispatcher.name);

    constructor(
        private readonly addresses: TenantEmailAddressRepository,
        private readonly assignments: AgentEmailAssignmentRepository,
        private readonly messages: EmailMessageRepository,
        private readonly conversations: EmailConversationRepository,
        @Optional()
        @Inject(INBOUND_EMAIL_TASK_SPAWNER)
        private readonly taskSpawner?: InboundEmailTaskSpawner,
    ) {}

    async dispatch(
        payload: AgentInboundEmailDispatchPayload,
    ): Promise<AgentInboundEmailDispatchResult> {
        // 1. The address the webhook was authenticated for — and no other.
        const address = await this.resolveAuthenticatedAddress(payload);
        if (!address) {
            return { handled: false, reason: 'no matching inbound address' };
        }

        // 2. Resolve the inbound assignment (lowest priority first).
        const assignments = await this.assignments.findByEmailAddress(address.id, 'inbound');
        const assignment = assignments[0];
        if (!assignment) {
            return { handled: false, reason: 'address has no inbound agent assignment' };
        }
        const agentId = assignment.agentId;
        const mode = assignment.dispatchMode === 'conversation' ? 'conversation' : 'task-spawn';

        if (mode === 'conversation') {
            return this.dispatchConversation(payload, address.id, address.userId, agentId);
        }
        return this.dispatchTaskSpawn(payload, address.id, address.userId, agentId);
    }

    /**
     * The address `payload.recipient` names, when it is still an active
     * inbound (or `both`) address of the webhook's plugin owned by the user
     * the signature was verified as. Anything else is refused (`null`).
     *
     * Security: the destination is NEVER re-derived from `payload.to`. The
     * facade verifies the webhook with the secret of ONE recipient's owner (a
     * per-user key replaces the admin one at that owner's scope), while `to`
     * is the sender's to write. Routing on `to` let a tenant sign with their
     * own key, name their own address where verification looks and a
     * victim's where routing looked, and spawn a Task for the victim's Agent.
     */
    private async resolveAuthenticatedAddress(
        payload: AgentInboundEmailDispatchPayload,
    ): Promise<TenantEmailAddress | null> {
        const recipient = payload.recipient;
        if (!recipient?.emailAddressId || !recipient.userId) return null;
        const address = await this.addresses.findById(recipient.emailAddressId);
        if (!address) return null;
        const mismatch = whyNotDeliverable(address, recipient.userId, payload.pluginId);
        if (mismatch) {
            this.logger.warn(
                `Refusing inbound ${payload.pluginId} dispatch: authenticated address ${address.id} is ${mismatch}`,
            );
            return null;
        }
        return address;
    }

    private async dispatchTaskSpawn(
        payload: AgentInboundEmailDispatchPayload,
        emailAddressId: string,
        userId: string,
        agentId: string,
    ): Promise<AgentInboundEmailDispatchResult> {
        const message = await this.persistMessage(payload, emailAddressId, userId, agentId, null);

        let taskId: string | undefined;
        if (this.taskSpawner) {
            const input = {
                agentId,
                userId,
                emailMessageId: message.id,
                subject: payload.subject,
                bodyText: payload.bodyText,
                from: payload.from,
            };

            // EW-P4-3 — a reply to a message already linked to a Task joins
            // that Task instead of spawning another one.
            const joined = await this.joinThreadTask(payload, userId, agentId, input);
            if (joined) {
                await this.linkTask(message.id, joined);
                return {
                    handled: true,
                    agentId,
                    mode: 'task-spawn',
                    emailMessageId: message.id,
                    taskId: joined,
                    threaded: true,
                };
            }

            const spawned = await this.taskSpawner.spawnTaskForInboundEmail(input);
            taskId = spawned?.taskId;
            if (taskId) {
                // EW-P4-3 — the message and the Task it created are linked, so
                // a later reply can thread onto the Task.
                await this.linkTask(message.id, taskId);
                await this.messages.updateDeliveryStatus(message.id, 'delivered').catch(() => {});
            }
        } else {
            this.logger.debug(
                `INBOUND_EMAIL_TASK_SPAWNER unbound; persisted inbound message ${message.id} for agent ${agentId} without spawning a task`,
            );
        }

        return { handled: true, agentId, mode: 'task-spawn', emailMessageId: message.id, taskId };
    }

    private async dispatchConversation(
        payload: AgentInboundEmailDispatchPayload,
        emailAddressId: string,
        userId: string,
        agentId: string,
    ): Promise<AgentInboundEmailDispatchResult> {
        // EW-P4-3 — the conversation of the message this one replies to, when
        // its headers name one of this Agent's messages; else the subject.
        const parent = await this.findThreadParent(
            payload,
            userId,
            agentId,
            (candidate) => !!candidate.conversationId,
        );
        let conversation: EmailConversation | null = null;
        if (parent?.conversationId) {
            const parentConversation = await this.conversations.findById(parent.conversationId);
            if (parentConversation && parentConversation.agentId === agentId) {
                conversation = parentConversation;
            }
        }
        const threaded = !!conversation;
        const threadKey = deriveThreadKey(payload.subject);
        if (!conversation) {
            conversation = await this.conversations.findByThreadKey(agentId, threadKey);
        }
        if (!conversation) {
            conversation = await this.conversations.save({
                agentId,
                threadKey,
                participants: [{ address: payload.from }],
                lastMessageAt: payload.receivedAt,
            } as EmailConversation);
        }

        const message = await this.persistMessage(
            payload,
            emailAddressId,
            userId,
            agentId,
            conversation.id,
        );
        await this.conversations
            .touchLastMessageAt(conversation.id, payload.receivedAt)
            .catch(() => {});

        return {
            handled: true,
            agentId,
            mode: 'conversation',
            emailMessageId: message.id,
            conversationId: conversation.id,
            ...(threaded ? { threaded: true } : {}),
        };
    }

    /**
     * EW-P4-3 — the earliest-named message of this owner AND Agent that the
     * inbound message's `In-Reply-To` / `References` point at and that
     * `accept` takes, or `null`. Owner- and Agent-scoped: the headers are the
     * sender's to write, so they can only ever pick among this Agent's own
     * mail. Never throws — threading is best-effort, the subject fallback and
     * a new Task still deliver the message.
     */
    private async findThreadParent(
        payload: AgentInboundEmailDispatchPayload,
        userId: string,
        agentId: string,
        accept: (candidate: EmailMessage) => boolean,
    ): Promise<EmailMessage | null> {
        const ids = threadLookupIds(payload);
        if (ids.length === 0) return null;
        try {
            const candidates = (await this.messages.findByMessageIdHeaders(userId, ids)).filter(
                (candidate) => candidate.agentId === agentId && accept(candidate),
            );
            for (const id of ids) {
                const match = candidates.find((candidate) => candidate.messageIdHeader === id);
                if (match) return match;
            }
        } catch (error) {
            this.logger.warn(
                `Thread lookup failed for inbound ${payload.pluginId} message; falling back to the subject — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return null;
    }

    /**
     * EW-P4-3 — deliver a threaded reply to its Task: the Task id when the
     * spawner took it, `null` when there is no Task to join, the adapter cannot
     * append, or appending failed (the caller then spawns a new Task, so the
     * reply is never lost).
     */
    private async joinThreadTask(
        payload: AgentInboundEmailDispatchPayload,
        userId: string,
        agentId: string,
        input: InboundEmailTaskSpawnerInput,
    ): Promise<string | null> {
        const append = this.taskSpawner?.appendInboundEmailToTask;
        if (typeof append !== 'function') return null;
        const parent = await this.findThreadParent(
            payload,
            userId,
            agentId,
            (candidate) => !!candidate.taskId,
        );
        if (!parent?.taskId) return null;
        try {
            const joined = await append.call(this.taskSpawner, { ...input, taskId: parent.taskId });
            return joined?.taskId ?? null;
        } catch (error) {
            this.logger.warn(
                `Could not append inbound message ${input.emailMessageId} to task ${parent.taskId}; spawning a new task — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /** EW-P4-3 — best-effort `email_messages.taskId` back-link. */
    private async linkTask(messageId: string, taskId: string): Promise<void> {
        try {
            await this.messages.linkTask(messageId, taskId);
        } catch (error) {
            this.logger.warn(
                `Could not link inbound message ${messageId} to task ${taskId} — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async persistMessage(
        payload: AgentInboundEmailDispatchPayload,
        emailAddressId: string,
        userId: string,
        agentId: string,
        conversationId: string | null,
    ): Promise<EmailMessage> {
        return this.messages.save({
            userId,
            agentId,
            taskId: null,
            conversationId,
            emailAddressId,
            direction: 'inbound',
            pluginId: payload.pluginId,
            providerMessageId: payload.providerMessageId,
            from: payload.from,
            toAddresses: payload.to,
            subject: payload.subject,
            bodyText: payload.bodyText,
            bodyHtml: payload.bodyHtml ?? null,
            // EW-P4-3 — RFC threading ids, so a later reply can find this one.
            messageIdHeader: payload.messageIdHeader ?? null,
            inReplyTo: payload.inReplyTo ?? null,
            references: payload.references?.length ? [...payload.references] : null,
            receivedAt: payload.receivedAt,
            deliveryStatus: 'delivered',
            // AW-05 — lifecycle status; inbound mail is always `received`.
            status: 'received',
        } as Parameters<EmailMessageRepository['save']>[0]);
    }
}

export const DEFAULT_INBOUND_EMAIL_DISPATCHER_PROVIDER = {
    provide: AGENT_INBOUND_EMAIL_DISPATCHER,
    useClass: DefaultInboundEmailDispatcher,
};
