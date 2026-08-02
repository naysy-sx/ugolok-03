package pairing

import (
	"encoding/base64"
	"encoding/json"
)

type Code struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Token       string `json:"token"`
	Fingerprint string `json:"fingerprint"`
}

func Encode(c Code) (string, error) {
	data, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(data)
	return encoded, nil
}

func Decode(s string) (Code, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return Code{}, err
	}
	var c Code
	err = json.Unmarshal(decoded, &c)
	if err != nil {
		return Code{}, err
	}
	return c, nil
}
