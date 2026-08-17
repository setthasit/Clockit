terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.2"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.2"
    }
  }
  backend "gcs" {
    bucket = "clockit-tofu-state"
    prefix = "stacks/40-platform"
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
# Public values: the API only verifies JWTs, so no client secret is involved.
# Flat strings rather than a map so CI can pass them as plain TF_VAR_* env vars.
variable "auth0_beta_domain" { type = string }
variable "auth0_prod_domain" { type = string }
variable "auth0_audience" {
  type    = string
  default = "https://api.clockit.setthasit.dev"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_client_config" "default" {}

data "terraform_remote_state" "cluster" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "stacks/20-cluster"
  }
}

data "terraform_remote_state" "foundation" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "stacks/10-foundation"
  }
}

data "terraform_remote_state" "data" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "stacks/30-data"
  }
}

locals {
  cluster_host = "https://${data.terraform_remote_state.cluster.outputs.cluster_endpoint}"
  cluster_ca   = base64decode(data.terraform_remote_state.cluster.outputs.cluster_ca_certificate)

  auth0_domains = {
    beta = var.auth0_beta_domain
    prod = var.auth0_prod_domain
  }
}

# The cluster lives in another state, so provider config never depends on a
# resource in this one — that is the whole point of the 20/40 split.
provider "kubernetes" {
  host                   = local.cluster_host
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = local.cluster_ca

  # Autopilot stamps its admission decisions onto every workload it mutates.
  # They are the cluster's to own, not ours; without this every plan proposes
  # deleting them and never converges.
  ignore_annotations = ["^autopilot\\.gke\\.io/.*"]
}

provider "helm" {
  kubernetes = {
    host                   = local.cluster_host
    token                  = data.google_client_config.default.access_token
    cluster_ca_certificate = local.cluster_ca
  }
}

module "platform" {
  source   = "../../modules/platform"
  for_each = data.terraform_remote_state.data.outputs.databases

  project_id     = var.project_id
  env            = each.key
  mongo_db       = each.value
  mongo_uri      = data.terraform_remote_state.data.outputs.mongo_uris[each.key]
  kms_key_id     = data.terraform_remote_state.foundation.outputs.kms_key_ids["kek-${each.key}"]
  auth0_domain   = local.auth0_domains[each.key]
  auth0_audience = var.auth0_audience
}

# --- Tailscale operator: the only way into beta -------------------------------

data "google_secret_manager_secret_version" "ts_client_id" {
  project = var.project_id
  secret  = "tailscale-oauth-client-id"
}

data "google_secret_manager_secret_version" "ts_client_secret" {
  project = var.project_id
  secret  = "tailscale-oauth-client-secret"
}

resource "helm_release" "tailscale_operator" {
  name             = "tailscale-operator"
  repository       = "https://pkgs.tailscale.com/helmcharts"
  chart            = "tailscale-operator"
  namespace        = "tailscale"
  create_namespace = true

  set_sensitive = [
    {
      name  = "oauth.clientId"
      value = data.google_secret_manager_secret_version.ts_client_id.secret_data
    },
    {
      name  = "oauth.clientSecret"
      value = data.google_secret_manager_secret_version.ts_client_secret.secret_data
    },
  ]
}

# --- Observability ------------------------------------------------------------
# Both envs expose a Service named `otel` on 4318, which is what the api
# Deployment's OTEL_EXPORTER_OTLP_ENDPOINT points at.

resource "kubernetes_deployment_v1" "lgtm" {
  metadata {
    name      = "otel"
    namespace = module.platform["beta"].namespace
    labels    = { app = "otel" }
  }

  spec {
    replicas = 1
    selector {
      match_labels = { app = "otel" }
    }
    template {
      metadata {
        labels = { app = "otel" }
      }
      spec {
        security_context {
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        toleration {
          key      = "kubernetes.io/arch"
          operator = "Equal"
          value    = "amd64"
          effect   = "NoSchedule"
        }
        container {
          name  = "lgtm"
          image = "grafana/otel-lgtm"
          port {
            container_port = 4317
          }
          port {
            container_port = 4318
          }
          port {
            container_port = 3000
          }
          resources {
            requests = {
              cpu                 = "250m"
              memory              = "1Gi"
              "ephemeral-storage" = "1Gi"
            }
            limits = {
              cpu                 = "1"
              memory              = "2Gi"
              "ephemeral-storage" = "1Gi"
            }
          }
          security_context {
            capabilities {
              drop = ["NET_RAW"]
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "otel_beta" {
  metadata {
    name      = "otel"
    namespace = module.platform["beta"].namespace
  }
  spec {
    selector = { app = "otel" }
    port {
      name        = "otlp-grpc"
      port        = 4317
      target_port = 4317
    }
    port {
      name        = "otlp-http"
      port        = 4318
      target_port = 4318
    }
  }
}

resource "kubernetes_service_v1" "grafana_beta" {
  metadata {
    name      = "grafana"
    namespace = module.platform["beta"].namespace
  }
  spec {
    selector = { app = "otel" }
    port {
      port        = 3000
      target_port = 3000
    }
  }
}

# Layer-7, not the `tailscale.com/expose` annotation: that provisions an L3 proxy
# needing privileged + CAP_NET_ADMIN, which Autopilot's warden rejects outright.
# Tailscale documents the same limitation for EKS Fargate — Ingress is supported
# on such clusters, ingress Services are not. L7 also gets a TLS cert for free.
resource "kubernetes_ingress_v1" "grafana_beta" {
  metadata {
    name      = "grafana"
    namespace = module.platform["beta"].namespace
  }

  spec {
    ingress_class_name = "tailscale"

    default_backend {
      service {
        name = kubernetes_service_v1.grafana_beta.metadata[0].name
        port {
          number = 3000
        }
      }
    }

    tls {
      hosts = ["clockit-grafana-beta"]
    }
  }
}

# TODO(owner): pick the prod OTLP backend (HyperDX / OpenObserve / Grafana Cloud —
# design §11.7), add its endpoint + auth as a Secret Manager entry, and replace the
# debug exporter below. Nothing in the app changes; this config map is the seam.
resource "kubernetes_config_map_v1" "otel_collector" {
  metadata {
    name      = "otel-collector"
    namespace = module.platform["prod"].namespace
  }

  data = {
    "config.yaml" = yamlencode({
      receivers = {
        otlp = {
          protocols = {
            grpc = { endpoint = "0.0.0.0:4317" }
            http = { endpoint = "0.0.0.0:4318" }
          }
        }
      }
      processors = {
        batch = {}
        memory_limiter = {
          check_interval         = "5s"
          limit_percentage       = 80
          spike_limit_percentage = 20
        }
      }
      exporters = {
        debug = { verbosity = "basic" }
      }
      service = {
        pipelines = {
          traces  = { receivers = ["otlp"], processors = ["memory_limiter", "batch"], exporters = ["debug"] }
          metrics = { receivers = ["otlp"], processors = ["memory_limiter", "batch"], exporters = ["debug"] }
          logs    = { receivers = ["otlp"], processors = ["memory_limiter", "batch"], exporters = ["debug"] }
        }
      }
    })
  }
}

resource "kubernetes_deployment_v1" "otel_collector" {
  metadata {
    name      = "otel"
    namespace = module.platform["prod"].namespace
    labels    = { app = "otel" }
  }

  spec {
    replicas = 1
    selector {
      match_labels = { app = "otel" }
    }
    template {
      metadata {
        labels      = { app = "otel" }
        annotations = { "checksum/config" = sha256(kubernetes_config_map_v1.otel_collector.data["config.yaml"]) }
      }
      spec {
        security_context {
          seccomp_profile {
            type = "RuntimeDefault"
          }
        }
        toleration {
          key      = "kubernetes.io/arch"
          operator = "Equal"
          value    = "amd64"
          effect   = "NoSchedule"
        }
        container {
          name  = "collector"
          image = "otel/opentelemetry-collector-contrib:latest"
          args  = ["--config=/conf/config.yaml"]
          port {
            container_port = 4317
          }
          port {
            container_port = 4318
          }
          volume_mount {
            name       = "config"
            mount_path = "/conf"
          }
          resources {
            requests = {
              cpu                 = "100m"
              memory              = "256Mi"
              "ephemeral-storage" = "1Gi"
            }
            limits = {
              cpu                 = "500m"
              memory              = "512Mi"
              "ephemeral-storage" = "1Gi"
            }
          }
          security_context {
            capabilities {
              drop = ["NET_RAW"]
            }
          }
        }
        volume {
          name = "config"
          config_map {
            name = kubernetes_config_map_v1.otel_collector.metadata[0].name
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "otel_prod" {
  metadata {
    name      = "otel"
    namespace = module.platform["prod"].namespace
  }
  spec {
    selector = { app = "otel" }
    port {
      name        = "otlp-grpc"
      port        = 4317
      target_port = 4317
    }
    port {
      name        = "otlp-http"
      port        = 4318
      target_port = 4318
    }
  }
}

output "namespaces" { value = { for k, m in module.platform : k => m.namespace } }
output "api_service_accounts" { value = { for k, m in module.platform : k => m.gsa_email } }
