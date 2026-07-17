#!/bin/bash
set -euo pipefail

# Installs a single-node k3s cluster (server + agent on the same box) on
# first boot. k3s is a certified, CNCF-conformant Kubernetes distribution --
# this is real Kubernetes underneath, just packaged to run on one small
# instance instead of requiring a separately-billed managed control plane.
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="${k3s_version}" sh -s - \
  --write-kubeconfig-mode 644 \
  --disable traefik=false

# Wait for the node to report Ready before anything downstream (Terraform
# outputs, the deploy workflow) assumes the API server is reachable.
until /usr/local/bin/k3s kubectl get nodes | grep -q ' Ready'; do
  sleep 5
done

mkdir -p /home/ubuntu/.kube
cp /etc/rancher/k3s/k3s.yaml /home/ubuntu/.kube/config
chown -R ubuntu:ubuntu /home/ubuntu/.kube
