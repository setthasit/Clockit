variable "atlas_org_id" { type = string }
variable "project_name" {
  type    = string
  default = "clockit"
}
variable "cluster_name" {
  type    = string
  default = "clockit"
}
variable "atlas_region" {
  description = "Atlas region name; must be the GCP region so PSC can attach."
  type        = string
  default     = "US_CENTRAL1"
}
variable "instance_size" {
  type    = string
  default = "M10" # smallest tier that supports private endpoints
}
variable "gcp_project_id" { type = string }
variable "gcp_region" { type = string }
variable "network" { type = string }
variable "subnetwork" { type = string }
variable "databases" {
  description = "env => database name, one scoped user per entry."
  type        = map(string)
  default = {
    beta = "clockit_beta"
    prod = "clockit_prod"
  }
}

resource "mongodbatlas_project" "this" {
  org_id = var.atlas_org_id
  name   = var.project_name
}

resource "mongodbatlas_advanced_cluster" "this" {
  project_id     = mongodbatlas_project.this.id
  name           = var.cluster_name
  cluster_type   = "REPLICASET"
  backup_enabled = true

  replication_specs = [{
    region_configs = [{
      provider_name = "GCP"
      region_name   = var.atlas_region
      priority      = 7
      electable_specs = {
        instance_size = var.instance_size
        node_count    = 3
      }
      auto_scaling = {
        disk_gb_enabled = true
        compute_enabled = false
      }
    }]
  }]
}

# --- Private Service Connect (port-mapped architecture) -----------------------
# Port-mapped needs exactly ONE address + ONE forwarding rule regardless of node
# count; the legacy 50-endpoint layout is deprecated. Shape follows the provider's
# examples/mongodbatlas_privatelink_endpoint/gcp-port-mapped example.

resource "mongodbatlas_privatelink_endpoint" "this" {
  project_id           = mongodbatlas_project.this.id
  provider_name        = "GCP"
  region               = var.atlas_region
  port_mapping_enabled = true
}

resource "google_compute_address" "psc" {
  project      = var.gcp_project_id
  name         = "${var.project_name}-atlas-psc"
  region       = var.gcp_region
  subnetwork   = var.subnetwork
  address_type = "INTERNAL"

  depends_on = [mongodbatlas_privatelink_endpoint.this]
}

resource "google_compute_forwarding_rule" "psc" {
  project               = var.gcp_project_id
  region                = var.gcp_region
  name                  = google_compute_address.psc.name
  target                = mongodbatlas_privatelink_endpoint.this.service_attachment_names[0]
  ip_address            = google_compute_address.psc.id
  network               = var.network
  load_balancing_scheme = ""
}

resource "mongodbatlas_privatelink_endpoint_service" "this" {
  project_id                  = mongodbatlas_privatelink_endpoint.this.project_id
  private_link_id             = mongodbatlas_privatelink_endpoint.this.private_link_id
  provider_name               = "GCP"
  endpoint_service_id         = google_compute_forwarding_rule.psc.name
  private_endpoint_ip_address = google_compute_address.psc.address
  gcp_project_id              = var.gcp_project_id
}

# --- Scoped users ------------------------------------------------------------

resource "random_password" "user" {
  for_each = var.databases
  length   = 32
  special  = false # keeps the SRV URI free of percent-encoding
}

resource "mongodbatlas_database_user" "user" {
  for_each           = var.databases
  project_id         = mongodbatlas_project.this.id
  username           = "api-${each.key}"
  password           = random_password.user[each.key].result
  auth_database_name = "admin"

  roles {
    role_name     = "readWrite"
    database_name = each.value
  }

  scopes {
    name = mongodbatlas_advanced_cluster.this.name
    type = "CLUSTER"
  }
}

# Private SRV string is only published once the endpoint service is linked.
data "mongodbatlas_advanced_cluster" "this" {
  project_id = mongodbatlas_project.this.id
  name       = mongodbatlas_advanced_cluster.this.name

  depends_on = [mongodbatlas_privatelink_endpoint_service.this]
}

locals {
  private_endpoints = try(flatten([for cs in data.mongodbatlas_advanced_cluster.this.connection_strings.private_endpoint : cs]), [])
  private_srv = one([
    for pe in local.private_endpoints : pe.srv_connection_string
    if contains([for e in pe.endpoints : e.endpoint_id], mongodbatlas_privatelink_endpoint_service.this.endpoint_service_id)
  ])
}

output "project_id" { value = mongodbatlas_project.this.id }
output "cluster_name" { value = mongodbatlas_advanced_cluster.this.name }
output "private_srv" {
  value     = local.private_srv
  sensitive = true
}
output "mongo_uris" {
  description = "env => full private SRV URI with credentials."
  value = {
    for env, db in var.databases :
    env => replace(local.private_srv, "mongodb+srv://", "mongodb+srv://${mongodbatlas_database_user.user[env].username}:${random_password.user[env].result}@")
  }
  sensitive = true
}
output "databases" { value = var.databases }
