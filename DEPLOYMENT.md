# Deployment

This documents taking the system in this repo from "runs via `docker
compose up`" to "runs on a real Kubernetes cluster with a live URL,
automatic deploys, and dashboards" -- the layer that turns a local reference
implementation into something that looks and operates like a real service.

## Architecture

```
GitHub push to main
        |
        v
  CI (test) --> build image --> push to ghcr.io
        |
        v
  kubectl set image (rolling update)
        |
        v
+---------------------------------------------------+
|              k3s cluster (1 EC2 host)              |
|                                                     |
|  Ingress (Traefik) -- objectstore.yusrafaheem.com  |
|        |                                           |
|        v                                           |
|  coordinator Deployment (1 replica)                |
|    - coordinator container (src/cluster.js)        |
|    - gc-sweeper container  (src/gc.js, sidecar)     |
|        |            \                              |
|        |             \-- shared PVC (metadata.db)  |
|        v                                           |
|  storage-node StatefulSet (3 replicas)             |
|    storage-node-0/1/2, each with its own PVC       |
|                                                     |
|  ServiceMonitor --> kube-prometheus-stack           |
|  Grafana dashboard ConfigMap (auto-provisioned)     |
+---------------------------------------------------+
```

## Prerequisites

- Steps in `infra/terraform/README.md` completed (EC2 host running, k3s
  installed, kubeconfig pulled down locally)
- `kubectl` pointed at that kubeconfig
- Helm, for the monitoring stack

## One-time cluster setup

```bash
export KUBECONFIG=$PWD/infra/terraform/kubeconfig.yaml

# Application
kubectl apply -k k8s/

# Monitoring (see monitoring/README.md for the full explanation)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace
kubectl apply -f monitoring/servicemonitor.yaml
kubectl apply -f monitoring/grafana-dashboard-configmap.yaml
```

Point `objectstore.yusrafaheem.com`'s DNS A record at the Terraform
`public_ip` output, and Traefik (bundled with k3s) routes it to the
coordinator Service automatically via `k8s/ingress.yaml`.

## Continuous deployment

`.github/workflows/deploy.yml` builds and pushes an image to GHCR on every
push to `main`, then rolls it out with `kubectl set image` -- but the deploy
job needs one repo secret to actually reach the cluster:

```bash
# Base64-encode the kubeconfig pulled from Terraform's output, and add it
# as a repo secret named KUBE_CONFIG (Settings > Secrets and variables > Actions)
base64 -i infra/terraform/kubeconfig.yaml | pbcopy
```

Until that secret exists, the build-and-test job still runs on every push
(so CI stays meaningful on its own), and the deploy job simply fails fast
rather than doing anything destructive.

## Design decision: one coordinator replica, not an HPA

The coordinator's own code comments already flag this seam: `src/cluster.js`
forks one worker per CPU *inside* a pod, and the metadata store (SQLite) is
per-process-group, not shared across pods. Running two coordinator
*replicas* behind the same Service today would silently split which pod
"knows about" which file -- a correctness bug, not a scaling win. Rather
than mask that with an HPA that would make things worse under load, this
deployment runs exactly one coordinator replica and calls the constraint out
directly. Removing it is real follow-up work (swap SQLite for a shared
metadata service), not something to fake at the Kubernetes layer.

The storage tier has no such constraint -- each `storage-node-N` StatefulSet
replica is independent, which is why that tier scales horizontally cleanly
today (`kubectl scale statefulset/storage-node --replicas=5`, then update
`REPLICATION_FACTOR` if you want the ring to actually use the extra nodes).

## Cost

~$15-20/month all-in (see `infra/terraform/README.md`) -- one small EC2
instance, its EBS volume, and an Elastic IP. No managed Kubernetes control
plane, no load balancer, no NAT gateway.
