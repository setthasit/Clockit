terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.2"
    }
  }
}
