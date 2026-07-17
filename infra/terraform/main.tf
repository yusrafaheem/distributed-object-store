terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

resource "aws_security_group" "k3s_host" {
  name        = "${var.project_name}-k3s-sg"
  description = "SSH, k3s API, and HTTP/HTTPS ingress for the single-node k3s host"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_allowed_cidr]
  }

  ingress {
    description = "HTTP (Traefik ingress)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS (Traefik ingress)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "k3s API server, for kubectl from your own machine"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = [var.ssh_allowed_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Project = var.project_name }
}

resource "aws_instance" "k3s_host" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.k3s_host.id]
  key_name               = var.key_name

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
  }

  # Bootstraps a single-node k3s cluster on first boot. k3s is a certified,
  # conformant Kubernetes distribution, so this is real Kubernetes -- it's
  # just packaged to run on one small instance instead of requiring a
  # separately-billed managed control plane (EKS's control plane alone is
  # ~$0.10/hr on top of node cost).
  user_data = templatefile("${path.module}/user_data.sh", {
    k3s_version = var.k3s_version
  })

  tags = {
    Name    = "${var.project_name}-k3s-host"
    Project = var.project_name
  }
}

resource "aws_eip" "k3s_host" {
  instance = aws_instance.k3s_host.id
  domain   = "vpc"
  tags     = { Project = var.project_name }
}
