#!/usr/bin/env python3
"""toiv-h3 0.4: add the auto-routing "h3" model (t2v / i2v / fl2v / r2v) next to h3-t2v.

Usage:
  upgrade_h3_profiles.py --template FILE...   rewrite model-config templates in place
  upgrade_h3_profiles.py --instances          upgrade every running per-user staging instance
                                              (GET/PUT loopback /api/workspace/model-config)
Idempotent. Never prints channel credentials.
"""
import copy, json, sys, urllib.request

OPS = ["text_to_video", "image_to_video", "reference_to_video"]


def upgrade(cfg):
    changed = 0
    for ch in cfg.get("channels", []):
        profiles = ch.get("modelProfiles") or []
        h3 = [p for p in profiles if p.get("protocol") == "toiv-h3" or p.get("model") in ("h3-t2v", "h3")]
        if not h3:
            continue
        for p in h3:
            video = p.setdefault("capabilityConfig", {}).setdefault("video", {})
            if video.get("operations") != OPS:
                video["operations"] = list(OPS)
                changed += 1
            refs = video.setdefault("references", {})
            if refs.get("maxImages") != 9 or refs.get("minImages") != 0:
                refs.update({"maxImages": 9, "minImages": 0})
                changed += 1
        if not any(p.get("model") == "h3" for p in profiles):
            auto = copy.deepcopy(h3[0])
            auto["model"] = "h3"
            auto["protocol"] = "toiv-h3"
            profiles.insert(0, auto)
            ch["modelProfiles"] = profiles
            changed += 1
        models = ch.get("models") or []
        if "h3" not in models:
            ch["models"] = ["h3"] + models
            changed += 1
        key = f'{ch["id"]}::h3'
        for field in ("videoModels", "models"):
            values = cfg.get(field) or []
            if key not in values:
                cfg[field] = [key] + values
                changed += 1
        if cfg.get("videoModel") != key:
            cfg["videoModel"] = key
            changed += 1
    return changed


def instances():
    reg = json.load(open("/home/merlin/beeftv-staging/users/registry.json"))
    for uid, entry in reg.items():
        url = f'http://127.0.0.1:{entry["port"]}/api/workspace/model-config'
        try:
            data = json.load(urllib.request.urlopen(url, timeout=5))["data"]
        except Exception as exc:  # instance not running: the template covers its next provisioning
            print(uid[:8], "skip (not running):", type(exc).__name__)
            continue
        cfg = data["config"]
        n = upgrade(cfg)
        if not n:
            print(uid[:8], "already up to date")
            continue
        body = json.dumps({"config": cfg, "expectedRevision": data.get("revision")}).encode()
        req = urllib.request.Request(url, data=body, method="PUT", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            print(uid[:8], "upgraded", n, "fields, status", r.status)


if __name__ == "__main__":
    if sys.argv[1:2] == ["--instances"]:
        instances()
    elif sys.argv[1:2] == ["--template"]:
        for path in sys.argv[2:]:
            cfg = json.load(open(path))
            n = upgrade(cfg)
            json.dump(cfg, open(path, "w"), ensure_ascii=False, indent=1)
            open(path, "a").write("\n")
            print(path, "changed", n)
    else:
        print(__doc__)
        sys.exit(2)
