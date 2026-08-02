package httpapi

import (
	"encoding/json"
	"net/http"
	"ugolok.tech/agent/internal/auth"
)

type Status struct {
	Version       string `json:"version"`
	UptimeSeconds int64  `json:"uptimeSeconds"`
}

func NewServer(token []byte, statusFn func() Status) *http.ServeMux {
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
	
	mux.Handle("/status", auth.RequireBearerToken(token, statusHandler))
	
	return mux
}
