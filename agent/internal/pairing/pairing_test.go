package pairing

import "testing"

func TestEncodeDecode_RoundTrip(t *testing.T) {
	original := Code{
		Host:        "203.0.113.42",
		Port:        8443,
		Token:       "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		Fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
	}

	encoded, err := Encode(original)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if encoded == "" {
		t.Fatal("encoded pairing code must not be empty")
	}

	decoded, err := Decode(encoded)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if decoded != original {
		t.Fatalf("round-trip mismatch: got %+v, want %+v", decoded, original)
	}
}

func TestEncode_NotPlainJSON(t *testing.T) {
	// Пейринг-код — компактная строка для QR/копирования, не сырой JSON
	// (который содержит пробелы/фигурные скобки, менее удобен для вставки одной строкой).
	encoded, err := Encode(Code{Host: "h", Port: 1, Token: "t", Fingerprint: "f"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, c := range encoded {
		if c == '{' || c == '"' || c == ' ' {
			t.Fatalf("encoded pairing code %q must be base64, not raw JSON", encoded)
		}
	}
}

func TestDecode_InvalidBase64Rejected(t *testing.T) {
	if _, err := Decode("not-valid-base64!!!"); err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestDecode_ValidBase64ButNotJSONRejected(t *testing.T) {
	// "aGVsbG8" — валидный base64 (RawURLEncoding) для "hello", не JSON.
	if _, err := Decode("aGVsbG8"); err == nil {
		t.Fatal("expected error for base64 that doesn't decode to valid JSON")
	}
}

func TestDecode_EmptyStringRejected(t *testing.T) {
	if _, err := Decode(""); err == nil {
		t.Fatal("expected error for empty string")
	}
}
