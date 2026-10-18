import {
    bareSenderAddress,
    inboundEmailAutoDispatchAll,
    isTrustedSender,
    senderAuthVerdict,
} from '../inbound-email-trust';

/** Prompt-injection hardening — the one trusted-sender rule for inbound email. */
describe('inbound email trusted-sender rule', () => {
    const owner = ['Owner <owner@acme.test>', 'support@agents.acme.test'];

    it('trusts the owner’s own verified addresses, case and display name aside', () => {
        expect(isTrustedSender({ from: 'OWNER@acme.test', ownerAddresses: owner, env: {} })).toBe(
            true,
        );
        expect(
            isTrustedSender({
                from: 'Bot <support@agents.acme.test>',
                ownerAddresses: owner,
                env: {},
            }),
        ).toBe(true);
    });

    it('trusts INBOUND_EMAIL_TRUSTED_SENDERS addresses and @domains, nobody else', () => {
        const env = { INBOUND_EMAIL_TRUSTED_SENDERS: 'ops@partner.test, @client.test' };
        expect(isTrustedSender({ from: 'ops@partner.test', ownerAddresses: [], env })).toBe(true);
        expect(isTrustedSender({ from: 'anyone@client.test', ownerAddresses: [], env })).toBe(true);
        expect(isTrustedSender({ from: 'x@partner.test', ownerAddresses: [], env })).toBe(false);
        expect(isTrustedSender({ from: 'x@client.test.evil', ownerAddresses: [], env })).toBe(
            false,
        );
        expect(isTrustedSender({ from: 'mallory@evil.test', ownerAddresses: owner, env })).toBe(
            false,
        );
        expect(isTrustedSender({ from: 'not an address', ownerAddresses: owner, env })).toBe(false);
    });

    it('requires an authentication pass when the provider reports one (forged From is refused)', () => {
        const headers = (value: string) => ({
            headers: [{ Name: 'Authentication-Results', Value: value }],
        });
        expect(
            isTrustedSender({
                from: 'owner@acme.test',
                ownerAddresses: owner,
                metadata: headers('mx.test; spf=fail smtp.mailfrom=acme.test; dkim=none'),
                env: {},
            }),
        ).toBe(false);
        expect(
            isTrustedSender({
                from: 'owner@acme.test',
                ownerAddresses: owner,
                metadata: headers('mx.test; dkim=pass header.d=acme.test; spf=softfail'),
                env: {},
            }),
        ).toBe(true);
    });

    it('reads DMARC first, then DKIM/SPF, from fields or headers', () => {
        expect(senderAuthVerdict({ dmarc: 'fail', dkim: 'pass' })).toBe('fail');
        expect(senderAuthVerdict({ spf: 'pass' })).toBe('pass');
        expect(
            senderAuthVerdict({
                headers: [{ Name: 'Received-SPF', Value: 'Pass (mx: domain of x)' }],
            }),
        ).toBe('pass');
        expect(senderAuthVerdict({ headers: { 'received-spf': 'softfail (x)' } })).toBe('fail');
        expect(senderAuthVerdict({ spamScore: 1 })).toBe('unknown');
        expect(senderAuthVerdict(undefined)).toBe('unknown');
    });

    it('INBOUND_EMAIL_AUTO_DISPATCH_ALL and the older name both restore dispatch for all senders', () => {
        expect(inboundEmailAutoDispatchAll({})).toBe(false);
        expect(inboundEmailAutoDispatchAll({ INBOUND_EMAIL_AUTO_DISPATCH_ALL: 'true' })).toBe(true);
        expect(inboundEmailAutoDispatchAll({ INBOUND_EMAIL_REPLY_AUTO_DISPATCH: 'TRUE' })).toBe(
            true,
        );
        expect(inboundEmailAutoDispatchAll({ INBOUND_EMAIL_AUTO_DISPATCH_ALL: '1' })).toBe(false);
    });

    it('bareSenderAddress normalizes a header address', () => {
        expect(bareSenderAddress('"Ada L" <Ada@Example.COM>')).toBe('ada@example.com');
        expect(bareSenderAddress(42)).toBe('');
    });
});
