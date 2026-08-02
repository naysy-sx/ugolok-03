package turncreds

import (
    "crypto/hmac"
    "crypto/sha1"
    "encoding/base64"
    "strconv"
    "time"
)

type Credentials struct {
    Username string   `json:"username"`
    Password string   `json:"password"`
    TTL      int64    `json:"ttl"`
    URIs     []string `json:"uris"`
}

func Mint(secret []byte, ttl time.Duration, now time.Time, uris []string) Credentials {
    expiry := now.Add(ttl)
    username := strconv.FormatInt(expiry.Unix(), 10)
    mac := hmac.New(sha1.New, secret)
    mac.Write([]byte(username))
    password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
    return Credentials{Username: username, Password: password, TTL: int64(ttl.Seconds()), URIs: uris}
}
