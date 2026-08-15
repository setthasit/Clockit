variable "project_id" { type = string }
variable "env" { type = string }
variable "kms_key_id" {
  description = "Full KMS crypto key id for THIS env only."
  type        = string
}
variable "mongo_uri" {
  type      = string
  sensitive = true
}
variable "mongo_db" { type = string }
variable "auth0_domain" { type = string }
variable "auth0_audience" { type = string }
variable "otel_endpoint" {
  type    = string
  default = "http://otel:4318"
}

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name = var.env
  }
}

# Workload Identity: KSA api/<env> impersonates GSA api-<env>, which is the only
# identity granted decrypt on kek-<env>.
resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "api-${var.env}"
  display_name = "ClockIt API (${var.env})"
}

resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.env}/api]"
}

resource "google_kms_crypto_key_iam_member" "api" {
  crypto_key_id = var.kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.api.email}"
}

resource "kubernetes_service_account_v1" "api" {
  metadata {
    name      = "api"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
    annotations = {
      "iam.gke.io/gcp-service-account" = google_service_account.api.email
    }
  }
}

resource "kubernetes_secret_v1" "api_env" {
  metadata {
    name      = "api-env"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }

  data = {
    MONGO_URI      = var.mongo_uri
    MONGO_DB       = var.mongo_db
    AUTH0_DOMAIN   = var.auth0_domain
    AUTH0_AUDIENCE = var.auth0_audience
    KEK_MODE       = "kms"
    KMS_KEY_NAME   = var.kms_key_id
    VALKEY_ADDR    = "valkey:6379"
  }
}

# Cache only: rate-limit counters and short-lived reads. Losing it costs nothing,
# so no PVC and no replication.
resource "kubernetes_deployment_v1" "valkey" {
  metadata {
    name      = "valkey"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
    labels    = { app = "valkey" }
  }

  spec {
    replicas = 1
    selector {
      match_labels = { app = "valkey" }
    }
    template {
      metadata {
        labels = { app = "valkey" }
      }
      spec {
        container {
          name  = "valkey"
          image = "valkey/valkey:8-alpine"
          port {
            container_port = 6379
          }
          resources {
            requests = {
              cpu    = "100m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "250m"
              memory = "256Mi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "valkey" {
  metadata {
    name      = "valkey"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  spec {
    selector = { app = "valkey" }
    port {
      port        = 6379
      target_port = 6379
    }
  }
}

output "namespace" { value = kubernetes_namespace_v1.this.metadata[0].name }
output "gsa_email" { value = google_service_account.api.email }
