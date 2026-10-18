import { buildEscalationTools } from '../agent-escalation-tools';
import { AgentProposalExecutionListener } from '../agent-proposal-execution.listener';
import {
    AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
    AGENT_FILE_EDIT_PROPOSAL_KIND,
} from '../agent-proposal-kinds';
import { AgentActionProposalDecidedEvent } from '../../agent-approvals/agent-action-proposal-decided.event';
import { classifyAction } from '../../safety/action-category';

/**
 * Prompt-injection hardening — an Agent never answers one of the owner's human
 * gates, nor rewrites its own trusted identity, by itself:
 *
 *   - `resolve_escalation` files an owner-approval proposal instead of
 *     resolving, and an approved proposal resolves the escalation as
 *     AGENT-authored (which never resumes the waiting run);
 *   - an approved `editAgentFile` proposal writes exactly the proposed body,
 *     guarded by the hash the agent saw.
 */
describe('resolve_escalation — proposes, never resolves', () => {
    const open = { id: 'e1', status: 'open' };

    function tools(overrides: { proposals?: unknown; existing?: unknown } = {}) {
        const service = {
            listForUser: jest.fn().mockResolvedValue([]),
            resolve: jest.fn().mockResolvedValue(true),
            getForUser: jest
                .fn()
                .mockResolvedValue('existing' in overrides ? overrides.existing : open),
        };
        const proposals =
            'proposals' in overrides
                ? overrides.proposals
                : { propose: jest.fn().mockResolvedValue({ id: 'p-1', status: 'pending' }) };
        const built = buildEscalationTools({
            userId: 'owner-1',
            agentId: 'agent-1',
            agentRunId: 'run-1',
            service,
            proposals: proposals as never,
        });
        const tool = built.find((entry) => entry.name === 'resolve_escalation')!;
        return { tool, service, proposals: proposals as { propose: jest.Mock } | null };
    }

    it('files a PENDING proposal carrying the escalation and note — and resolves nothing', async () => {
        const { tool, service, proposals } = tools();
        const result = await tool.invoke({ escalationId: 'e1', note: 'budget raised' });

        expect(service.resolve).not.toHaveBeenCalled();
        expect(proposals!.propose).toHaveBeenCalledWith('owner-1', {
            agentId: 'agent-1',
            runId: 'run-1',
            title: expect.stringContaining('close escalation'),
            payload: {
                kind: AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
                escalationId: 'e1',
                note: 'budget raised',
            },
        });
        expect(result).toMatchObject({
            resolved: false,
            proposed: true,
            pendingApproval: true,
            proposalId: 'p-1',
        });
    });

    it('fails CLOSED with no approval queue: nothing is resolved', async () => {
        const { tool, service } = tools({ proposals: null });
        const result = (await tool.invoke({ escalationId: 'e1' })) as { error?: string };
        expect(result.error).toMatch(/decided by the owner/);
        expect(service.resolve).not.toHaveBeenCalled();
    });

    it('proposes nothing for an unknown, foreign or already-resolved escalation', async () => {
        const missing = tools({ existing: null });
        await expect(missing.tool.invoke({ escalationId: 'nope' })).resolves.toMatchObject({
            proposed: false,
        });
        expect(missing.proposals!.propose).not.toHaveBeenCalled();

        const resolved = tools({ existing: { id: 'e1', status: 'resolved' } });
        await expect(resolved.tool.invoke({ escalationId: 'e1' })).resolves.toMatchObject({
            proposed: false,
        });
        expect(resolved.proposals!.propose).not.toHaveBeenCalled();
    });

    it("reports a guardrail block as a refusal", async () => {
        const { tool } = tools({
            proposals: { propose: jest.fn().mockResolvedValue({ id: 'p-2', status: 'rejected' }) },
        });
        await expect(tool.invoke({ escalationId: 'e1' })).resolves.toMatchObject({
            proposed: false,
            error: expect.stringMatching(/guardrails/),
        });
    });

    it('both gated tools stay write.internal — the approval proposal is the gate', () => {
        // A held `access.grant` rung would stop the call before any proposal
        // is filed, leaving the owner nothing to approve.
        expect(classifyAction('resolve_escalation')).toBe('write.internal');
        expect(classifyAction('editAgentFile')).toBe('write.internal');
    });
});

describe('AgentProposalExecutionListener', () => {
    function event(
        payload: Record<string, unknown>,
        overrides: Partial<{
            status: 'approved' | 'rejected';
            decidedVia: 'user' | 'guardrail' | null;
            decidedById: string | null;
            actionType: string;
        }> = {},
    ): AgentActionProposalDecidedEvent {
        return new AgentActionProposalDecidedEvent(
            'p-1',
            'owner-1',
            'agent-1',
            (overrides.actionType ?? 'other') as never,
            overrides.status ?? 'approved',
            overrides.decidedById === undefined ? 'owner-1' : overrides.decidedById,
            overrides.decidedVia === undefined ? 'user' : overrides.decidedVia,
            payload,
        );
    }

    function build() {
        const escalations = { resolve: jest.fn().mockResolvedValue(true) };
        const files = { write: jest.fn().mockResolvedValue({ newHash: 'h2' }) };
        const listener = new AgentProposalExecutionListener(escalations as never, files as never);
        return { listener, escalations, files };
    }

    const escalationPayload = {
        kind: AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
        escalationId: 'e1',
        note: 'go ahead',
    };
    const filePayload = {
        kind: AGENT_FILE_EDIT_PROPOSAL_KIND,
        fileName: 'SOUL.md',
        body: '# New soul',
        baseHash: 'h1',
        runId: 'run-1',
    };

    it('an approved escalation proposal resolves it as AGENT-authored (no resume)', async () => {
        const { listener, escalations } = build();
        await listener.handleProposalDecided(event(escalationPayload));
        expect(escalations.resolve).toHaveBeenCalledWith('e1', 'owner-1', 'go ahead', {
            resolvedBy: 'agent',
            agentId: 'agent-1',
        });
    });

    it('an approved file edit writes exactly the proposed body, guarded by the hash the agent saw', async () => {
        const { listener, files } = build();
        await listener.handleProposalDecided(event(filePayload));
        expect(files.write).toHaveBeenCalledWith({
            userId: 'owner-1',
            agentId: 'agent-1',
            name: 'SOUL.md',
            body: '# New soul',
            expectedHash: 'h1',
            actor: 'agent',
            runId: 'run-1',
        });
    });

    it.each([
        ['a rejection', { status: 'rejected' as const }],
        ['a guardrail decision', { decidedVia: 'guardrail' as const, decidedById: null }],
        ['a decision with no person', { decidedById: null }],
        ['another action type', { actionType: 'send_message' }],
    ])('does nothing on %s', async (_label, overrides) => {
        const { listener, escalations, files } = build();
        await listener.handleProposalDecided(event(escalationPayload, overrides));
        await listener.handleProposalDecided(event(filePayload, overrides));
        expect(escalations.resolve).not.toHaveBeenCalled();
        expect(files.write).not.toHaveBeenCalled();
    });

    it('ignores a payload naming a file outside the five canonical files', async () => {
        const { listener, files } = build();
        await listener.handleProposalDecided(event({ ...filePayload, fileName: '../../etc/passwd' }));
        expect(files.write).not.toHaveBeenCalled();
    });

    it('never throws back into the decision (best-effort)', async () => {
        const { listener, files } = build();
        files.write.mockRejectedValue(new Error('etag mismatch'));
        await expect(listener.handleProposalDecided(event(filePayload))).resolves.toBeUndefined();
    });
});
