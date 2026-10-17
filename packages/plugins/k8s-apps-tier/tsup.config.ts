import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	// The k8s plugin stays a runtime dependency (one copy of the renderer and the API service);
	// the plugin contracts are bundled exactly as the k8s plugin bundles them.
	noExternal: ['@ever-works/plugin'],
	external: ['@ever-works/k8s-plugin'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true
});
