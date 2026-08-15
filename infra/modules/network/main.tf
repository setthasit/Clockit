variable "project_id" { type = string }
variable "region" { type = string }
variable "name" {
  type    = string
  default = "clockit"
}
variable "subnet_cidr" {
  type    = string
  default = "10.10.0.0/20"
}
variable "pods_cidr" {
  type    = string
  default = "10.20.0.0/14"
}
variable "services_cidr" {
  type    = string
  default = "10.24.0.0/20"
}

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  project                  = var.project_id
  name                     = "${var.name}-${var.region}"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }
}

# Private nodes have no external IP: Auth0 JWKS, Tailscale control plane and
# Artifact Registry pulls all leave through here.
resource "google_compute_router" "router" {
  project = var.project_id
  name    = "${var.name}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  project                            = var.project_id
  name                               = "${var.name}-nat"
  region                             = var.region
  router                             = google_compute_router.router.name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

output "network_id" { value = google_compute_network.vpc.id }
output "network_name" { value = google_compute_network.vpc.name }
output "subnet_id" { value = google_compute_subnetwork.subnet.id }
output "subnet_name" { value = google_compute_subnetwork.subnet.name }
output "subnet_self_link" { value = google_compute_subnetwork.subnet.self_link }
output "pods_range_name" { value = "pods" }
output "services_range_name" { value = "services" }
