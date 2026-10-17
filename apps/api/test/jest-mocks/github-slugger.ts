/**
 * Jest replacement for the ESM-only `github-slugger` package (see the
 * `moduleNameMapper` rule in `apps/api/jest.config.js`).
 *
 * Mirrors the behaviour readme-builder relies on: lower-case, drop
 * characters that are not letters, digits, spaces or dashes, spaces to `-`,
 * and `-1`, `-2`, … for a repeat within one instance.
 */
export default class GithubSlugger {
    private readonly seen = new Map<string, number>();

    slug(value: string): string {
        const base = String(value)
            .toLowerCase()
            .trim()
            .replace(/[^\p{L}\p{N}\s-]/gu, '')
            .replace(/\s/g, '-');
        const count = this.seen.get(base) ?? 0;
        this.seen.set(base, count + 1);
        return count === 0 ? base : `${base}-${count}`;
    }

    reset(): void {
        this.seen.clear();
    }
}

export function slug(value: string): string {
    return new GithubSlugger().slug(value);
}
