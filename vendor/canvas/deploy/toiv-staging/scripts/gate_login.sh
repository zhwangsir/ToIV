#!/usr/bin/env bash
# Usage: gate_login.sh a|b [gate_url]  -> logs the ToIV test user into the BeefTV gate; cookie jar in secrets/ (0600). Prints no secrets.
set -euo pipefail
S=/home/merlin/beeftv-staging/secrets; W=${1:-a}; G=${2:-http://127.0.0.1:8271}
f=$S/toiv_test_account.env; [ "$W" = b ] && f=$S/toiv_test_account_b.env
set -a; . $f; set +a; umask 077
python3 - "$G" "$S/gate_cookies_$W.txt" <<PY
import json,os,sys,urllib.request,http.cookiejar
g,jar=sys.argv[1],sys.argv[2]
cj=http.cookiejar.MozillaCookieJar(jar); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
body=json.dumps({"email":os.environ["TOIV_TEST_EMAIL"],"password":os.environ["TOIV_TEST_PASSWORD"]}).encode()
try:
  r=op.open(urllib.request.Request(g+"/auth/login",data=body,headers={"Content-Type":"application/json","Origin":g}),timeout=120); d=json.load(r); st=r.status
except urllib.error.HTTPError as e: st=e.code; d=json.load(e)
cj.save(ignore_discard=True,ignore_expires=True)
print("gate login",st,"user",(d.get("user") or {}).get("id","-"), d.get("error",""), d.get("message",""))
PY
