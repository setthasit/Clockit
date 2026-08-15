terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
    mongodbatlas = {
      source  = "mongodb/mongodbatlas"
      version = "~> 2.16"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
  backend "gcs" {
    bucket = "clockit-tofu-state"
    prefix = "stacks/30-data"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_secret_manager_secret_version" "atlas_public_key" {
  project = var.project_id
  secret  = "atlas-public-key"
}

data "google_secret_manager_secret_version" "atlas_private_key" {
  project = var.project_id
  secret  = "atlas-private-key"
}

provider "mongodbatlas" {
  public_key  = data.google_secret_manager_secret_version.atlas_public_key.secret_data
  private_key = data.google_secret_manager_secret_version.atlas_private_key.secret_data
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "state_bucket" {
  type    = string
  default = "clockit-tofu-state"
}
variable "atlas_org_id" { type = string }

data "terraform_remote_state" "foundation" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "stacks/10-foundation"
  }
}

module "atlas" {
  source         = "../../modules/atlas"
  atlas_org_id   = var.atlas_org_id
  gcp_project_id = var.project_id
  gcp_region     = var.region
  network        = data.terraform_remote_state.foundation.outputs.network_id
  subnetwork     = data.terraform_remote_state.foundation.outputs.subnet_id
}

# Kept in Secret Manager as well as state so an operator can read the URI without
# pulling state, and so a future stack can consume it without a state dependency.
resource "google_secret_manager_secret" "mongo_uri" {
  for_each  = module.atlas.databases
  project   = var.project_id
  secret_id = "mongo-uri-${each.key}"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "mongo_uri" {
  for_each    = module.atlas.databases
  secret      = google_secret_manager_secret.mongo_uri[each.key].id
  secret_data = module.atlas.mongo_uris[each.key]
}

output "mongo_uris" {
  value     = module.atlas.mongo_uris
  sensitive = true
}
output "databases" { value = module.atlas.databases }
output "atlas_project_id" { value = module.atlas.project_id }
output "cluster_name" { value = module.atlas.cluster_name }
