package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"strings"
)

func GenerateToken() ([]byte, error) {
	token := make([]byte, 32)
	_, err := rand.Read(token)
	return token, err
}

func EncodeToken(token []byte) string {
	return hex.EncodeToString(token)
}

func DecodeToken(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	decoded, err := hex.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(decoded) != 32 {
		return nil, errors.New("invalid token length")
	}
	return decoded, nil
}

func ConstantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

func LoadOrCreateToken(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		token, err := DecodeToken(strings.TrimSpace(string(data)))
		if err != nil {
			return nil, err
		}
		return token, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	token, err := GenerateToken()
	if err != nil {
		return nil, err
	}
	hexToken := EncodeToken(token)
	err = os.WriteFile(path, []byte(hexToken), 0600)
	return token, err
}

func RequireBearerToken(expected []byte, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if len(authHeader) < 7 || authHeader[:7] != "Bearer " {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		token, err := DecodeToken(authHeader[7:])
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !ConstantTimeEqual(expected, token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
