package orchestrator

import (
	"errors"
	"testing"
)

func TestComposeUp_CallsDockerComposeUpDetached(t *testing.T) {
	var gotDir string
	var gotArgs []string
	runner := func(dir string, args ...string) ([]byte, error) {
		gotDir = dir
		gotArgs = args
		return []byte(""), nil
	}

	if err := ComposeUp(runner, "/some/compose/dir"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotDir != "/some/compose/dir" {
		t.Fatalf("expected dir %q, got %q", "/some/compose/dir", gotDir)
	}
	want := []string{"compose", "up", "-d"}
	if len(gotArgs) != len(want) {
		t.Fatalf("expected args %v, got %v", want, gotArgs)
	}
	for i := range want {
		if gotArgs[i] != want[i] {
			t.Fatalf("expected args %v, got %v", want, gotArgs)
		}
	}
}

func TestComposeUp_RunnerErrorPropagates(t *testing.T) {
	runner := func(dir string, args ...string) ([]byte, error) {
		return []byte("some docker error output"), errors.New("exit status 1")
	}
	err := ComposeUp(runner, "/dir")
	if err == nil {
		t.Fatal("expected error to propagate")
	}
}

func TestComposeDown_CallsDockerComposeDown(t *testing.T) {
	var gotArgs []string
	runner := func(dir string, args ...string) ([]byte, error) {
		gotArgs = args
		return []byte(""), nil
	}
	if err := ComposeDown(runner, "/dir"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"compose", "down"}
	if len(gotArgs) != len(want) || gotArgs[0] != want[0] || gotArgs[1] != want[1] {
		t.Fatalf("expected args %v, got %v", want, gotArgs)
	}
}

func TestComposeDown_RunnerErrorPropagates(t *testing.T) {
	runner := func(dir string, args ...string) ([]byte, error) {
		return nil, errors.New("boom")
	}
	if err := ComposeDown(runner, "/dir"); err == nil {
		t.Fatal("expected error to propagate")
	}
}

const ndjsonFixture = `{"Service":"relay","State":"running","Health":""}
{"Service":"blossom","State":"running","Health":"healthy"}
{"Service":"coturn","State":"exited","Health":""}
`

func TestComposeStatus_ParsesNDJSON(t *testing.T) {
	var gotArgs []string
	runner := func(dir string, args ...string) ([]byte, error) {
		gotArgs = args
		return []byte(ndjsonFixture), nil
	}

	statuses, err := ComposeStatus(runner, "/dir")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"compose", "ps", "--format", "json"}
	if len(gotArgs) != len(want) {
		t.Fatalf("expected args %v, got %v", want, gotArgs)
	}

	if len(statuses) != 3 {
		t.Fatalf("expected 3 services, got %d: %+v", len(statuses), statuses)
	}
	if statuses[0].Service != "relay" || statuses[0].State != "running" {
		t.Fatalf("unexpected first status: %+v", statuses[0])
	}
	if statuses[1].Service != "blossom" || statuses[1].Health != "healthy" {
		t.Fatalf("unexpected second status: %+v", statuses[1])
	}
	if statuses[2].Service != "coturn" || statuses[2].State != "exited" {
		t.Fatalf("unexpected third status: %+v", statuses[2])
	}
}

func TestComposeStatus_EmptyOutputMeansNoServices(t *testing.T) {
	runner := func(dir string, args ...string) ([]byte, error) {
		return []byte(""), nil
	}
	statuses, err := ComposeStatus(runner, "/dir")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(statuses) != 0 {
		t.Fatalf("expected zero services for empty output, got %d", len(statuses))
	}
}

func TestComposeStatus_IgnoresBlankLines(t *testing.T) {
	runner := func(dir string, args ...string) ([]byte, error) {
		return []byte("\n" + ndjsonFixture + "\n\n"), nil
	}
	statuses, err := ComposeStatus(runner, "/dir")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(statuses) != 3 {
		t.Fatalf("expected 3 services (blank lines skipped), got %d", len(statuses))
	}
}

func TestComposeStatus_RunnerErrorPropagates(t *testing.T) {
	runner := func(dir string, args ...string) ([]byte, error) {
		return nil, errors.New("docker not found")
	}
	if _, err := ComposeStatus(runner, "/dir"); err == nil {
		t.Fatal("expected error to propagate")
	}
}

func TestComposeStatus_MalformedLineRejected(t *testing.T) {
	runner := func(dir string, args ...string) ([]byte, error) {
		return []byte("not valid json\n"), nil
	}
	if _, err := ComposeStatus(runner, "/dir"); err == nil {
		t.Fatal("expected error for malformed JSON line")
	}
}
