run:   ## go run with .env loaded
	set -a && . ./.env && set +a && go run ./cmd/api
test:  ## defaults point at the docker compose stack; exported vars win
	MONGO_URI="$${MONGO_URI:-mongodb://localhost:27017}" \
	VALKEY_ADDR="$${VALKEY_ADDR:-localhost:6379}" \
	go test ./...
lint:
	golangci-lint run
seed:
	set -a && . ./.env && set +a && go run ./cmd/seed

.PHONY: run test lint seed
