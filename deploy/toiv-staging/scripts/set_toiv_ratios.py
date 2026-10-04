#!/usr/bin/env python3
"""Add/remove extra ratio options on the ToIV H3 model profile (for the 422 failure-path test). Never prints secrets.
usage: set_toiv_ratios.py add 2048x1152 | remove 2048x1152"""
import json, sys, urllib.request
B = "http://127.0.0.1:8272/api/workspace/model-config"
op, val = sys.argv[1], sys.argv[2]
d = json.load(urllib.request.urlopen(B))["data"]; cfg, rev = d["config"], d.get("revision")
for c in cfg["channels"]:
    for p in c.get("modelProfiles", []):
        if p.get("protocol") == "toiv-h3":
            r = p["capabilityConfig"]["video"]["ratios"]
            if op == "add" and val not in r: r.append(val)
            if op == "remove" and val in r: r.remove(val)
            print("ratios now", r)
body = json.dumps({"config": cfg, "expectedRevision": rev}).encode()
r = urllib.request.urlopen(urllib.request.Request(B, data=body, method="PUT", headers={"Content-Type": "application/json"}))
print("status", r.status, "revision", json.load(r)["data"].get("revision"))
