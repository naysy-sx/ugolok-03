package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureBlossomEnvCreatesWith600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "blossom.env")
	if err := ensureBlossomEnv(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("права %v, ожидались 0600", info.Mode().Perm())
	}
}

func TestEnsureBlossomEnvKeepsContentAndFixesMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "blossom.env")
	if err := os.WriteFile(path, []byte("S3_SECRET=x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureBlossomEnv(path); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "S3_SECRET=x\n" {
		t.Fatalf("содержимое изменено: %q", got)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("права %v, ожидались 0600", info.Mode().Perm())
	}
}
