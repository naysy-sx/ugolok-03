// ntfy.go — публикация в ntfy (П1.2 «Слушатель ... публикует в топик push
// типа m или c»). А3: тело push — только тип, ничего больше.
package pushbridge

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type NtfyPublisher struct {
	baseURL    string // напр. http://127.0.0.1:2586 (внутренний адрес контейнера ntfy)
	token      string // токен моста для публикации (см. deploy/island/README.md, раздел ntfy)
	httpClient *http.Client
}

func NewNtfyPublisher(baseURL, token string) *NtfyPublisher {
	return &NtfyPublisher{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// Publish отправляет ровно тип push как тело сообщения ntfy — ИП1: "Push-сообщение
// не содержит ничего, кроме типа (m/c)". Заголовок Title намеренно не задаётся —
// это тоже содержимое, которое мог бы прочитать сервер push-провайдера будь он
// сторонним (у нас свой ntfy, но принцип соблюдаем одинаково для обоих случаев).
func (p *NtfyPublisher) Publish(ctx context.Context, topic string, t PushType) error {
	url := fmt.Sprintf("%s/%s", p.baseURL, topic)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(t)))
	if err != nil {
		return fmt.Errorf("pushbridge: ntfy запрос: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	// Priority=high — доставка без задержки на стороне ntfy (по умолчанию "default"
	// у ntfy уже не откладывает, но high явно на случай будущих изменений дефолта).
	req.Header.Set("X-Priority", "high")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("pushbridge: ntfy недоступен: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("pushbridge: ntfy ответил %d", resp.StatusCode)
	}
	return nil
}
