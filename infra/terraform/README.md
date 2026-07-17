# Infrastructure

Provisions one small EC2 instance running a single-node [k3s](https://k3s.io)
cluster -- a real, CNCF-conformant Kubernetes distribution, sized for
portfolio/demo traffic rather than a separately-billed managed control plane
(EKS bills the control plane alone at roughly $0.10/hr on top of node cost;
this setup only pays for the one instance, ~$15/mo for a `t3.small`).

## Prerequisites

- An AWS account with billing enabled and the AWS CLI configured
  (`aws configure`)
- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- An existing EC2 key pair in the target region (`aws ec2 create-key-pair
  --key-name objectstore-key --query 'KeyMaterial' --output text >
  objectstore-key.pem && chmod 400 objectstore-key.pem`)
- Your own public IP, for `ssh_allowed_cidr` (find it with `curl -s
  ifconfig.me`)

## Usage

```bash
cd infra/terraform
terraform init
terraform apply \
  -var="key_name=objectstore-key" \
  -var="ssh_allowed_cidr=YOUR_IP/32"
```

This creates the security group, the instance, and an Elastic IP, and
bootstraps k3s via `user_data.sh` on first boot (takes 1-2 minutes after the
instance reaches `running`).

Point a DNS A record (`objectstore.yusrafaheem.com`) at the `public_ip`
output, then pull a kubeconfig to manage the cluster from your own machine:

```bash
terraform output -raw fetch_kubeconfig_command | bash
export KUBECONFIG=$PWD/kubeconfig.yaml
kubectl get nodes
```

From there, apply the manifests in `../../k8s` (see the top-level
`DEPLOYMENT.md`).

## Cost

Roughly $15-20/mo total: one `t3.small` on-demand instance, a 30GB gp3 EBS
volume, and an Elastic IP (free while attached to a running instance). No
managed control plane, no NAT gateway, no load balancer -- Traefik (bundled
with k3s) terminates ingress directly on the host.

## Teardown

```bash
terraform destroy -var="key_name=objectstore-key" -var="ssh_allowed_cidr=YOUR_IP/32"
```
