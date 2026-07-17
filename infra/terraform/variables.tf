variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Used to name/tag every resource this config creates"
  type        = string
  default     = "distributed-object-store"
}

variable "instance_type" {
  description = "EC2 instance type for the single-node k3s host. t3.small comfortably runs the 3-node storage StatefulSet, the coordinator, and its GC sidecar at portfolio/demo traffic levels."
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size in GB. Chunk data and the metadata SQLite file both live on this disk via k3s's local-path provisioner in this reference deployment."
  type        = number
  default     = 30
}

variable "key_name" {
  description = "Name of an existing EC2 key pair, for SSH access"
  type        = string
}

variable "ssh_allowed_cidr" {
  description = "CIDR allowed to reach SSH (22) and the k3s API (6443). Set this to your own IP in /32 form -- do not leave it as 0.0.0.0/0."
  type        = string
}

variable "k3s_version" {
  description = "k3s release channel/version to install"
  type        = string
  default     = "v1.30.5+k3s1"
}
