terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.23"
    }
  }
  backend "gcs" {
    bucket = "clockit-tofu-state"
    prefix = "stacks/50-edge"
  }
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
variable "web_host" {
  type    = string
  default = "clockit.setthasit.dev"
}
variable "api_host" {
  type    = string
  default = "api.clockit.setthasit.dev"
}
variable "web_bucket_name" {
  type    = string
  default = "clockit-web-prod"
}
variable "api_neg_zones" {
  description = <<-EOT
    Zones where GKE actually created the prod standalone NEG — discovered, not chosen:
      gcloud compute network-endpoint-groups list --filter="name=clockit-api-prod"
    Autopilot only provisions nodes where it needs them, so this is a subset of the
    region's zones. If it later scales into a new zone, GKE adds a NEG there that this
    backend service does not reference and those pods receive no ALB traffic — re-run
    this stack with the zone added.
  EOT
  type        = list(string)
  default     = ["us-central1-b", "us-central1-c"]
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_secret_manager_secret_version" "cloudflare_token" {
  project = var.project_id
  secret  = "cloudflare-api-token"
}

provider "cloudflare" {
  api_token = data.google_secret_manager_secret_version.cloudflare_token.secret_data
}

data "terraform_remote_state" "foundation" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "stacks/10-foundation"
  }
}

module "edge" {
  source             = "../../modules/edge"
  project_id         = var.project_id
  region             = var.region
  web_host           = var.web_host
  api_host           = var.api_host
  web_bucket_name    = var.web_bucket_name
  api_neg_zones      = var.api_neg_zones
  network            = data.terraform_remote_state.foundation.outputs.network_id
  cloudflare_zone_id = data.terraform_remote_state.foundation.outputs.cloudflare_zone_id
}

output "lb_ip" { value = module.edge.lb_ip }
output "web_bucket" { value = module.edge.web_bucket }
output "url_map_name" { value = module.edge.url_map_name }
