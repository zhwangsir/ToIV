#!/usr/bin/env bash
# Logs the ToIV test user in; writes token to secrets/toiv_test_token_b (0600). Never prints secrets.
set -euo pipefail
S=/home/merlin/beeftv-staging/secrets
set -a; . $S/toiv_test_account_b.env; set +a
umask 077
python3 - <<PY
import json,os,urllib.request
body=json.dumps({"email":os.environ["TOIV_TEST_EMAIL"],"password":os.environ["TOIV_TEST_PASSWORD"]}).encode()
r=urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8090/api/auth/login",data=body,headers={"Content-Type":"application/json"}),timeout=15)
d=json.load(r); open("$S/toiv_test_token_b","w").write(d["token"])
u=d.get("user",{}); print("login ok user_id=%s role=%s tenant=%s"%(u.get("id"),u.get("role"),u.get("tenant_id")))
PY
