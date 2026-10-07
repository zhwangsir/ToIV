package repository

import (
	"strings"
	"testing"
)

func TestPortableByteLength(t *testing.T) {
	in := `SELECT COALESCE(SUM(length(CAST(COALESCE(payload_json, '') AS BLOB)) + length(CAST(COALESCE(state_json,'') AS BLOB))), 0)`
	if got := portableByteLength("sqlite", in); got != in {
		t.Fatalf("sqlite query changed: %s", got)
	}
	got := portableByteLength("postgres", in)
	if strings.Contains(got, "BLOB") {
		t.Fatalf("postgres query still uses BLOB: %s", got)
	}
	want := `SELECT COALESCE(SUM(octet_length(COALESCE(CAST(payload_json AS TEXT), '')) + octet_length(COALESCE(CAST(state_json AS TEXT), ''))), 0)`
	if got != want {
		t.Fatalf("postgres rewrite\n got %s\nwant %s", got, want)
	}
}
