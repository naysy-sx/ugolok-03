package render

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTemplate(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write template fixture: %v", err)
	}
}

func TestRenderAll_SubstitutesFields(t *testing.T) {
	templatesDir := t.TempDir()
	outputDir := filepath.Join(t.TempDir(), "rendered")

	writeTemplate(t, templatesDir, "greeting.txt.tmpl", "hello {{.RelayDomain}}, blossom is {{.BlossomDomain}}")

	cfg := Config{RelayDomain: "relay.example.com", BlossomDomain: "blossom.example.com"}
	if err := RenderAll(templatesDir, outputDir, cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	out, err := os.ReadFile(filepath.Join(outputDir, "greeting.txt"))
	if err != nil {
		t.Fatalf("expected rendered output file: %v", err)
	}
	want := "hello relay.example.com, blossom is blossom.example.com"
	if string(out) != want {
		t.Fatalf("got %q, want %q", string(out), want)
	}
}

func TestRenderAll_StripsTmplSuffixOnly(t *testing.T) {
	templatesDir := t.TempDir()
	outputDir := filepath.Join(t.TempDir(), "rendered")
	writeTemplate(t, templatesDir, "config.yml.tmpl", "domain: {{.BlossomDomain}}")

	if err := RenderAll(templatesDir, outputDir, Config{BlossomDomain: "x"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outputDir, "config.yml")); err != nil {
		t.Fatalf("expected config.yml (suffix stripped), got error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outputDir, "config.yml.tmpl")); err == nil {
		t.Fatal("output directory must not contain the .tmpl file itself")
	}
}

func TestRenderAll_IgnoresNonTemplateFiles(t *testing.T) {
	templatesDir := t.TempDir()
	outputDir := filepath.Join(t.TempDir(), "rendered")
	writeTemplate(t, templatesDir, "Caddyfile", "{$RELAY_DOMAIN} { reverse_proxy relay:7777 }")
	writeTemplate(t, templatesDir, "real.txt.tmpl", "{{.RelayDomain}}")

	if err := RenderAll(templatesDir, outputDir, Config{RelayDomain: "r"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outputDir, "Caddyfile")); err == nil {
		t.Fatal("non-.tmpl files must NOT be copied to outputDir (Caddy reads its own Caddyfile directly, unrendered)")
	}
	if _, err := os.Stat(filepath.Join(outputDir, "real.txt")); err != nil {
		t.Fatalf("expected real.txt to be rendered: %v", err)
	}
}

func TestRenderAll_CreatesOutputDir(t *testing.T) {
	templatesDir := t.TempDir()
	outputDir := filepath.Join(t.TempDir(), "nested", "rendered")
	writeTemplate(t, templatesDir, "a.tmpl", "x")

	if err := RenderAll(templatesDir, outputDir, Config{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := os.Stat(outputDir); err != nil {
		t.Fatalf("expected outputDir to be created: %v", err)
	}
}

func TestRenderAll_OutputFilePermissions(t *testing.T) {
	templatesDir := t.TempDir()
	outputDir := filepath.Join(t.TempDir(), "rendered")
	writeTemplate(t, templatesDir, "secret.conf.tmpl", "secret={{.TurnSecret}}")

	if err := RenderAll(templatesDir, outputDir, Config{TurnSecret: "s3cr3t"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	info, err := os.Stat(filepath.Join(outputDir, "secret.conf"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("rendered files may contain secrets (TURN_SECRET etc) — expected 0600, got %o", perm)
	}
}

func TestRenderAll_InvalidTemplateSyntaxRejected(t *testing.T) {
	templatesDir := t.TempDir()
	outputDir := filepath.Join(t.TempDir(), "rendered")
	writeTemplate(t, templatesDir, "broken.tmpl", "{{.Unclosed")

	if err := RenderAll(templatesDir, outputDir, Config{}); err == nil {
		t.Fatal("expected error for invalid template syntax")
	}
}
