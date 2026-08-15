terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
  }
  backend "gcs" {
    bucket = "clockit-tofu-state"
    prefix = "stacks/20-cluster"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
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
variable "authorized_networks" {
  description = "CIDRs allowed to reach the control-plane endpoint: GitHub Actions egress is dynamic, so 0.0.0.0/0 is the pragmatic default — the endpoint still requires IAM auth."
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  default = [{
    cidr_block   = "0.0.0.0/0"
    display_name = "ci + admins"
  }]
}

data "terraform_remote_state" "foundation" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "stacks/10-foundation"
  }
}

module "gke" {
  source              = "../../modules/gke"
  project_id          = var.project_id
  region              = var.region
  network             = data.terraform_remote_state.foundation.outputs.network_id
  subnetwork          = data.terraform_remote_state.foundation.outputs.subnet_id
  pods_range_name     = data.terraform_remote_state.foundation.outputs.pods_range_name
  services_range_name = data.terraform_remote_state.foundation.outputs.services_range_name
  authorized_networks = var.authorized_networks
}

output "cluster_name" { value = module.gke.name }
output "cluster_endpoint" { value = module.gke.endpoint }
output "cluster_location" { value = module.gke.location }
output "cluster_ca_certificate" {
  value     = module.gke.ca_certificate
  sensitive = true
}
