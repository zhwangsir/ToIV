package generation

import "testing"

func TestProtocolFilenameWithExtension(t *testing.T) {
	cases := map[[2]string]string{
		{"toiv-ref", "image/png"}:       "toiv-ref.png",
		{"toiv-ref", "image/jpeg"}:      "toiv-ref.jpg",
		{"photo.webp", "image/png"}:     "photo.webp",
		{"toiv-ref", "application/x-y"}: "toiv-ref",
		{"clip", "video/mp4"}:           "clip.mp4",
	}
	for in, want := range cases {
		if got := protocolFilenameWithExtension(in[0], in[1]); got != want {
			t.Fatalf("%v -> %q, want %q", in, got, want)
		}
	}
}
