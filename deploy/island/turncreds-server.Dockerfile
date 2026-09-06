# agent/cmd/turncreds-server — из ЭТОГО репозитория (не upstream-клон, как
# relay/blossom). Контекст сборки — agent/ (docker-compose.yml: build.context
# ../../agent относительно этого файла), go.mod там же.
FROM golang:1.26-alpine AS builder
WORKDIR /go/src/app
COPY . .
RUN CGO_ENABLED=0 go build -o /go/bin/turncreds-server ./cmd/turncreds-server

FROM alpine:3.20
RUN adduser -D -h /app -s /bin/sh turncreds
COPY --from=builder --chown=turncreds:turncreds /go/bin/turncreds-server /app/turncreds-server
USER turncreds
WORKDIR /app
EXPOSE 8090/tcp
ENTRYPOINT ["/app/turncreds-server"]
