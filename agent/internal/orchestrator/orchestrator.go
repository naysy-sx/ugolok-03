package orchestrator

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

type ServiceStatus struct {
    Service string `json:"Service"`
    State   string `json:"State"`
    Health  string `json:"Health"`
}

type Runner func(dir string, args ...string) ([]byte, error)

// RealRunner — реальный Runner для продакшена: docker <args...>, cwd = dir.
// Тестовый код (orchestrator_test.go) внедряет собственный фейковый Runner —
// RealRunner здесь не покрыт юнит-тестами (требует реальный docker), проверяется
// живьём (CONTRACTS.md, "Этап 63, И2", раздел "живая проверка").
func RealRunner(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("docker", args...)
	cmd.Dir = dir
	return cmd.CombinedOutput()
}

func ComposeUp(run Runner, composeDir string) error {
    output, err := run(composeDir, "compose", "up", "-d")
    if err != nil {
        return fmt.Errorf("error running compose up: %s", strings.TrimSpace(string(output)))
    }
    return nil
}

func ComposeDown(run Runner, composeDir string) error {
    output, err := run(composeDir, "compose", "down")
    if err != nil {
        return fmt.Errorf("error running compose down: %s", strings.TrimSpace(string(output)))
    }
    return nil
}

func ComposeStatus(run Runner, composeDir string) ([]ServiceStatus, error) {
    output, err := run(composeDir, "compose", "ps", "--format", "json")
    if err != nil {
        return nil, fmt.Errorf("error running compose ps: %s", strings.TrimSpace(string(output)))
    }

    statusLines := strings.Split(strings.TrimSpace(string(output)), "\n")
    var statuses []ServiceStatus
    for _, line := range statusLines {
        if line == "" {
            continue
        }
        var status ServiceStatus
        if err := json.Unmarshal([]byte(line), &status); err != nil {
            return nil, fmt.Errorf("error parsing service status: %s", err)
        }
        statuses = append(statuses, status)
    }

    return statuses, nil
}
