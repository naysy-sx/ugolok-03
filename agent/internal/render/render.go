package render

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

type Config struct {
	RelayDomain    string
	RelayName      string
	BlossomDomain  string
	TurnSecret     string
	TurnRealm      string
	TurnExternalIP string
}

func RenderAll(templatesDir, outputDir string, cfg Config) error {
	if err := os.MkdirAll(outputDir, 0o700); err != nil {
		return fmt.Errorf("failed to create output directory: %w", err)
	}

	matches, err := filepath.Glob(filepath.Join(templatesDir, "*.tmpl"))
	if err != nil {
		return fmt.Errorf("failed to find template files: %w", err)
	}

	for _, path := range matches {
		content, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("failed to read template file %s: %w", path, err)
		}

		tmplName := filepath.Base(path)
		tmpl, err := template.New(tmplName).Parse(string(content))
		if err != nil {
			return fmt.Errorf("failed to parse template file %s: %w", path, err)
		}

		outName := strings.TrimSuffix(tmplName, ".tmpl")
		outPath := filepath.Join(outputDir, outName)
		// 0600 — рендер может содержать секреты (TURN_SECRET и т.п.), тот же
		// принцип, что state/token.hex (auth.LoadOrCreateToken) — не полагаться
		// на дефолт os.Create (обычно 0644 minus umask).
		outFile, err := os.OpenFile(outPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return fmt.Errorf("failed to create output file %s: %w", outPath, err)
		}
		err = tmpl.Execute(outFile, cfg)
		outFile.Close()
		if err != nil {
			return fmt.Errorf("failed to execute template file %s: %w", path, err)
		}
	}

	return nil
}
