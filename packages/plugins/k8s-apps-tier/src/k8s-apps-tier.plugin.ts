import type {
	AppDestroyResult,
	AppTargetRef,
	DeploymentConfig,
	DeploymentResult,
	PluginManifest
} from '@ever-works/plugin';
import { K8sPluginError, KubernetesPlugin, assertSupportedKubeconfig } from '@ever-works/k8s-plugin';

/**
 * **APW-10 lite — Ever Works Apps (managed).** The `apps-tier` deployment plugin that runs App
 * Works on the PLATFORM's own Kubernetes cluster, one restricted namespace per App Work.
 *
 * The full APW-10 design reconciles a `Work` resource through an in-zone controller. This lite
 * version reuses the `your-cluster` machinery instead — the same renderer, deployer, lifecycle and
 * status reader of `@ever-works/k8s-plugin`, which already render the managed target's own policy
 * (`ResourceQuota`, the smaller `LimitRange`, the default-deny + same-namespace + DNS/internet
 * egress + ingress-controller-only NetworkPolicies, Pod Security `restricted`, the tier's
 * `runtimeClassName`) — dialled with the platform-held credential `AppsTierPolicy` hands out.
 *
 * ## What is different from the `k8s` plugin, and why
 *
 * 1. **Target.** It serves `ever-works-apps` ONLY (and the `k8s` plugin `your-cluster` only), so a
 *    member's kubeconfig can never reach this plugin and the platform credential can never reach
 *    the member's plugin. The runtime facade selects it by capability (`deployment` + `apps-tier`,
 *    `facades/app-runtime.facade.ts`), never by id.
 * 2. **The credential is the operator's, not a member's.** §6.1's public-address pinning exists to
 *    stop a member's kubeconfig from pointing the platform at an internal address (SSRF). The
 *    platform's own cluster is legitimately internal, so this plugin keeps the shape refusals
 *    (`assertSupportedKubeconfig`: no exec/auth-provider/file reads, inline CA required, https only)
 *    and skips the public-address step. The credential is RBAC-limited to `ewapp-*` namespaces on
 *    the cluster side (see `docs/features/app-works-managed-target.md`).
 * 3. **Removal deletes the namespace.** A managed namespace holds nothing the platform could hand
 *    back after the App Work is removed, so `destroyApp` always deletes the whole namespace (data
 *    included) rather than keeping volumes in the platform's cluster indefinitely.
 * 4. **No website deploys.** It is hidden from the deploy-provider lists and refuses the legacy
 *    website `deploy()` path outright.
 */
export class KubernetesAppsTierPlugin extends KubernetesPlugin {
	override readonly id: string = 'k8s-apps-tier';
	override readonly name: string = 'Ever Works Apps (managed)';
	override readonly capabilities: readonly string[] = ['deployment', 'apps-tier'];
	override readonly providerName: string = 'ever-works-apps-k8s';

	override getManifest(): PluginManifest {
		return {
			...super.getManifest(),
			id: this.id,
			name: this.name,
			description:
				"Runs App Works on the platform's own Kubernetes cluster, one restricted namespace per App Work",
			capabilities: [...this.capabilities],
			visibility: 'hidden'
		};
	}

	protected override servesAppTarget(target: string | undefined): boolean {
		return target === 'ever-works-apps';
	}

	/** Shape refusals only — see the class docstring, point 2. */
	protected override async guardedAppCredential(credential: string, kubeContext?: string | null): Promise<string> {
		assertSupportedKubeconfig(credential, kubeContext ?? undefined);
		return credential;
	}

	/** Point 3: the managed namespace goes, data included. */
	override async destroyApp(
		ref: AppTargetRef,
		credential: string,
		_opts: { deleteVolumes: boolean }
	): Promise<AppDestroyResult> {
		return super.destroyApp(ref, credential, { deleteVolumes: true });
	}

	/** Point 4: website deploys never run on the managed tier. */
	override async deploy(_config: DeploymentConfig, _kubeconfig: string): Promise<DeploymentResult> {
		throw new K8sPluginError(
			'NOT_CONFIGURED',
			'Ever Works Apps (managed) runs App Works only; it is not a website deployment provider.'
		);
	}
}
