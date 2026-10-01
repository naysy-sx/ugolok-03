# agent/cmd/push-bridge-server — из ЭТОГО репозитория (не upstream-клон, как
# relay/blossom), тот же паттерн, что turncreds-server.Dockerfile. Контекст
# сборки — agent/ (docker-compose.yml: build.context ../../agent относительно
# этого файла), go.mod там же.
FROM golang:1.26-alpine AS builder
WORKDIR /go/src/app
COPY . .
RUN CGO_ENABLED=0 go build -o /go/bin/push-bridge-server ./cmd/push-bridge-server

FROM alpine:3.20
RUN adduser -D -h /app -s /bin/sh pushbridge
COPY --from=builder --chown=pushbridge:pushbridge /go/bin/push-bridge-server /app/push-bridge-server
USER pushbridge
WORKDIR /app
EXPOSE 8091/tcp
ENTRYPOINT ["/app/push-bridge-server"]
