// store.go — хранилище регистраций push (ТЗ П1.2 «Хранилище регистраций»).
//
// Решение: одна регистрация на pubkey (не на устройство). ТЗ буквально говорит
// "POST — создать, PUT — обновить фильтры, DELETE — удалить" и не упоминает
// несколько устройств на одного владельца ключа отдельным требованием — заводить
// схему под множественные устройства сейчас значило бы проектировать под
// гипотетическое будущее (см. общие правила проекта). Если понадобится —
// расширение таблицы (составной ключ pubkey_hash+device_id) обратно совместимо.
//
// pubkey в открытом виде НЕ хранится (ИП3) — только sha256-хеш (HashPubkey).
// Сопоставление входящих событий с регистрацией делает то же хеширование
// значения тега p на стороне matcher.go — равенство хешей эквивалентно
// равенству исходных ключей, обратимость хеша не нужна.
package pushbridge

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// RegistrationTTL — П1.2: «срок жизни регистрации 30 дней; клиент продлевает
// раз в неделю; истёкшие удаляются».
const RegistrationTTL = 30 * 24 * time.Hour

var ErrNotFound = errors.New("pushbridge: регистрация не найдена")

type Registration struct {
	PubkeyHash string
	Topic      string
	Groups     []string // hex h-тегов MLS-групп, в которых состоит владелец
	CreatedAt  time.Time
	ExpiresAt  time.Time
}

type Store struct {
	db *sql.DB
}

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("pushbridge: открытие БД: %w", err)
	}
	// modernc.org/sqlite — один физический файл, конкурентная запись из нескольких
	// горутин через database/sql возможна только последовательно на уровне SQLite;
	// регистраций мало (self-hosted остров, не тысячи RPS) — 1 соединение на запись
	// достаточно и убирает risk "database is locked" без WAL-настройки отдельно.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS registrations (
			pubkey_hash TEXT PRIMARY KEY,
			topic       TEXT NOT NULL UNIQUE,
			groups_json TEXT NOT NULL DEFAULT '[]',
			created_at  INTEGER NOT NULL,
			expires_at  INTEGER NOT NULL
		)
	`); err != nil {
		db.Close()
		return nil, fmt.Errorf("pushbridge: миграция: %w", err)
	}

	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// Upsert создаёт или полностью заменяет регистрацию для pubkeyHash. Используется
// и POST (создание — новый topic передаётся вызывающим), и PUT (обновление
// фильтров — topic и created_at из существующей записи сохраняются вызывающим).
func (s *Store) Upsert(ctx context.Context, reg Registration) error {
	groupsJSON, err := json.Marshal(reg.Groups)
	if err != nil {
		return fmt.Errorf("pushbridge: маршалинг groups: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO registrations (pubkey_hash, topic, groups_json, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(pubkey_hash) DO UPDATE SET
			topic = excluded.topic,
			groups_json = excluded.groups_json,
			created_at = excluded.created_at,
			expires_at = excluded.expires_at
	`, reg.PubkeyHash, reg.Topic, string(groupsJSON), reg.CreatedAt.Unix(), reg.ExpiresAt.Unix())
	if err != nil {
		return fmt.Errorf("pushbridge: upsert: %w", err)
	}
	return nil
}

func (s *Store) Get(ctx context.Context, pubkeyHash string) (*Registration, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT pubkey_hash, topic, groups_json, created_at, expires_at FROM registrations WHERE pubkey_hash = ?`,
		pubkeyHash)
	return scanRegistration(row)
}

func (s *Store) Delete(ctx context.Context, pubkeyHash string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM registrations WHERE pubkey_hash = ?`, pubkeyHash)
	if err != nil {
		return fmt.Errorf("pushbridge: delete: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("pushbridge: delete rowsaffected: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteExpired — «истёкшие удаляются» (П1.2). Вызывается периодически из main
// (тикер), не на каждый запрос — не нагрузочный сценарий, но и не бесконечный рост.
func (s *Store) DeleteExpired(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM registrations WHERE expires_at < ?`, now.Unix())
	if err != nil {
		return 0, fmt.Errorf("pushbridge: delete expired: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// AllForGroup возвращает все действующие (не истёкшие) регистрации, чей список
// групп содержит groupHex. Линейный проход по всем регистрациям — MVP: остров
// self-hosted, счёт пользователей на десятки-сотни, не миллионы (YAGNI —
// отдельная join-таблица понадобится, если это когда-нибудь станет узким местом,
// не раньше).
func (s *Store) AllForGroup(ctx context.Context, groupHex string, now time.Time) ([]Registration, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT pubkey_hash, topic, groups_json, created_at, expires_at FROM registrations WHERE expires_at >= ?`,
		now.Unix())
	if err != nil {
		return nil, fmt.Errorf("pushbridge: query all: %w", err)
	}
	defer rows.Close()

	var out []Registration
	for rows.Next() {
		reg, err := scanRegistration(rows)
		if err != nil {
			return nil, err
		}
		for _, g := range reg.Groups {
			if g == groupHex {
				out = append(out, *reg)
				break
			}
		}
	}
	return out, rows.Err()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRegistration(row rowScanner) (*Registration, error) {
	var reg Registration
	var groupsJSON string
	var createdAt, expiresAt int64
	err := row.Scan(&reg.PubkeyHash, &reg.Topic, &groupsJSON, &createdAt, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("pushbridge: scan: %w", err)
	}
	if err := json.Unmarshal([]byte(groupsJSON), &reg.Groups); err != nil {
		return nil, fmt.Errorf("pushbridge: unmarshal groups: %w", err)
	}
	reg.CreatedAt = time.Unix(createdAt, 0)
	reg.ExpiresAt = time.Unix(expiresAt, 0)
	return &reg, nil
}
