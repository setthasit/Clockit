terraform {
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
}
