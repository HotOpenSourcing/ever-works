/**
 * Prompt-injection hardening — ONE trusted-sender rule for every inbound email,
 * the first one of a thread and every reply alike (review of #2769):
 *
 *  - from a TRUSTED sender, the receiving Agent picks the email up as it always
 *    did (a joined reply mentions it live; a new email files its Task as before);
 *  - from anyone else, the Task is still created / the reply still filed, but
 *    nothing wakes the Agent: the owner is told in their Inbox and decides.
 *
 * Trusted = the address is one of the owner's own VERIFIED addresses (their
 * verified account email, or a verified inbound/outbound address they own —
 * which is how one of their Agents mails another) or is listed in
 * `INBOUND_EMAIL_TRUSTED_SENDERS` (comma-separated addresses or `@domain`
 * entries) — AND, when the inbound provider reports an SPF / DKIM / DMARC
 * verdict, that verdict is a pass.
 *
 * ## The From-spoofing caveat
 *
 * `From` is written by the sender. Where the provider passes no
 * authentication verdict through (see {@link senderAuthVerdict}), a trusted
 * address is trusted on its spelling alone, so a forged `From` of a trusted
 * address would be believed. Prefer a provider that forwards
 * `Authentication-Results` / `Received-SPF`, and keep the trusted list short.
 *
 * `INBOUND_EMAIL_AUTO_DISPATCH_ALL=true` (or its older spelling
 * `INBOUND_EMAIL_REPLY_AUTO_DISPATCH=true`) restores the pre-hardening
 * behaviour for EVERY sender.
 */

type Env = Readonly<Record<string, string | undefined>>;

const truthy = (value: string | undefined): boolean =>
    (value ?? '').trim().toLowerCase() === 'true';

/** `INBOUND_EMAIL_AUTO_DISPATCH_ALL=true` or the older `INBOUND_EMAIL_REPLY_AUTO_DISPATCH=true`. */
export function inboundEmailAutoDispatchAll(env: Env = process.env): boolean {
    return (
        truthy(env.INBOUND_EMAIL_AUTO_DISPATCH_ALL) || truthy(env.INBOUND_EMAIL_REPLY_AUTO_DISPATCH)
    );
}

/** The bare, lower-cased mailbox of a header address (`"Ada" <A@x.io>` → `a@x.io`). */
export function bareSenderAddress(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const text = raw.trim();
    const open = text.lastIndexOf('<');
    const close = text.lastIndexOf('>');
    const bare = open >= 0 && close > open ? text.slice(open + 1, close) : text;
    return bare.trim().toLowerCase();
}

/** `INBOUND_EMAIL_TRUSTED_SENDERS`, lower-cased: full addresses and `@domain` entries. */
export function configuredTrustedSenders(env: Env = process.env): string[] {
    return (env.INBOUND_EMAIL_TRUSTED_SENDERS ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
}

/**
 * The provider's authentication verdict for the message, when it passed one
 * through: `pass`, `fail`, or `unknown` (nothing reported).
 *
 * Reads, in order: explicit `dmarc` / `dkim` / `spf` fields on the metadata,
 * then the `Authentication-Results` and `Received-SPF` headers (Postmark
 * forwards headers as `[{ Name, Value }]`; a plain object map is read too).
 * A DMARC result decides alone when present; otherwise a DKIM or SPF pass is
 * a pass, and any other reported result is a fail.
 */
export function senderAuthVerdict(metadata: unknown): 'pass' | 'fail' | 'unknown' {
    if (!metadata || typeof metadata !== 'object') return 'unknown';
    const meta = metadata as Record<string, unknown>;
    const results: { dmarc?: string; dkim?: string; spf?: string } = {};
    const note = (kind: 'dmarc' | 'dkim' | 'spf', value: unknown) => {
        if (typeof value !== 'string' || !value.trim()) return;
        if (results[kind] === 'pass') return;
        results[kind] = value
            .trim()
            .toLowerCase()
            .split(/[\s;(]/)[0];
    };
    note('dmarc', meta.dmarc);
    note('dkim', meta.dkim);
    note('spf', meta.spf);

    const headerValues = (name: string): string[] => {
        const headers = meta.headers;
        const out: string[] = [];
        if (Array.isArray(headers)) {
            for (const header of headers) {
                const h = header as Record<string, unknown>;
                const key = String(h?.Name ?? h?.name ?? '').toLowerCase();
                const value = h?.Value ?? h?.value;
                if (key === name && typeof value === 'string') out.push(value);
            }
        } else if (headers && typeof headers === 'object') {
            for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
                if (key.toLowerCase() === name && typeof value === 'string') out.push(value);
            }
        }
        return out;
    };
    for (const value of headerValues('authentication-results')) {
        for (const kind of ['dmarc', 'dkim', 'spf'] as const) {
            const match = new RegExp(`\\b${kind}=([a-z]+)`, 'i').exec(value);
            if (match) note(kind, match[1]);
        }
    }
    for (const value of headerValues('received-spf')) note('spf', value);

    if (results.dmarc) return results.dmarc === 'pass' ? 'pass' : 'fail';
    if (results.dkim === 'pass' || results.spf === 'pass') return 'pass';
    if (results.dkim || results.spf) return 'fail';
    return 'unknown';
}

/** Whether an inbound email's sender is trusted (see the file comment). */
export function isTrustedSender(input: {
    from: string;
    ownerAddresses: readonly string[];
    metadata?: unknown;
    env?: Env;
}): boolean {
    const sender = bareSenderAddress(input.from);
    if (!sender || !sender.includes('@')) return false;
    const domain = sender.slice(sender.lastIndexOf('@'));
    const owner = new Set(input.ownerAddresses.map(bareSenderAddress).filter(Boolean));
    const listed = configuredTrustedSenders(input.env);
    const known = owner.has(sender) || listed.some((entry) => entry === sender || entry === domain);
    if (!known) return false;
    return senderAuthVerdict(input.metadata) !== 'fail';
}
