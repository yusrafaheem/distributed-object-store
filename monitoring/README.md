# Monitoring

One-time setup, using the standard Prometheus Operator distribution rather
than hand-rolled Prometheus/Grafana manifests:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace
```

Then apply this directory:

```bash
kubectl apply -f monitoring/servicemonitor.yaml
kubectl apply -f monitoring/grafana-dashboard-configmap.yaml
```

The `ServiceMonitor` tells the Operator's Prometheus to scrape the
coordinator's existing `/metrics` endpoint (no app-code changes -- it
already exposes `prom-client` metrics). The dashboard ConfigMap is picked up
automatically by the Grafana sidecar that ships with kube-prometheus-stack
(any ConfigMap labeled `grafana_dashboard: "1"` gets loaded), so there's no
manual "import dashboard" step.

Reach Grafana with:

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
```

Default login is `admin` / whatever `grafana.adminPassword` you set (or the
Helm-generated secret in `kube-prometheus-stack-grafana` if you didn't set
one) -- change it before exposing Grafana publicly.
