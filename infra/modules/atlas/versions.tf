terraform {
  required_providers {
    mongodbatlas = {
      source  = "mongodb/mongodbatlas"
      version = "~> 2.16"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}
