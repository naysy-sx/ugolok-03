package httpapi

import (
	"encoding/json"
	"net/http"

	"ugolok.tech/agent/internal/auth"
	"ugolok.tech/agent/internal/orchestrator"
	"ugolok.tech/agent/internal/turncreds"
)

type Status struct {
	Version       string                       `json:"version"`
	UptimeSeconds int64                        `json:"uptimeSeconds"`
	Services      []orchestrator.ServiceStatus `json:"services"`
}

// turnCredsFn — nil, если у этого агента нет TURN (запущен без --compose-dir,
// coturn не поднят) — /turn-credentials тогда честно отвечает 501, не 404
// (маршрут СУЩЕСТВУЕТ, просто не сконфигурирован для этого инстанса).
func NewServer(token []byte, statusFn func() Status, turnCredsFn func() (turncreds.Credentials, error)) *http.ServeMux {
	mux := http.NewServeMux()

	statusHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		status := statusFn()
		jsonData, err := json.Marshal(status)
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(jsonData)
	})

	turnCredsHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if turnCredsFn == nil {
			http.Error(w, "TURN не сконфигурирован для этого агента", http.StatusNotImplemented)
			return
		}
		creds, err := turnCredsFn()
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		jsonData, err := json.Marshal(creds)
		if err != nil {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(jsonData)
	})

	mux.Handle("/status", auth.RequireBearerToken(token, statusHandler))
	mux.Handle("/turn-credentials", auth.RequireBearerToken(token, turnCredsHandler))

	return mux
}
