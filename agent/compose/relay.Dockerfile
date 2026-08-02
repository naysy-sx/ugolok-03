# Собственный Dockerfile для strfry (Этап 63, И2/блокер-фикс). Upstream
# strfry-src/Dockerfile (Alpine) не линкуется НИ на Alpine, НИ на Ubuntu —
# найдена и подтверждена живым экспериментом причина: golpe/external/
# uWebSockets/Makefile жёстко фиксирует -std=c++17, а strfry сам собирается
# с -std=c++20 (golpe/rules.mk) — расхождение стандартов C++ меняет
# implicit-noexcept на конструкторах/деструкторах (Itanium C++ ABI,
# P0012), из-за чего мангл имён расходится и линковщик не находит РЕАЛЬНО
# существующие символы ("undefined reference" при факте наличия кода).
# Фикс — пересобрать libuWS.a С ТЕМ ЖЕ -std=c++20 ДО общей сборки: правило
# golpe/rules.mk для libuWS.a не имеет прочих предпосылок и просто
# переиспользует уже существующий файл, не пересобирая его.
# См. CONTRACTS.md, "Этап 63, И2" — "Найденный блокер" (снят).
FROM alpine:3.18.3 AS build
ENV TZ=Europe/London
WORKDIR /build
RUN apk --no-cache add \
    linux-headers git g++ make perl pkgconfig libtool ca-certificates \
    libressl-dev zlib-dev lmdb-dev flatbuffers-dev libsecp256k1-dev \
    zstd-dev libuv-dev
COPY . .
RUN git submodule update --init
RUN make setup-golpe
RUN cd golpe/external/uWebSockets && make -j$(nproc) STD=-std=c++20 libuWS.a
RUN --mount=type=cache,target=/build/.cache \
    make -j4

FROM alpine:3.18.3
RUN apk --no-cache add \
    lmdb flatbuffers libsecp256k1 libb2 zstd libressl \
  && rm -rf /var/cache/apk/*
RUN adduser -D -h /app -s /bin/sh strfry && \
    chown -R strfry:strfry /app
USER strfry
COPY --from=build --chown=strfry:strfry /build/strfry /app/strfry
EXPOSE 7777
WORKDIR /app
ENTRYPOINT ["/app/strfry"]
CMD ["relay"]
