variable "project_id" { type = string }
variable "location" { type = string }
variable "keyring_name" {
  type    = string
  default = "clockit"
}
variable "key_names" {
  type    = set(string)
  default = ["kek-beta", "kek-prod"]
}

resource "google_kms_key_ring" "this" {
  project  = var.project_id
  name     = var.keyring_name
  location = var.location
}

# One KEK per environment: a beta workload must never be able to unwrap a prod DEK.
# IAM lives in 40-platform, where the per-env KSA identities exist.
resource "google_kms_crypto_key" "kek" {
  for_each        = var.key_names
  name            = each.value
  key_ring        = google_kms_key_ring.this.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s" # 90d

  lifecycle {
    prevent_destroy = true
  }
}

output "keyring_id" { value = google_kms_key_ring.this.id }
output "key_ids" { value = { for k, v in google_kms_crypto_key.kek : k => v.id } }
