run:   ## go run with .env loaded
	set -a && . ./.env && set +a && go run ./cmd/api
test:
	go test ./...
lint:
	golangci-lint run
seed:
	set -a && . ./.env && set +a && go run ./cmd/seed

.PHONY: run test lint seed
