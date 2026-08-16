terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
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
variable "github_repo" {
  description = "owner/repo allowed to mint tokens for the CI service account."
  type        = string
}

locals {
  services = [
    "artifactregistry.googleapis.com",
    "certificatemanager.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com", # google_project_iam_member
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com", # google_service_account
    "iamcredentials.googleapis.com",
    "apikeys.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sts.googleapis.com",
  ]

  # Shells only. Values are pasted by a human:
  #   gcloud secrets versions add <name> --data-file=-
  secrets = [
    "atlas-public-key",
    "atlas-private-key",
    "cloudflare-api-token",
    "tailscale-oauth-client-id",
    "tailscale-oauth-client-secret",
    "auth0-beta",
    "auth0-prod",
    "maps-api-key",
  ]

  # Stacks 10-50 apply from CI, so the deployer needs create/delete on everything
  # they manage. Scoped to this project, keyless, no downloadable key exists.
  ci_roles = [
    "roles/artifactregistry.admin",
    "roles/certificatemanager.editor",
    "roles/cloudkms.admin",
    "roles/compute.admin",
    "roles/container.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/storage.admin",
  ]
}

resource "google_project_service" "this" {
  for_each = toset(local.services)
  project  = var.project_id
  service  = each.value

  disable_on_destroy = false
}

resource "google_storage_bucket" "state" {
  project                     = var.project_id
  name                        = var.state_bucket
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

# --- Keyless CI identity ------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_condition = "assertion.repository == '${var.github_repo}'"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "ci" {
  project      = var.project_id
  account_id   = "ci-deployer"
  display_name = "GitHub Actions deployer"
}

resource "google_service_account_iam_member" "ci_wif" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

resource "google_project_iam_member" "ci" {
  for_each = toset(local.ci_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.ci.email}"
}

resource "google_secret_manager_secret" "this" {
  for_each  = toset(local.secrets)
  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "ci" {
  for_each  = google_secret_manager_secret.this
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ci.email}"
}

output "state_bucket" { value = google_storage_bucket.state.name }
output "ci_service_account" { value = google_service_account.ci.email }
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
