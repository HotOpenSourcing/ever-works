/**
 * Prompt-injection hardening — repository paths an Agent may NEVER write,
 * whatever kind of Work it is working on.
 *
 * A workflow file is what RUNS a repository's checks, deploys and releases,
 * and a composite action under `.github/actions/` is code those workflows
 * execute with the repository's secrets. An Agent that can write either can
 * switch the checks off, or run arbitrary code in CI with the Work's tokens —
 * and for a non-App Work the push goes out on the owner's OAuth token, which
 * carries the `workflow` scope precisely so it CAN change these files.
 *
 * App Works already refuse `.github/workflows/**` through the App change gate
 * (`app-change-guard.ts`, `ALWAYS_PROTECTED`); this floor applies to EVERY
 * Work kind, and adds `.github/actions/**`. It is not configurable: a person
 * changes these files, through their own tools.
 */
export const ALWAYS_PROTECTED_REPO_PREFIXES: readonly string[] = Object.freeze([
    '.github/workflows/',
    '.github/actions/',
]);

/** A repository path in the form the guard compares: posix, no `./`, lower-cased. */
function comparable(path: string): string {
    let out = path.trim().replace(/\\/g, '/');
    while (out.startsWith('./')) out = out.slice(2);
    while (out.startsWith('/')) out = out.slice(1);
    return out.toLowerCase();
}

/** Whether one repository path is under an always-protected prefix. */
export function isAlwaysProtectedRepoPath(path: string | null | undefined): boolean {
    if (typeof path !== 'string' || !path.trim()) return false;
    const candidate = comparable(path);
    return ALWAYS_PROTECTED_REPO_PREFIXES.some(
        (prefix) => candidate.startsWith(prefix) || candidate === prefix.slice(0, -1),
    );
}

/** The distinct always-protected paths among `paths`, in first-seen order. */
export function alwaysProtectedRepoPaths(
    paths: ReadonlyArray<string | null | undefined>,
): string[] {
    const out: string[] = [];
    for (const path of paths) {
        if (isAlwaysProtectedRepoPath(path) && !out.includes(path as string)) {
            out.push(path as string);
        }
    }
    return out;
}

/**
 * Throw when any of `paths` is always protected. The message names the paths
 * (never their content) and what was NOT done, matching the other refusals of
 * the Agent git tools.
 */
export function assertNoAlwaysProtectedPaths(
    toolName: string,
    paths: ReadonlyArray<string | null | undefined>,
    nothingDone: string,
): void {
    const hits = alwaysProtectedRepoPaths(paths);
    if (hits.length === 0) return;
    throw new Error(
        `${toolName}: agents may not change GitHub workflow or action files ` +
            `(${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}). ` +
            `These run the repository's checks and deploys with its secrets; a person ` +
            `changes them. ${nothingDone}`,
    );
}
