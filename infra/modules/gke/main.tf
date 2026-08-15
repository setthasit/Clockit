variable "project_id" { type = string }
variable "region" { type = string }
variable "name" {
  type    = string
  default = "clockit"
}
variable "network" { type = string }
variable "subnetwork" { type = string }
variable "pods_range_name" { type = string }
variable "services_range_name" { type = string }
variable "master_ipv4_cidr_block" {
  type    = string
  default = "172.16.0.0/28"
}
variable "authorized_networks" {
  description = "CIDRs allowed to reach the public control-plane endpoint (CI egress + admin IPs)."
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
}
variable "deletion_protection" {
  type    = bool
  default = true
}

resource "google_container_cluster" "this" {
  project  = var.project_id
  name     = var.name
  location = var.region

  enable_autopilot    = true
  deletion_protection = var.deletion_protection
  network             = var.network
  subnetwork          = var.subnetwork

  ip_allocation_policy {
    cluster_secondary_range_name  = var.pods_range_name
    services_secondary_range_name = var.services_range_name
  }

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = var.master_ipv4_cidr_block
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.authorized_networks
      content {
        cidr_block   = cidr_blocks.value.cidr_block
        display_name = cidr_blocks.value.display_name
      }
    }
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = "REGULAR"
  }
}

output "name" { value = google_container_cluster.this.name }
output "endpoint" { value = google_container_cluster.this.endpoint }
output "ca_certificate" {
  value     = google_container_cluster.this.master_auth[0].cluster_ca_certificate
  sensitive = true
}
output "location" { value = google_container_cluster.this.location }
