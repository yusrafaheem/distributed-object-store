output "public_ip" {
  description = "Elastic IP of the k3s host -- point objectstore.yusrafaheem.com's A record here"
  value       = aws_eip.k3s_host.public_ip
}

output "ssh_command" {
  value = "ssh -i <path-to-key>.pem ubuntu@${aws_eip.k3s_host.public_ip}"
}

output "fetch_kubeconfig_command" {
  description = "Run locally to pull a kubeconfig you can point kubectl/Helm at from your own machine"
  value       = "ssh -i <path-to-key>.pem ubuntu@${aws_eip.k3s_host.public_ip} 'sudo cat /etc/rancher/k3s/k3s.yaml' | sed 's/127.0.0.1/${aws_eip.k3s_host.public_ip}/' > kubeconfig.yaml"
}
