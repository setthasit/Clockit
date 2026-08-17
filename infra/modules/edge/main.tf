variable "project_id" { type = string }
variable "region" { type = string }
variable "name" {
  type    = string
  default = "clockit"
}
variable "web_host" { type = string }
variable "api_host" { type = string }
variable "web_bucket_name" { type = string }
variable "cloudflare_zone_id" { type = string }
variable "network" {
  description = "VPC self link, for the health-check firewall rule."
  type        = string
}
variable "api_container_port" {
  description = "Port the NEG endpoints listen on (the Service's targetPort)."
  type        = number
  default     = 8080
}
variable "api_neg_name" {
  description = "Standalone NEG name from the prod Service annotation."
  type        = string
  default     = "clockit-api-prod"
}
variable "api_neg_zones" {
  description = <<-EOT
    Zones where GKE actually created the standalone NEG. Discovered after the prod
    overlay is applied: `gcloud compute network-endpoint-groups list`. Apply this
    stack only once those NEGs exist.
  EOT
  type        = list(string)
  default     = ["us-central1-a", "us-central1-b", "us-central1-c"]
}

# --- Web origin: bucket + CDN ------------------------------------------------

resource "google_storage_bucket" "web" {
  project                     = var.project_id
  name                        = var.web_bucket_name
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  force_destroy               = false

  # Without this the bucket answers "/" with an XML object listing under a 200,
  # so the app never loads at the bare domain and the error policy never fires
  # (it only rewrites 404s). main_page_suffix maps "/" to the SPA entrypoint.
  website {
    main_page_suffix = "index.html"
  }
}

resource "google_storage_bucket_iam_member" "public_read" {
  bucket = google_storage_bucket.web.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_compute_backend_bucket" "web" {
  project     = var.project_id
  name        = "${var.name}-web"
  bucket_name = google_storage_bucket.web.name
  enable_cdn  = true

  # Honour the object's own Cache-Control instead of imposing a TTL: the deploy
  # sets immutable/1y on hashed assets and no-cache on index.html, and
  # CACHE_ALL_STATIC's client_ttl would silently cap both at its own value.
  cdn_policy {
    cache_mode        = "USE_ORIGIN_HEADERS"
    negative_caching  = false
    serve_while_stale = 0
  }
}

# --- API origin: standalone NEGs from the prod Service ------------------------

data "google_compute_network_endpoint_group" "api" {
  for_each = toset(var.api_neg_zones)
  project  = var.project_id
  name     = var.api_neg_name
  zone     = each.value
}

# A GKE-managed Ingress would open this itself; a standalone NEG is ours to wire,
# and without it every endpoint reports UNHEALTHY and the ALB serves nothing.
# These two ranges are Google's health-check probers, not general internet.
resource "google_compute_firewall" "health_checks" {
  project       = var.project_id
  name          = "${var.name}-allow-health-checks"
  network       = var.network
  direction     = "INGRESS"
  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"]

  allow {
    protocol = "tcp"
    ports    = [tostring(var.api_container_port)]
  }
}

resource "google_compute_health_check" "api" {
  project = var.project_id
  name    = "${var.name}-api"

  http_health_check {
    request_path       = "/healthz"
    port_specification = "USE_SERVING_PORT"
  }
}

resource "google_compute_backend_service" "api" {
  project               = var.project_id
  name                  = "${var.name}-api"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  timeout_sec           = 30
  health_checks         = [google_compute_health_check.api.id]

  dynamic "backend" {
    for_each = data.google_compute_network_endpoint_group.api
    content {
      group                 = backend.value.id
      balancing_mode        = "RATE"
      max_rate_per_endpoint = 100
    }
  }

  log_config {
    enable      = true
    sample_rate = 0.1
  }
}

# --- Single ALB: one IP, one cert, both hosts --------------------------------

resource "google_compute_global_address" "lb" {
  project = var.project_id
  name    = "${var.name}-lb"
}

resource "google_compute_url_map" "this" {
  project         = var.project_id
  name            = var.name
  default_service = google_compute_backend_bucket.web.id

  host_rule {
    hosts        = [var.web_host]
    path_matcher = "web"
  }

  host_rule {
    hosts        = [var.api_host]
    path_matcher = "api"
  }

  # SPA deep links: a refresh on /table asks the bucket for an object that does
  # not exist; serve index.html under a 200 so the router takes over.
  path_matcher {
    name            = "web"
    default_service = google_compute_backend_bucket.web.id

    default_custom_error_response_policy {
      error_service = google_compute_backend_bucket.web.id
      error_response_rule {
        match_response_codes   = ["404"]
        path                   = "/index.html"
        override_response_code = 200
      }
    }
  }

  path_matcher {
    name            = "api"
    default_service = google_compute_backend_service.api.id
  }
}

# --- Certificates: DNS authorization, so issuance ignores proxy status --------

resource "google_certificate_manager_dns_authorization" "this" {
  for_each = toset([var.web_host, var.api_host])
  project  = var.project_id
  name     = "${var.name}-${replace(each.value, ".", "-")}"
  location = "global"
  domain   = each.value
}

resource "cloudflare_dns_record" "dns_auth" {
  for_each = google_certificate_manager_dns_authorization.this
  zone_id  = var.cloudflare_zone_id
  name     = each.value.dns_resource_record[0].name
  type     = each.value.dns_resource_record[0].type
  content  = each.value.dns_resource_record[0].data
  ttl      = 300
  proxied  = false
}

resource "google_certificate_manager_certificate" "this" {
  project  = var.project_id
  name     = var.name
  location = "global"

  managed {
    domains            = [var.web_host, var.api_host]
    dns_authorizations = [for a in google_certificate_manager_dns_authorization.this : a.id]
  }
}

# A global target proxy cannot reference a Certificate Manager certificate
# directly ("Cloud certificate reference is not supported") — it takes a
# certificate MAP, whose entries bind each hostname to the cert.
resource "google_certificate_manager_certificate_map" "this" {
  project = var.project_id
  name    = var.name
}

resource "google_certificate_manager_certificate_map_entry" "host" {
  for_each     = toset([var.web_host, var.api_host])
  project      = var.project_id
  name         = "${var.name}-${replace(each.value, ".", "-")}"
  map          = google_certificate_manager_certificate_map.this.name
  hostname     = each.value
  certificates = [google_certificate_manager_certificate.this.id]
}

resource "google_compute_target_https_proxy" "this" {
  project         = var.project_id
  name            = var.name
  url_map         = google_compute_url_map.this.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.this.id}"

  depends_on = [google_certificate_manager_certificate_map_entry.host]
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "${var.name}-https"
  target                = google_compute_target_https_proxy.this.id
  ip_address            = google_compute_global_address.lb.id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Grey-cloud DNS means nothing else redirects plain http:// for us.
resource "google_compute_url_map" "redirect" {
  project = var.project_id
  name    = "${var.name}-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "${var.name}-redirect"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "${var.name}-http"
  target                = google_compute_target_http_proxy.redirect.id
  ip_address            = google_compute_global_address.lb.id
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

resource "cloudflare_dns_record" "host" {
  for_each = toset([var.web_host, var.api_host])
  zone_id  = var.cloudflare_zone_id
  name     = each.value
  type     = "A"
  content  = google_compute_global_address.lb.address
  ttl      = 300
  proxied  = false # grey-cloud: TLS terminates at the GCP LB
}

output "lb_ip" { value = google_compute_global_address.lb.address }
output "web_bucket" { value = google_storage_bucket.web.name }
output "url_map_name" { value = google_compute_url_map.this.name }
