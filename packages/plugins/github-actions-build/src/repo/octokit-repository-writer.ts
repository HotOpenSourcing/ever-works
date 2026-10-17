import type {
	CreatePROptions,
	GitBranch,
	GitPullRequest,
	RepositoryCommitInput,
	RepositoryWriteErrorCode,
	RepositoryWriter
} from '@ever-works/plugin';

/**
 * APW-05 T16 remainder (outstanding-work A0.4, ledger D19) — the clone-free
 * {@link RepositoryWriter} over GitHub's REST API.
 *
 * ## Why the build plugin carries its own writer
 *
 * `prepareRepository` needs four repository operations — read a file, land one
 * commit, create a branch, open a pull request — and plan §4.1 says the facade
 * binds them "to `GitFacadeService`". That facade has three of the four but no
 * `commitFiles` (APW-03 T22 declares it and has not landed), so every production
 * prepare answered `pluginUnavailable` before the request was even built. This
 * plugin already holds Octokit and the member's token, and every one of the four
 * is a plain REST call, so it supplies the writer itself
 * (`IBuildPlugin.repositoryWriter?`) and the facade prefers it. When APW-03 T22
 * lands a git-provider `commitFiles`, the facade may bind that instead; nothing
 * in `workflow-writer.ts` changes either way.
 *
 * ## The four refusal codes the contract names
 *
 * A refusal is THROWN with `code` set, which is what `repositoryWriteErrorCode`
 * reads:
 *
 *  - `nonFastForward` — `PATCH …/git/refs/heads/<branch>` answered 422 "not a
 *    fast forward": the branch moved under us, and the caller retries from a
 *    fresh head (never a force-push);
 *  - `refRejectedByRule` — 409/422 mentioning a protection rule or a
 *    required status/review: the caller switches to the pull-request path;
 *  - `pullRequestExists` — 422 "A pull request already exists".
 *
 * Every other failure is rethrown untouched.
 */

/** The subset of Octokit's surface this writer uses. */
export interface OctokitRequester {
	request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown; status?: number }>;
}

/** An error carrying one of the contract's refusal codes. */
export class RepositoryWriteError extends Error {
	constructor(
		readonly code: RepositoryWriteErrorCode,
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'RepositoryWriteError';
	}
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

function statusOf(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : undefined;
}

function messageOf(error: unknown): string {
	const candidate = error as { message?: unknown; response?: { data?: { message?: unknown; errors?: unknown } } };
	const parts: string[] = [];
	if (typeof candidate?.message === 'string') parts.push(candidate.message);
	const data = candidate?.response?.data;
	if (typeof data?.message === 'string') parts.push(data.message);
	if (Array.isArray(data?.errors)) {
		for (const entry of data.errors) {
			const message = (entry as { message?: unknown })?.message;
			if (typeof message === 'string') parts.push(message);
		}
	}
	return parts.join(' | ');
}

/** GitHub's wording for a ref update a rule refused (branch protection, rulesets). */
const RULE_REFUSAL = /protected branch|ruleset|rule violation|required status|required review|push declined|cannot be updated/i;

/**
 * The writer for one repository, bound to one token.
 *
 * `trackedBranch` is the default `ref` for {@link RepositoryWriter.getFileContent}
 * — the contract's "default: the tracked branch".
 */
export function octokitRepositoryWriter(
	octokit: OctokitRequester,
	repository: { readonly owner: string; readonly repo: string; readonly trackedBranch?: string }
): RepositoryWriter {
	const base = { owner: repository.owner, repo: repository.repo };

	async function headOf(ref: string): Promise<string> {
		if (FULL_SHA.test(ref)) return ref;
		const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
			...base,
			ref: `heads/${ref}`
		});
		const sha = (data as { object?: { sha?: unknown } })?.object?.sha;
		if (typeof sha !== 'string') throw new Error(`github-actions-build: no head commit for ${ref}`);
		return sha;
	}

	return {
		async getFileContent(path, ref) {
			try {
				const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
					...base,
					path,
					...((ref ?? repository.trackedBranch) ? { ref: ref ?? repository.trackedBranch } : {})
				});
				const file = data as { type?: unknown; content?: unknown; encoding?: unknown };
				if (Array.isArray(data) || file?.type !== 'file' || typeof file.content !== 'string') return null;
				return {
					content: file.content,
					encoding: typeof file.encoding === 'string' ? file.encoding : 'base64'
				};
			} catch (error) {
				// A file that does not exist is not an error (plan §4.6 steps 4, 5).
				if (statusOf(error) === 404) return null;
				throw error;
			}
		},

		async commitFiles(input: RepositoryCommitInput) {
			const { data: baseCommit } = await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
				...base,
				commit_sha: input.baseSha
			});
			const baseTree = (baseCommit as { tree?: { sha?: unknown } })?.tree?.sha;
			if (typeof baseTree !== 'string') {
				throw new Error(`github-actions-build: commit ${input.baseSha} has no tree`);
			}

			const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
			for (const file of input.files) {
				const { data: blob } = await octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
					...base,
					content: file.content,
					encoding: file.encoding === 'base64' ? 'base64' : 'utf-8'
				});
				const sha = (blob as { sha?: unknown })?.sha;
				if (typeof sha !== 'string') throw new Error(`github-actions-build: no blob sha for ${file.path}`);
				tree.push({ path: file.path, mode: '100644', type: 'blob', sha });
			}

			const { data: newTree } = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
				...base,
				base_tree: baseTree,
				tree
			});
			const { data: commit } = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
				...base,
				message: input.message,
				tree: (newTree as { sha: string }).sha,
				parents: [input.baseSha]
			});
			const commitSha = (commit as { sha: string }).sha;

			try {
				await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
					...base,
					ref: `heads/${input.branch}`,
					sha: commitSha,
					// Never a force-push: a moved branch is `nonFastForward`.
					force: false
				});
			} catch (error) {
				const status = statusOf(error);
				const message = messageOf(error);
				if (status === 422 && /fast[ -]?forward/i.test(message)) {
					throw new RepositoryWriteError('nonFastForward', `${input.branch} moved; retry from its new head`, error);
				}
				if ((status === 409 || status === 422 || status === 403) && RULE_REFUSAL.test(message)) {
					throw new RepositoryWriteError('refRejectedByRule', `${input.branch} refused the update`, error);
				}
				throw error;
			}
			return { commitSha };
		},

		async createBranch(name: string, fromRef: string): Promise<GitBranch> {
			try {
				const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
					...base,
					branch: name
				});
				const branch = data as { name?: string; commit?: { sha?: string }; protected?: boolean };
				// An existing branch is returned rather than recreated (the contract).
				return {
					name: branch.name ?? name,
					commit: branch.commit?.sha ?? '',
					isDefault: false,
					isProtected: branch.protected === true
				};
			} catch (error) {
				if (statusOf(error) !== 404) throw error;
			}
			const sha = await headOf(fromRef);
			await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
				...base,
				ref: `refs/heads/${name}`,
				sha
			});
			return { name, commit: sha, isDefault: false };
		},

		async createPullRequest(options: Omit<CreatePROptions, 'owner' | 'repo'>): Promise<GitPullRequest> {
			try {
				const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
					...base,
					title: options.title,
					head: options.headOwner ? `${options.headOwner}:${options.head}` : options.head,
					base: options.base,
					...(options.body ? { body: options.body } : {}),
					...(options.draft ? { draft: true } : {})
				});
				const pr = data as {
					number: number;
					title?: string;
					state?: string;
					html_url?: string;
					created_at?: string;
					updated_at?: string;
					body?: string | null;
				};
				return {
					number: pr.number,
					title: pr.title ?? options.title,
					state: pr.state === 'closed' ? 'closed' : 'open',
					head: options.head,
					base: options.base,
					url: pr.html_url ?? '',
					createdAt: pr.created_at ?? new Date().toISOString(),
					updatedAt: pr.updated_at ?? new Date().toISOString(),
					...(pr.body ? { body: pr.body } : {})
				};
			} catch (error) {
				if (statusOf(error) === 422 && /pull request already exists/i.test(messageOf(error))) {
					throw new RepositoryWriteError('pullRequestExists', 'an open pull request already exists', error);
				}
				throw error;
			}
		}
	};
}
