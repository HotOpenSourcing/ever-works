# Ever Works (managed) — running App Works on the platform's own cluster

> **Status:** APW-10 _lite_ (2026-10-17). Off by default. One switch opens it:
> `EVER_WORKS_APPS_MANAGED_ENABLED=true`.

An App Work can run on **None**, **Your cluster** (the member's own kubeconfig) or **Ever Works
(managed)**: our Kubernetes cluster, one restricted namespace per App Work. This page explains what
the managed target does, what the operator has to set, and the RBAC its credential needs.

## How it works

- **Plugin.** A builtin plugin, `k8s-apps-tier` (`packages/plugins/k8s-apps-tier`), declares the
  `deployment` and `apps-tier` capabilities.
    - It reuses the Kubernetes plugin's App renderer, deployer, lifecycle and status reader, and serves
      the `ever-works-apps` target only.
    - It is hidden from the deploy-provider lists and refuses website deploys.
- **Credential.** It is the platform's kubeconfig, `EVER_WORKS_APPS_MANAGED_KUBECONFIG`.
  `ConfigAppsTierPolicy` hands it out **only inside the isolated App runtime worker**; the API process
  refuses before it reads the variable. The value is never logged or echoed.
- **Namespace.** Each App Work gets `ewapp-<first 8 hex of the work id>`, created on the first
  deploy. Before anything else is written there, the plugin applies:
    - the **Namespace**, labelled for Pod Security **`restricted`** (enforce, audit and warn);
    - a **RoleBinding** `ever-works-apps-controller`, which grants the controller ServiceAccount the
      namespaced-admin ClusterRole **in that namespace only**.
- **Objects in each namespace.** The deployer then renders and applies:
    - a `ResourceQuota` (`ew-quota`) and a `LimitRange` (`ew-defaults`);
    - NetworkPolicies:
        - `ew-default-deny`;
        - `ew-allow-same-namespace`;
        - `ew-allow-egress`, which allows DNS and the internet but no cluster-internal ranges;
        - `ew-allow-ingress`, which admits traffic **only from the ingress controller's namespace**;
    - the workloads themselves. Every pod runs as non-root, drops all capabilities, uses the
      `RuntimeDefault` seccomp profile and runs in the tier's `runtimeClassName`.
- **Host.** The app is published at `<label>.<EVER_WORKS_APPS_MANAGED_DOMAIN>`, through an Ingress of
  class `EVER_WORKS_APPS_MANAGED_INGRESS_CLASS`. `<label>` is the Work's allocated subdomain. If the
  managed domain is unset, the shared apps apex (`EVER_WORKS_APPS_DOMAIN`, or else
  `EVER_WORKS_DOMAIN`) is used instead.
- **Licences.** Managed hosting is allowed only for a **green** licence class. **Amber**, **red** and
  **unknown** are refused even when the owner attested; the reason codes are unchanged:
  `upstreamAgreementMissing` for amber, `licenseNotGreen` for red and unknown. A closed tier answers
  `managedTierDisabled`. Setting `EVER_WORKS_APPS_MANAGED_SCOPE=verified-blueprints` further narrows
  managed hosting to verified Apps-catalog Blueprints.
- **Removal.** Removing the App, or deleting the App Work, deletes the whole `ewapp-*` namespace,
  data included.
- **Web.** The Deploy tab's target card enables **Ever Works (managed)** when `GET
/api/works/:id/app-target` reports `eligibility.managed.eligible: true`.

## Environment

All of the following are read per call. Set them on **both** the API and the App runtime worker,
except the kubeconfig, which goes on the **worker only**.

| Variable                                                                                                   | Where                   | Default                                             | Meaning                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EVER_WORKS_APPS_MANAGED_ENABLED`                                                                          | API + worker            | off                                                 | `true` opens the managed target.                                                                                                                                                                                         |
| `EVER_WORKS_APPS_MANAGED_KUBECONFIG`                                                                       | **worker only, secret** | —                                                   | Base64 kubeconfig (raw YAML is also accepted) for the controller ServiceAccount below. It needs inline `certificate-authority-data`, an `https` server and a token user; exec, auth-provider and file paths are refused. |
| `EVER_WORKS_APPS_MANAGED_DOMAIN`                                                                           | API + worker            | shared apps apex                                    | The apex for managed hosts, e.g. `apps.ever.works`. It needs a wildcard DNS record pointing at the cluster's ingress.                                                                                                    |
| `EVER_WORKS_APPS_MANAGED_INGRESS_CLASS`                                                                    | worker                  | `nginx`                                             | IngressClass of the cluster's existing controller.                                                                                                                                                                       |
| `EVER_WORKS_APPS_MANAGED_INGRESS_NAMESPACE`                                                                | worker                  | `ingress-nginx`                                     | The controller's namespace; it is the only source `ew-allow-ingress` admits.                                                                                                                                             |
| `EVER_WORKS_APPS_MANAGED_RUNTIME_CLASS`                                                                    | worker                  | — (**required**)                                    | RuntimeClass every managed pod runs in. Without it, deploys are refused `managed_sandbox_unavailable`. Use `ever-works-apps` from the YAML below.                                                                        |
| `EVER_WORKS_APPS_MANAGED_SCOPE`                                                                            | API + worker            | `any`                                               | `verified-blueprints` admits only verified Blueprints.                                                                                                                                                                   |
| `EVER_WORKS_APPS_MANAGED_SERVICE_ACCOUNT`                                                                  | worker                  | `ever-works-apps-system/ever-works-apps-controller` | Subject of each namespace's RoleBinding.                                                                                                                                                                                 |
| `EVER_WORKS_APPS_MANAGED_NAMESPACE_ROLE`                                                                   | worker                  | `ever-works-apps-namespace-admin`                   | ClusterRole each namespace's RoleBinding grants.                                                                                                                                                                         |
| `EVER_WORKS_APPS_MANAGED_NAMESPACE_GRANT`                                                                  | worker                  | on                                                  | `false` skips the per-namespace RoleBinding. Only use it if you bound the role some other way.                                                                                                                           |
| `EVER_WORKS_APPS_MANAGED_QUOTA_{CPU_REQUESTS,CPU_LIMITS,MEMORY_REQUESTS,MEMORY_LIMITS,STORAGE,PODS,PVCS}`  | worker                  | `2` / `4` / `4Gi` / `6Gi` / `20Gi` / `20` / `5`     | Per-namespace ResourceQuota. A malformed value is ignored.                                                                                                                                                               |
| `EVER_WORKS_APPS_MANAGED_LIMIT_{REQUEST_CPU,REQUEST_MEMORY,DEFAULT_CPU,DEFAULT_MEMORY,MAX_CPU,MAX_MEMORY}` | worker                  | `100m` / `128Mi` / `1` / `512Mi` / `2` / `4Gi`      | Per-container LimitRange.                                                                                                                                                                                                |

## RBAC — the controller's credential

The credential gets the smallest cluster-wide footprint that still lets it create a namespace:

- **Cluster-wide:** create, read and delete **Namespaces**, and create **RoleBindings** that grant
  exactly one ClusterRole (`bind` is limited by `resourceNames`).
- **Inside each `ewapp-*` namespace:** namespaced admin over the objects an App needs. This comes
  from the RoleBinding the plugin writes there.
- **Admission:** a `ValidatingAdmissionPolicy` refuses every write by the ServiceAccount outside
  `ewapp-*`. It also refuses a RoleBinding that grants anything else, or to anyone else. Reads of
  other namespaces are impossible because no permission covers them.

It needs Kubernetes ≥ 1.30 (`ValidatingAdmissionPolicy` GA).

```yaml
# ever-works-apps — RBAC for the managed App target (APW-10 lite).
# Apply once per cluster (k8s-gitops). Then mint the kubeconfig (below) and set
# EVER_WORKS_APPS_MANAGED_KUBECONFIG on the App runtime worker only.
---
apiVersion: v1
kind: Namespace
metadata:
    name: ever-works-apps-system
    labels:
        pod-security.kubernetes.io/enforce: restricted
---
apiVersion: v1
kind: ServiceAccount
metadata:
    name: ever-works-apps-controller
    namespace: ever-works-apps-system
---
# A long-lived token for the ServiceAccount (the kubeconfig's user token).
apiVersion: v1
kind: Secret
metadata:
    name: ever-works-apps-controller-token
    namespace: ever-works-apps-system
    annotations:
        kubernetes.io/service-account.name: ever-works-apps-controller
type: kubernetes.io/service-account-token
---
# Cluster-wide: namespaces, and RoleBindings that grant ONLY the namespace-admin role below.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
    name: ever-works-apps-controller
rules:
    - apiGroups: ['']
      resources: ['namespaces']
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
    - apiGroups: ['rbac.authorization.k8s.io']
      resources: ['rolebindings']
      verbs: ['get', 'create', 'update', 'patch']
    - apiGroups: ['rbac.authorization.k8s.io']
      resources: ['clusterroles']
      verbs: ['bind']
      resourceNames: ['ever-works-apps-namespace-admin']
    - apiGroups: ['networking.k8s.io']
      resources: ['ingressclasses']
      verbs: ['get', 'list']
    - apiGroups: ['node.k8s.io']
      resources: ['runtimeclasses']
      verbs: ['get', 'list']
    - apiGroups: ['storage.k8s.io']
      resources: ['storageclasses']
      verbs: ['get', 'list']
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
    name: ever-works-apps-controller
roleRef:
    apiGroup: rbac.authorization.k8s.io
    kind: ClusterRole
    name: ever-works-apps-controller
subjects:
    - kind: ServiceAccount
      name: ever-works-apps-controller
      namespace: ever-works-apps-system
---
# Namespaced admin over what an App Work renders. NEVER bound cluster-wide: the plugin binds it
# inside each ewapp-* namespace with a RoleBinding named ever-works-apps-controller.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
    name: ever-works-apps-namespace-admin
rules:
    - apiGroups: ['']
      resources:
          - configmaps
          - secrets
          - services
          - serviceaccounts
          - persistentvolumeclaims
          - pods
          - resourcequotas
          - limitranges
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection']
    - apiGroups: ['']
      resources: ['pods/log', 'events', 'endpoints']
      verbs: ['get', 'list', 'watch']
    - apiGroups: ['apps']
      resources: ['deployments', 'statefulsets', 'replicasets']
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection']
    - apiGroups: ['batch']
      resources: ['jobs', 'cronjobs']
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection']
    - apiGroups: ['networking.k8s.io']
      resources: ['ingresses', 'networkpolicies']
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection']
    - apiGroups: ['policy']
      resources: ['poddisruptionbudgets']
      verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']
    - apiGroups: ['rbac.authorization.k8s.io']
      resources: ['rolebindings']
      verbs: ['get', 'list', 'watch']
---
# The sandbox every managed pod runs in. `runc` is the containerd default; switch the handler to
# `runsc` (gVisor) or `kata` when the nodes have it.
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
    name: ever-works-apps
handler: runc
---
# Writes by the controller are confined to ewapp-* — namespaces and everything in them — and the
# only RoleBinding it may write grants ever-works-apps-namespace-admin to itself.
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
    name: ever-works-apps-controller-scope
spec:
    failurePolicy: Fail
    matchConstraints:
        resourceRules:
            - apiGroups: ['*']
              apiVersions: ['*']
              operations: ['CREATE', 'UPDATE', 'DELETE', 'CONNECT']
              resources: ['*']
              scope: '*'
    matchConditions:
        - name: is-the-ever-works-apps-controller
          expression: >-
              request.userInfo.username ==
              'system:serviceaccount:ever-works-apps-system:ever-works-apps-controller'
    validations:
        - expression: >-
              request.namespace.startsWith('ewapp-') ||
              (request.resource.resource == 'namespaces' && request.name.startsWith('ewapp-'))
          message: 'The Ever Works Apps controller may only write ewapp-* namespaces and their contents.'
        - expression: >-
              request.resource.resource != 'rolebindings' || request.operation == 'DELETE' ||
              (object.roleRef.kind == 'ClusterRole' &&
               object.roleRef.name == 'ever-works-apps-namespace-admin' &&
               size(object.subjects) == 1 &&
               object.subjects[0].kind == 'ServiceAccount' &&
               object.subjects[0].name == 'ever-works-apps-controller' &&
               object.subjects[0].namespace == 'ever-works-apps-system')
          message: 'The controller may only bind ever-works-apps-namespace-admin to itself.'
        # Pod Security is not the controller's to relax: an ewapp-* Namespace must enforce `restricted`.
        - expression: >-
              request.resource.resource != 'namespaces' || request.operation == 'DELETE' ||
              (has(object.metadata.labels) &&
               'pod-security.kubernetes.io/enforce' in object.metadata.labels &&
               object.metadata.labels['pod-security.kubernetes.io/enforce'] == 'restricted')
          message: "ewapp-* namespaces must enforce Pod Security 'restricted'."
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
    name: ever-works-apps-controller-scope
spec:
    policyName: ever-works-apps-controller-scope
    validationActions: ['Deny']
```

### Minting the kubeconfig

```bash
SERVER=https://<api-vip>:6443          # the cluster API VIP, never a single node
CA=$(kubectl get cm kube-root-ca.crt -n ever-works-apps-system -o jsonpath='{.data.ca\.crt}' | base64 -w0)
TOKEN=$(kubectl get secret ever-works-apps-controller-token -n ever-works-apps-system -o jsonpath='{.data.token}' | base64 -d)
cat > ewapps.kubeconfig <<EOF
apiVersion: v1
kind: Config
current-context: ever-works-apps
clusters:
  - name: ever-works-apps
    cluster: { server: ${SERVER}, certificate-authority-data: ${CA} }
contexts:
  - name: ever-works-apps
    context: { cluster: ever-works-apps, user: ever-works-apps-controller }
users:
  - name: ever-works-apps-controller
    user: { token: ${TOKEN} }
EOF
base64 -w0 ewapps.kubeconfig   # → EVER_WORKS_APPS_MANAGED_KUBECONFIG (worker secret only)
```

## Limits of the lite version

- **Dependencies are not provisioned yet.** Managed apps that declare `postgres`, `redis` or
  `objectStorage` are not supported: APW-07's provider dispatch is not wired to the managed
  credential. Apps with no managed dependencies, or that use external services through prompted
  environment values, work.
- **One cluster.** There is no zone selection or in-zone controller; that is the full APW-10.
- **Shared node pool.** There are no per-tenant nodes. Isolation comes from the namespace, the
  NetworkPolicies, Pod Security `restricted`, the quota and the RuntimeClass. Switch the RuntimeClass
  to gVisor or Kata for untrusted code.
- **Removal is destructive.** It deletes the namespace, data included.
