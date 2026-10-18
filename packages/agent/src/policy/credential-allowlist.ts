import { envVarNameForCredential } from './credential-resolver';

/**
 * `{{cred.key}}` — WHERE a credential may be substituted (prompt-injection
 * hardening, review of #2769).
 *
 * Substituting a secret into an arbitrary tool argument hands it to wherever
 * that argument goes: a URL an injected instruction chose, an email body, a
 * Task comment. So a reference is substituted only where somebody who is not
 * the model declared it may go:
 *
 *  1. a tool argument the PLATFORM declared as a credential slot
 *     (`'x-credential': true` on a built-in descriptor's schema); or
 *  2. a tool the OPERATOR allowed for that one credential, in the environment:
 *
 *         EVERWORKS_CRED_<KEY>_ALLOW=tool[,tool@host,...]
 *
 *     - `tool` — the exact tool name the model calls (case-insensitive), e.g.
 *       `mcp__billing__create_invoice`; the reference may appear in any of
 *       that tool's arguments;
 *     - `tool@host` — the same, but only when the call's `url` argument points
 *       at exactly `host` (case-insensitive, no wildcard). A tool without a
 *       `url` argument never matches a host-bound entry.
 *
 * Anything else is refused before the credential is resolved. MCP CONNECTION
 * headers (`Authorization: Bearer {{cred.x}}` stored on the connection) have
 * their own path (`mcp/mcp-header-credentials.ts`) and need no allow entry.
 *
 * Pure: reads only the environment it is given.
 */

export interface CredentialAllowEntry {
    /** Tool name, lower-cased. */
    readonly tool: string;
    /** Host the call's `url` argument must name, lower-cased; `null` = any. */
    readonly host: string | null;
}

/** The environment variable holding one credential's allow list. */
export function credentialAllowEnvVar(key: string): string {
    return `${envVarNameForCredential(key)}_ALLOW`;
}

/** The parsed allow list of one credential. Malformed entries are ignored. */
export function credentialAllowEntries(
    key: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialAllowEntry[] {
    const raw = env[credentialAllowEnvVar(key)] ?? '';
    const out: CredentialAllowEntry[] = [];
    for (const part of raw.split(',')) {
        const entry = part.trim();
        if (!entry) continue;
        const at = entry.lastIndexOf('@');
        const tool = (at > 0 ? entry.slice(0, at) : entry).trim().toLowerCase();
        const host = at > 0 ? entry.slice(at + 1).trim().toLowerCase() : null;
        if (!/^[a-z0-9_.:-]+$/.test(tool)) continue;
        if (host !== null && !/^[a-z0-9.-]+$/.test(host)) continue;
        out.push({ tool, host });
    }
    return out;
}

/** Lower-cased host of a tool call's `url` argument, or `null`. */
export function urlArgumentHost(args: unknown): string | null {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    const url = (args as Record<string, unknown>).url;
    if (typeof url !== 'string' || !url) return null;
    try {
        return new URL(url).hostname.toLowerCase().replace(/\.$/, '') || null;
    } catch {
        return null;
    }
}

/** Whether the operator allowed credential `key` in this call of `toolName`. */
export function credentialUseAllowed(
    input: { key: string; toolName: string; args: unknown },
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    const tool = input.toolName.toLowerCase();
    const entries = credentialAllowEntries(input.key, env).filter((entry) => entry.tool === tool);
    if (entries.length === 0) return false;
    if (entries.some((entry) => entry.host === null)) return true;
    const host = urlArgumentHost(input.args);
    return host !== null && entries.some((entry) => entry.host === host);
}
