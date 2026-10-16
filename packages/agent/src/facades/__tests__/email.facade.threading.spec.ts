import {
    buildOutboundHeaders,
    EmailFacadeService,
    replyHeadersFor,
    threadingFieldsOf,
} from '../email.facade';

/**
 * EW-P4-3 — RFC threading on the outbound path. Every send carries a
 * `Message-ID` (recorded on its `email_messages` row), the caller's
 * `In-Reply-To` / `References` reach the provider, and nothing a caller
 * passes can inject a header line.
 */
function makeFacade() {
    const plugin = {
        id: 'postmark',
        name: 'Postmark',
        version: '1.0.0',
        category: 'email',
        capabilities: ['email-outbound'],
        sendEmail: jest.fn().mockResolvedValue({
            provider: 'postmark',
            providerMessageId: 'pm-1',
            accepted: ['ada@example.com'],
            rejected: [],
        }),
        verifyAddress: jest.fn(),
    };
    const registry = {
        getByCapability: jest.fn().mockReturnValue([{ plugin, state: 'loaded' }]),
        get: jest.fn().mockReturnValue({ plugin, state: 'loaded' }),
    };
    const settings = {
        getResolvedSettings: jest.fn().mockResolvedValue({}),
        getSettings: jest.fn().mockResolvedValue({}),
    };
    const emailMessages = {
        save: jest.fn().mockResolvedValue({}),
        transitionStatus: jest.fn().mockResolvedValue(1),
    };
    const facade = new EmailFacadeService(
        registry as never,
        settings as never,
        undefined,
        undefined,
        undefined,
        emailMessages as never,
    );
    jest.spyOn(
        facade as unknown as { resolveOutboundPlugin: () => unknown },
        'resolveOutboundPlugin',
    ).mockResolvedValue(plugin as never);
    return { facade, plugin, emailMessages };
}

const INPUT = {
    from: 'nova@agents.example.com',
    to: ['ada@example.com'],
    subject: 'Re: Quarterly numbers',
    bodyText: 'Attached.',
    messageRef: 'ref-1',
};

describe('EmailFacadeService.send — RFC threading (EW-P4-3)', () => {
    it('sets a Message-ID on the sending domain and records it on the row', async () => {
        const { facade, plugin, emailMessages } = makeFacade();
        await facade.send(INPUT, { userId: 'user-1', addressId: 'addr-1' });

        const wire = plugin.sendEmail.mock.calls[0][0];
        expect(wire.headers['Message-ID']).toMatch(/^<[0-9a-f-]{36}@agents\.example\.com>$/);
        const bare = wire.headers['Message-ID'].slice(1, -1);
        expect(emailMessages.save).toHaveBeenCalledWith(
            expect.objectContaining({ messageIdHeader: bare, inReplyTo: null, references: null }),
        );
    });

    it("forwards the caller's In-Reply-To / References and records them", async () => {
        const { facade, plugin, emailMessages } = makeFacade();
        await facade.send(
            {
                ...INPUT,
                headers: {
                    'In-Reply-To': '<in-1@client.test>',
                    References: '<root@client.test> <in-1@client.test>',
                },
            },
            { userId: 'user-1', addressId: 'addr-1' },
        );

        const wire = plugin.sendEmail.mock.calls[0][0];
        expect(wire.headers['In-Reply-To']).toBe('<in-1@client.test>');
        expect(wire.headers.References).toBe('<root@client.test> <in-1@client.test>');
        expect(emailMessages.save).toHaveBeenCalledWith(
            expect.objectContaining({
                inReplyTo: 'in-1@client.test',
                references: ['root@client.test', 'in-1@client.test'],
            }),
        );
    });

    it('records the conversation a reply belongs to', async () => {
        const { facade, emailMessages } = makeFacade();
        await facade.send(INPUT, {
            userId: 'user-1',
            addressId: 'addr-1',
            conversationId: 'conv-3',
        });
        expect(emailMessages.save).toHaveBeenCalledWith(
            expect.objectContaining({ conversationId: 'conv-3', taskId: null }),
        );
    });

    it("keeps a caller's own Message-ID instead of generating one", async () => {
        const { facade, plugin } = makeFacade();
        await facade.send(
            { ...INPUT, headers: { 'message-id': '<mine@acme.test>' } },
            { userId: 'user-1', addressId: 'addr-1' },
        );
        const wire = plugin.sendEmail.mock.calls[0][0];
        expect(wire.headers).toEqual({ 'message-id': '<mine@acme.test>' });
    });

    it('records the ids on a released draft row (its Message-ID is set at release)', async () => {
        const { facade, emailMessages, plugin } = makeFacade();
        await facade.send(
            { ...INPUT, headers: { 'In-Reply-To': '<in-1@client.test>' } },
            { userId: 'user-1', addressId: 'addr-1', draftMessageId: 'draft-1', origin: 'agent' },
        );
        const bare = plugin.sendEmail.mock.calls[0][0].headers['Message-ID'].slice(1, -1);
        expect(emailMessages.transitionStatus).toHaveBeenCalledWith(
            'draft-1',
            ['sending'],
            'sent',
            expect.objectContaining({ messageIdHeader: bare, inReplyTo: 'in-1@client.test' }),
        );
        expect(emailMessages.save).not.toHaveBeenCalled();
    });
});

describe('buildOutboundHeaders', () => {
    it('drops header injection attempts: CR/LF in a value, an illegal name', () => {
        const headers = buildOutboundHeaders('a@acme.test', {
            'In-Reply-To': '<x@y>\r\nBcc: victim@evil.test',
            'X-Bad Name': 'v',
            'X-Colon:Name': 'v',
            References: '<ok@y>',
        });
        expect(headers['In-Reply-To']).toBeUndefined();
        expect(headers['X-Bad Name']).toBeUndefined();
        expect(headers['X-Colon:Name']).toBeUndefined();
        expect(headers.References).toBe('<ok@y>');
        expect(headers['Message-ID']).toMatch(/@acme\.test>$/);
    });

    it('falls back to a platform domain when the from address has none', () => {
        expect(buildOutboundHeaders('not-an-address', undefined)['Message-ID']).toMatch(
            /@ever\.works>$/,
        );
    });
});

describe('threadingFieldsOf / replyHeadersFor', () => {
    it('round-trips a reply chain', () => {
        const parent = {
            messageIdHeader: 'in-2@client.test',
            inReplyTo: 'out-1@acme.test',
            references: ['root@client.test', 'out-1@acme.test'],
        };
        const headers = replyHeadersFor(parent);
        expect(headers).toEqual({
            'In-Reply-To': '<in-2@client.test>',
            References: '<root@client.test> <out-1@acme.test> <in-2@client.test>',
        });
        expect(threadingFieldsOf({ ...headers, 'Message-ID': '<out-2@acme.test>' })).toEqual({
            messageIdHeader: 'out-2@acme.test',
            inReplyTo: 'in-2@client.test',
            references: ['root@client.test', 'out-1@acme.test', 'in-2@client.test'],
        });
    });

    it("uses the parent's In-Reply-To when it has no References", () => {
        expect(
            replyHeadersFor({ messageIdHeader: 'b@x', inReplyTo: 'a@x', references: null }),
        ).toEqual({ 'In-Reply-To': '<b@x>', References: '<a@x> <b@x>' });
    });

    it('answers no headers for a parent without a Message-ID', () => {
        expect(replyHeadersFor({ messageIdHeader: null })).toEqual({});
    });
});

/** EW-P4-3 — the facade refuses to send from an unverified tenant address. */
describe('EmailFacadeService.send — verified sender (EW-P4-3)', () => {
    function facadeWith(address: { address: string; verified: boolean } | null) {
        const plugin = {
            id: 'postmark',
            capabilities: ['email-outbound'],
            sendEmail: jest.fn().mockResolvedValue({
                provider: 'postmark',
                providerMessageId: 'pm-1',
                accepted: [],
                rejected: [],
            }),
        };
        const emailAddresses = { findById: jest.fn().mockResolvedValue(address) };
        const gate = { assertSendAllowed: jest.fn().mockResolvedValue(undefined) };
        const facade = new EmailFacadeService(
            { getByCapability: jest.fn().mockReturnValue([]) } as never,
            { getSettings: jest.fn().mockResolvedValue({}) } as never,
            undefined,
            emailAddresses as never,
            undefined,
            undefined,
            undefined,
            gate as never,
        );
        jest.spyOn(
            facade as unknown as { resolveOutboundPlugin: () => unknown },
            'resolveOutboundPlugin',
        ).mockResolvedValue(plugin as never);
        return { facade, plugin, gate };
    }

    afterEach(() => {
        delete process.env.EMAIL_SENDER_VERIFICATION_REQUIRED;
    });

    it('refuses (403) before the send gate and the provider', async () => {
        const { facade, plugin, gate } = facadeWith({ address: 'nova@x.com', verified: false });
        await expect(
            facade.send(INPUT, { userId: 'user-1', addressId: 'addr-1' }),
        ).rejects.toMatchObject({ status: 403, name: 'EmailSenderNotVerifiedException' });
        expect(gate.assertSendAllowed).not.toHaveBeenCalled();
        expect(plugin.sendEmail).not.toHaveBeenCalled();
    });

    it('sends from a verified address, and without an address no check applies', async () => {
        const verified = facadeWith({ address: 'nova@x.com', verified: true });
        await verified.facade.send(INPUT, { userId: 'user-1', addressId: 'addr-1' });
        expect(verified.plugin.sendEmail).toHaveBeenCalled();
        const system = facadeWith({ address: 'nova@x.com', verified: false });
        await system.facade.send(INPUT, { userId: 'user-1' });
        expect(system.plugin.sendEmail).toHaveBeenCalled();
    });

    it('is switched off only by EMAIL_SENDER_VERIFICATION_REQUIRED=false (exact)', async () => {
        process.env.EMAIL_SENDER_VERIFICATION_REQUIRED = 'FALSE';
        const strict = facadeWith({ address: 'nova@x.com', verified: false });
        await expect(
            strict.facade.send(INPUT, { userId: 'user-1', addressId: 'addr-1' }),
        ).rejects.toMatchObject({ status: 403 });
        process.env.EMAIL_SENDER_VERIFICATION_REQUIRED = 'false';
        const lax = facadeWith({ address: 'nova@x.com', verified: false });
        await lax.facade.send(INPUT, { userId: 'user-1', addressId: 'addr-1' });
        expect(lax.plugin.sendEmail).toHaveBeenCalled();
    });
});
