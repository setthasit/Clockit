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
    prefix = "stacks/10-foundation"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # google_apikeys_key refuses to run on user ADC unless the request carries an
  # explicit quota project (X-Goog-User-Project).
  user_project_override = true
  billing_project       = var.project_id
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "cloudflare_zone_id" {
  description = "Zone id of setthasit.dev, read off the Cloudflare dashboard. Not a secret; the API token is."
  type        = string
}
variable "maps_referrers" {
  type    = list(string)
  default = ["https://clockit.setthasit.dev/*"]
}

module "network" {
  source     = "../../modules/network"
  project_id = var.project_id
  region     = var.region
}

module "kms" {
  source     = "../../modules/kms"
  project_id = var.project_id
  location   = var.region
}

resource "google_artifact_registry_repository" "docker" {
  project       = var.project_id
  location      = var.region
  repository_id = "clockit"
  format        = "DOCKER"
  description   = "api + beta web images, immutable git-sha tags"
}

# Browser key for the Maps JS anchor picker. To adopt the hand-made console key
# instead of creating a second one, see README "Adopting the existing Maps key".
resource "google_apikeys_key" "maps" {
  project      = var.project_id
  name         = "clockit-maps"
  display_name = "ClockIt Maps JS"

  restrictions {
    browser_key_restrictions {
      allowed_referrers = var.maps_referrers
    }
    api_targets {
      service = "maps-backend.googleapis.com"
    }
  }
}

output "network_name" { value = module.network.network_name }
output "network_id" { value = module.network.network_id }
output "subnet_id" { value = module.network.subnet_id }
output "subnet_name" { value = module.network.subnet_name }
output "pods_range_name" { value = module.network.pods_range_name }
output "services_range_name" { value = module.network.services_range_name }
output "kms_key_ids" { value = module.kms.key_ids }
output "registry" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}" }
output "cloudflare_zone_id" { value = var.cloudflare_zone_id }
output "maps_api_key" {
  value     = google_apikeys_key.maps.key_string
  sensitive = true
}
