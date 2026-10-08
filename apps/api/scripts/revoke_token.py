#!/usr/bin/env python3
"""Maintain the ToIV token revocation list (TOIV_REVOKED_TOKENS_FILE), read by app/token_policy.py.

The file only ever holds sha256 fingerprints and user cut-off times, never a token.
toiv-api re-reads it on mtime change: no restart needed once the file path is configured.

  revoke_token.py --file F --token-stdin            # revoke one token (read from stdin, never echoed)
  revoke_token.py --file F --sha256 HEX [HEX...]    # revoke by fingerprint (e.g. from h3_token_refresh.py --retire)
  revoke_token.py --file F --user UID [--at UNIX]   # invalidate every token of UID issued before now/--at
  revoke_token.py --file F --list                   # counts only
"""
import argparse, hashlib, json, os, re, sys, tempfile, time


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        data = {}
    return {"tokens": list(dict.fromkeys(data.get("tokens", []))), "users": dict(data.get("users") or {})}


def save(path, data):
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".revoked.", dir=d)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", default=os.environ.get("TOIV_REVOKED_TOKENS_FILE", ""))
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--token-stdin", action="store_true")
    g.add_argument("--sha256", nargs="+")
    g.add_argument("--user")
    g.add_argument("--list", action="store_true")
    ap.add_argument("--at", type=int, help="cut-off (unix seconds) for --user; default now")
    a = ap.parse_args(argv)
    if not a.file:
        ap.error("--file or TOIV_REVOKED_TOKENS_FILE is required")
    data = load(a.file)
    if a.list:
        print(f"tokens={len(data['tokens'])} users={len(data['users'])}")
        return 0
    if a.token_stdin:
        token = sys.stdin.readline().strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        if token.count(".") != 2:
            print("stdin does not look like a JWT", file=sys.stderr)
            return 2
        hashes = [hashlib.sha256(token.encode()).hexdigest()]
    elif a.sha256:
        hashes = [h.strip().lower() for h in a.sha256]
        if not all(re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes):
            print("--sha256 expects 64-hex fingerprints", file=sys.stderr)
            return 2
    else:
        hashes = []
        data["users"][a.user] = int(a.at or time.time())
    for h in hashes:
        if h not in data["tokens"]:
            data["tokens"].append(h)
    save(a.file, data)
    what = f"user {a.user[:8]} cut-off {data['users'][a.user]}" if a.user else ", ".join(h[:8] for h in hashes)
    print(f"revoked: {what}; file now tokens={len(data['tokens'])} users={len(data['users'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
