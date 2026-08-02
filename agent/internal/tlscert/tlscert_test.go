package tlscert

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrGenerate_CreatesFilesOnFirstCall(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	if _, err := os.Stat(certPath); err == nil {
		t.Fatal("precondition: cert file must not exist yet")
	}

	cert, err := LoadOrGenerate(certPath, keyPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cert.Certificate) == 0 {
		t.Fatal("expected at least one DER certificate in the chain")
	}

	for _, p := range []string{certPath, keyPath} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("%s must exist after LoadOrGenerate: %v", p, err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("%s: expected permissions 0600, got %o", p, perm)
		}
	}
}

func TestLoadOrGenerate_PersistsAcrossCalls(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	first, err := LoadOrGenerate(certPath, keyPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	second, err := LoadOrGenerate(certPath, keyPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	fp1, err := Fingerprint(first)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	fp2, err := Fingerprint(second)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fp1 != fp2 {
		t.Fatal("second call must load the SAME certificate persisted by the first call, not regenerate a new one")
	}
}

func TestFingerprint_MatchesManualSHA256(t *testing.T) {
	dir := t.TempDir()
	cert, err := LoadOrGenerate(filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	fp, err := Fingerprint(cert)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	sum := sha256.Sum256(cert.Certificate[0])
	expected := ""
	for _, b := range sum {
		expected += hexByte(b)
	}
	if fp != expected {
		t.Fatalf("fingerprint %q does not match manually computed sha256(cert.Certificate[0]) %q", fp, expected)
	}
	if len(fp) != 64 {
		t.Fatalf("expected 64 hex chars, got %d", len(fp))
	}
}

func hexByte(b byte) string {
	const hexDigits = "0123456789abcdef"
	return string([]byte{hexDigits[b>>4], hexDigits[b&0x0f]})
}

func TestFingerprint_DifferentCertsDifferentFingerprints(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	certA, err := LoadOrGenerate(filepath.Join(dirA, "cert.pem"), filepath.Join(dirA, "key.pem"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	certB, err := LoadOrGenerate(filepath.Join(dirB, "cert.pem"), filepath.Join(dirB, "key.pem"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	fpA, _ := Fingerprint(certA)
	fpB, _ := Fingerprint(certB)
	if fpA == fpB {
		t.Fatal("two independently generated certificates must have different fingerprints")
	}
}
