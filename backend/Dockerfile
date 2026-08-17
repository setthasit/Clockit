# Build natively and let Go cross-compile: CGO is off, so emulating the target
# arch through QEMU would only make an identical binary take minutes longer.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /api ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
# Numeric, not the `nonroot` name: with runAsNonRoot the kubelet must verify the
# user is not root before starting, and it cannot resolve a name from the image.
USER 65532:65532
COPY --from=build /api /api
ENTRYPOINT ["/api"]
