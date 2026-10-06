#!/usr/bin/env python3
"""Put the ToIV test-user JWT (from secrets/toiv_test_token) into the BeefTV ToIV H3 channel. Never prints the token."""
import json, sys, urllib.request
B = "http://127.0.0.1:8272/api/workspace/model-config"
tok = open("/home/merlin/beeftv-staging/secrets/toiv_test_token").read().strip() if len(sys.argv) < 2 else sys.argv[1]
d = json.load(urllib.request.urlopen(B))["data"]
cfg, rev = d["config"], d.get("revision")
hit = 0
for c in cfg["channels"]:
    if c.get("baseUrl", "").startswith("http://127.0.0.1:") and any(p.get("model") == "h3-t2v" for p in c.get("modelProfiles", [])):
        c["apiKey"] = tok; hit += 1
        print("channel", c["id"], c["name"], "protocols", [(p["model"], p.get("protocol")) for p in c["modelProfiles"]], "baseUrl", c["baseUrl"])
body = json.dumps({"config": cfg, "expectedRevision": rev}).encode()
r = urllib.request.urlopen(urllib.request.Request(B, data=body, method="PUT", headers={"Content-Type": "application/json"}))
print("updated", hit, "status", r.status, "new revision", json.load(r)["data"].get("revision"))
