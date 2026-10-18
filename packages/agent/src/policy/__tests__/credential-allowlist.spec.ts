import {
    credentialAllowEntries,
    credentialAllowEnvVar,
    credentialUseAllowed,
    urlArgumentHost,
} from '../credential-allowlist';

/**
 * `{{cred.key}}` allowances an OPERATOR declares per credential
 * (`EVERWORKS_CRED_<KEY>_ALLOW=tool[,tool@host]`) — review of #2769.
 */
describe('credential allowlist', () => {
    const env = {
        EVERWORKS_CRED_BILLING_TOKEN_ALLOW:
            'mcp__billing__create_invoice, extractContent@api.billing.test, bad tool!, x@bad host',
    };

    it('derives the variable from the credential env var name', () => {
        expect(credentialAllowEnvVar('billing_token')).toBe('EVERWORKS_CRED_BILLING_TOKEN_ALLOW');
        expect(credentialAllowEnvVar('billing.token')).toBe('EVERWORKS_CRED_BILLING_TOKEN_ALLOW');
    });

    it('parses tool and tool@host entries, ignoring malformed ones', () => {
        expect(credentialAllowEntries('billing_token', env)).toEqual([
            { tool: 'mcp__billing__create_invoice', host: null },
            { tool: 'extractcontent', host: 'api.billing.test' },
        ]);
        expect(credentialAllowEntries('other', env)).toEqual([]);
    });

    it('allows a plain tool entry in any argument of that tool only', () => {
        const allowed = (toolName: string) =>
            credentialUseAllowed({ key: 'billing_token', toolName, args: {} }, env);
        expect(allowed('mcp__billing__create_invoice')).toBe(true);
        expect(allowed('MCP__BILLING__CREATE_INVOICE')).toBe(true);
        expect(allowed('sendEmail')).toBe(false);
        expect(credentialUseAllowed({ key: 'other', toolName: 'sendEmail', args: {} }, env)).toBe(false);
    });

    it('a host-bound entry matches only when the url argument names exactly that host', () => {
        const allowed = (url: unknown) =>
            credentialUseAllowed(
                { key: 'billing_token', toolName: 'extractContent', args: { url } },
                env,
            );
        expect(allowed('https://api.billing.test/v1/x')).toBe(true);
        expect(allowed('https://API.billing.test./v1/x')).toBe(true);
        expect(allowed('https://evil.test/?h=api.billing.test')).toBe(false);
        expect(allowed('https://api.billing.test.evil.test/')).toBe(false);
        expect(allowed(undefined)).toBe(false);
        expect(allowed('not a url')).toBe(false);
    });

    it('urlArgumentHost reads only a top-level string url', () => {
        expect(urlArgumentHost({ url: 'https://a.test/x' })).toBe('a.test');
        expect(urlArgumentHost({ nested: { url: 'https://a.test' } })).toBeNull();
        expect(urlArgumentHost(['https://a.test'])).toBeNull();
    });
});
