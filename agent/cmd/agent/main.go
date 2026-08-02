package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"ugolok.tech/agent/internal/auth"
	"ugolok.tech/agent/internal/httpapi"
	"ugolok.tech/agent/internal/orchestrator"
	"ugolok.tech/agent/internal/pairing"
	"ugolok.tech/agent/internal/render"
	"ugolok.tech/agent/internal/tlscert"
	"ugolok.tech/agent/internal/turncreds"
)

const turnCredentialsTTL = 12 * time.Hour

// Версия агента — заполняется при сборке (-ldflags "-X main.version=..."),
// "dev" — значение по умолчанию для локальной разработки без флага сборки.
var version = "dev"

func main() {
	stateDir := flag.String("state-dir", "state", "директория для token.hex/cert.pem/key.pem")
	port := flag.Int("port", 8443, "TCP-порт HTTPS-сервера агента")
	host := flag.String("host", "", "публичный адрес/домен агента — печатается в пейринг-коде, сам агент его не угадывает")
	composeDir := flag.String("compose-dir", "", "директория с docker-compose.yml/*.tmpl (Этап 63, И2) — пусто = заглушка статуса (совместимость с И1, без docker)")
	relayDomain := flag.String("relay-domain", "", "домен/IP relay (WSS) — подставляется в strfry.conf.tmpl/Caddyfile")
	relayName := flag.String("relay-name", "ugolok-relay", "имя relay в info-блоке strfry.conf")
	blossomDomain := flag.String("blossom-domain", "", "домен/IP Blossom (HTTPS) — подставляется в blossom-config.yml.tmpl/Caddyfile")
	turnRealm := flag.String("turn-realm", "ugolok.local", "TURN realm (coturn.conf.tmpl)")
	turnExternalIP := flag.String("turn-external-ip", "", "публичный IP этого VPS для coturn external-ip (ICE-кандидаты)")
	flag.Parse()

	if *host == "" {
		log.Fatal("--host обязателен (публичный IP/домен этого VPS — агент не умеет угадывать его сам)")
	}

	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		log.Fatalf("не удалось создать %s: %v", *stateDir, err)
	}

	tokenPath := filepath.Join(*stateDir, "token.hex")
	certPath := filepath.Join(*stateDir, "cert.pem")
	keyPath := filepath.Join(*stateDir, "key.pem")

	_, statErr := os.Stat(tokenPath)
	firstRun := statErr != nil && os.IsNotExist(statErr)

	token, err := auth.LoadOrCreateToken(tokenPath)
	if err != nil {
		log.Fatalf("не удалось загрузить/создать токен: %v", err)
	}

	cert, err := tlscert.LoadOrGenerate(certPath, keyPath)
	if err != nil {
		log.Fatalf("не удалось загрузить/создать TLS-сертификат: %v", err)
	}

	if firstRun {
		fingerprint, err := tlscert.Fingerprint(cert)
		if err != nil {
			log.Fatalf("не удалось вычислить отпечаток сертификата: %v", err)
		}
		code, err := pairing.Encode(pairing.Code{
			Host:        *host,
			Port:        *port,
			Token:       auth.EncodeToken(token),
			Fingerprint: fingerprint,
		})
		if err != nil {
			log.Fatalf("не удалось закодировать пейринг-код: %v", err)
		}
		fmt.Println("=== Пейринг-код (вставьте в приложение Уголок при сопряжении, показывается только один раз) ===")
		fmt.Println(code)
		fmt.Println("=================================================================================")
	}

	startTime := time.Now()

	var statusFn func() httpapi.Status
	var turnCredsFn func() (turncreds.Credentials, error)
	if *composeDir == "" {
		// И1-совместимость: без --compose-dir агент не трогает docker вовсе.
		statusFn = func() httpapi.Status {
			return httpapi.Status{Version: version, UptimeSeconds: int64(time.Since(startTime).Seconds())}
		}
	} else {
		if *relayDomain == "" || *blossomDomain == "" || *turnExternalIP == "" {
			log.Fatal("--relay-domain, --blossom-domain и --turn-external-ip обязательны при указанном --compose-dir")
		}

		// docker-compose.yml's ${RELAY_DOMAIN}/${BLOSSOM_DOMAIN} — это переменные
		// ОКРУЖЕНИЯ САМОГО docker compose (native-подстановка Compose), ОТДЕЛЬНЫЙ
		// механизм от Go text/template ({{.RelayDomain}} в *.tmpl, см. render.Config
		// ниже) — RealRunner наследует окружение процесса (exec.Cmd.Env == nil),
		// поэтому достаточно Setenv здесь, без отдельного .env файла.
		os.Setenv("RELAY_DOMAIN", *relayDomain)
		os.Setenv("BLOSSOM_DOMAIN", *blossomDomain)

		turnSecretPath := filepath.Join(*stateDir, "turn-secret.hex")
		turnSecret, err := auth.LoadOrCreateToken(turnSecretPath)
		if err != nil {
			log.Fatalf("не удалось загрузить/создать TURN-секрет: %v", err)
		}

		renderedDir := filepath.Join(*composeDir, "rendered")
		cfg := render.Config{
			RelayDomain:    *relayDomain,
			RelayName:      *relayName,
			BlossomDomain:  *blossomDomain,
			TurnSecret:     auth.EncodeToken(turnSecret),
			TurnRealm:      *turnRealm,
			TurnExternalIP: *turnExternalIP,
		}
		if err := render.RenderAll(*composeDir, renderedDir, cfg); err != nil {
			log.Fatalf("не удалось отрендерить конфиги compose-бандла: %v", err)
		}

		turnCertsDir := filepath.Join(renderedDir, "turn-certs")
		if err := os.MkdirAll(turnCertsDir, 0o700); err != nil {
			log.Fatalf("не удалось создать %s: %v", turnCertsDir, err)
		}
		if _, err := tlscert.LoadOrGenerate(filepath.Join(turnCertsDir, "cert.pem"), filepath.Join(turnCertsDir, "key.pem")); err != nil {
			log.Fatalf("не удалось загрузить/создать TLS-сертификат TURN: %v", err)
		}

		if err := orchestrator.ComposeUp(orchestrator.RealRunner, *composeDir); err != nil {
			log.Fatalf("не удалось поднять docker compose стек (%s): %v", *composeDir, err)
		}
		statusFn = func() httpapi.Status {
			services, err := orchestrator.ComposeStatus(orchestrator.RealRunner, *composeDir)
			if err != nil {
				log.Printf("ошибка получения статуса docker compose: %v", err)
				services = nil
			}
			return httpapi.Status{Version: version, UptimeSeconds: int64(time.Since(startTime).Seconds()), Services: services}
		}

		turnURIs := []string{
			"turn:" + *turnExternalIP + ":3478",
			"turns:" + *turnExternalIP + ":5349",
		}
		turnCredsFn = func() (turncreds.Credentials, error) {
			return turncreds.Mint(turnSecret, turnCredentialsTTL, time.Now(), turnURIs), nil
		}
	}

	mux := httpapi.NewServer(token, statusFn, turnCredsFn)

	server := &http.Server{
		Addr:      net.JoinHostPort("", fmt.Sprintf("%d", *port)),
		Handler:   mux,
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}},
	}

	log.Printf("агент слушает :%d (host=%s)", *port, *host)
	log.Fatal(server.ListenAndServeTLS("", ""))
}
