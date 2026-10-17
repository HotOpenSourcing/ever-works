import { KubernetesPlugin } from '@ever-works/k8s-plugin';
import { KubernetesAppsTierPlugin } from '../index.js';

/** APW-10 lite — the managed target's plugin, and the two-way target split with `k8s`. */

const KUBECONFIG = [
	'apiVersion: v1',
	'kind: Config',
	'current-context: ew',
	'clusters:',
	'  - name: ew',
	'    cluster:',
	'      server: https://192.168.1.150:6443',
	'      certificate-authority-data: Y2E=',
	'contexts:',
	'  - name: ew',
	'    context: { cluster: ew, user: ew }',
	'users:',
	'  - name: ew',
	'    user: { token: abc }',
	''
].join('\n');

const managedRef = { workId: 'w1', namespace: 'ewapp-0123abcd', target: 'ever-works-apps' as const, kubeContext: null };
const clusterRef = { workId: 'w1', namespace: 'ew-app-0123abcd', target: 'your-cluster' as const, kubeContext: null };

describe('KubernetesAppsTierPlugin', () => {
	it('declares deployment + apps-tier under its own id, hidden', () => {
		const plugin = new KubernetesAppsTierPlugin();
		expect(plugin.id).toBe('k8s-apps-tier');
		expect([...plugin.capabilities]).toEqual(['deployment', 'apps-tier']);
		const manifest = plugin.getManifest();
		expect(manifest.id).toBe('k8s-apps-tier');
		expect(manifest.capabilities).toEqual(['deployment', 'apps-tier']);
		expect(manifest.visibility).toBe('hidden');
		expect(plugin.supportsApps).toBe(true);
	});

	it('serves ever-works-apps only; the k8s plugin serves your-cluster only', async () => {
		const tier = new KubernetesAppsTierPlugin() as unknown as {
			assertThisPluginServes(ref: unknown): void;
		};
		const k8s = new KubernetesPlugin() as unknown as { assertThisPluginServes(ref: unknown): void };
		expect(() => tier.assertThisPluginServes(managedRef)).not.toThrow();
		expect(() => tier.assertThisPluginServes(clusterRef)).toThrow(/does not serve/);
		expect(() => k8s.assertThisPluginServes(clusterRef)).not.toThrow();
		expect(() => k8s.assertThisPluginServes(managedRef)).toThrow(/does not serve/);
	});

	it('accepts the operator kubeconfig on a private address (shape checks only)', async () => {
		const tier = new KubernetesAppsTierPlugin() as unknown as {
			guardedAppCredential(credential: string, ctx?: string | null): Promise<string>;
		};
		await expect(tier.guardedAppCredential(KUBECONFIG)).resolves.toBe(KUBECONFIG);
		await expect(tier.guardedAppCredential(KUBECONFIG.replace('    user: { token: abc }', '    user: { exec: { command: sh } }'))).rejects.toThrow();
	});

	it('refuses website deploys', async () => {
		await expect(new KubernetesAppsTierPlugin().deploy({} as never, KUBECONFIG)).rejects.toThrow(/App Works only/);
	});
});
