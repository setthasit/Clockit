// Not a .tf file yet — this stack creates the bucket it will later live in.
// After the first local apply:  mv backend.tf.migrate backend.tf && tofu init -migrate-state
terraform {
  backend "gcs" {
    bucket = "clockit-tofu-state"
    prefix = "stacks/00-bootstrap"
  }
}
