# Собственный Dockerfile для sebdeveloper6952/blossom-server (upstream Dockerfile
# ссылается на приватный registry dhi.io, недоступный без платной подписки Docker —
# см. CONTRACTS.md, "Этап 63, И2"). Headless-сборка (без admin UI — не нужен для
# self-hosted инстанса, тот же принцип, что upstream's runtime-headless target).
# Контекст сборки — клон github.com/sebdeveloper6952/blossom-server (bootstrap-
# скрипт, И4, клонирует его рядом с этим Dockerfile).
FROM golang:1.26-alpine AS builder
WORKDIR /go/src/app
RUN apk add --no-cache gcc musl-dev
COPY . .
RUN mkdir -p ./bin && CGO_ENABLED=1 go build \
    -ldflags "-linkmode external -extldflags '-static'" \
    -o ./bin/app ./cmd/api/main.go

FROM alpine:3.20
RUN adduser -D -h /app -s /bin/sh blossom
COPY --from=builder --chown=blossom:blossom /go/src/app/bin/app /app/app
COPY --from=builder --chown=blossom:blossom /go/src/app/db /app/db
USER blossom
WORKDIR /app
EXPOSE 8000/tcp
ENTRYPOINT ["/app/app"]
