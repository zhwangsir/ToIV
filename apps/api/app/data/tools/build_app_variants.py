import json, os, sys
sys.path.insert(0, "/home/merlin/toiv/api")
for line in open("/home/merlin/toiv/deploy/.env"):
    line=line.strip()
    if not line or line.startswith("#") or "=" not in line: continue
    k,v=line.split("=",1); os.environ.setdefault(k, v.strip().strip('"').strip("'"))
from sqlmodel import Session
from app.db import engine
from app.models import App
src = json.load(open("/home/merlin/toiv/tmp/variants_v1.json"))
DROP = {("qwen-image-edit","色彩调整"),("rh-acc-0341958658-5aead4","画面延伸"),("rh-acc-0341958658-5aead4","多方位"),("rh-acc-7398243328-b4f484","影视二创")}
RENAME = {"丝袜美女转圈":"起身转圈","发型衣服换发色":"换发色","加背景白底":"产品换场景","详情页":"海边出游海报","字体/抽象/艺术摄影":"旅行横屏海报","与自己相拥":"双人相拥"}
PRESET_TO_MODE = {"插入中间帧","衣服分离","图转实物","无塑料感"}
def smoke(a):
    s = a.smoke_status
    return (s if isinstance(s,str) else (s or {}).get("status") if isinstance(s,dict) else str(s or "")) or ""
def prompt_key(a):
    sch = a.params_schema or []
    for p in sch:
        k=(p.get("key") or "").lower(); lab=p.get("label") or ""
        if p.get("type") in ("textarea","text") and ("prompt" in k or "提示" in lab or k in ("text","positive")):
            if "neg" in k or "负" in lab: continue
            return p.get("key")
    for p in sch:
        if p.get("type")=="textarea": return p.get("key")
    return None
out = {}; stats={"modes":0,"modes_drop":0,"presets":0,"presets_drop":0,"promoted":0}
with Session(engine) as s:
    for kid, v in src.items():
        if kid.startswith("_"): continue
        keeper = s.get(App, kid)
        if not keeper or not keeper.is_public: continue
        modes=[]
        for m in v.get("modes",[]):
            t = s.get(App, m["app_id"])
            if t and smoke(t)=="pass" and bool(t.is_nsfw)==bool(keeper.is_nsfw):
                modes.append({"label":m["label"],"desc":m.get("desc",""),"app_id":t.id}); stats["modes"]+=1
            else: stats["modes_drop"]+=1
        presets=[]; kk = prompt_key(keeper)
        seen_vals=set()
        if kk:
            for q in keeper.params_schema or []:
                if q.get("key")==kk and isinstance(q.get("default"),str): seen_vals.add(q["default"].strip())
        for p in v.get("presets",[]):
            sa = s.get(App, p["source_app_id"])
            if not sa: stats["presets_drop"]+=1; continue
            if p["label"] in PRESET_TO_MODE:
                if smoke(sa)=="pass" and len(modes)<6 and bool(sa.is_nsfw)==bool(keeper.is_nsfw):
                    modes.append({"label":p["label"],"desc":"","app_id":sa.id}); stats["promoted"]+=1
                continue
            sk = prompt_key(sa)
            val = None
            if sk:
                for q in sa.params_schema or []:
                    if q.get("key")==sk: val=q.get("default")
            if sk and not (isinstance(val,str) and val.strip()):
                b=(sa.bindings or {}).get(sk) or {}
                wf=sa.workflow_json or {}
                nid=str(b.get("node") or b.get("node_id") or ""); fld=b.get("field") or b.get("input") or ""
                node=wf.get(nid) or {}
                cand=node
                for part in (fld.split(".") if fld.startswith("inputs.") else ["inputs",fld]):
                    cand=cand.get(part) if isinstance(cand,dict) else None
                if isinstance(cand,str): val=cand
            if not kk or not isinstance(val,str) or not val.strip():
                stats["presets_drop"]+=1; continue
            v2=val.strip()
            if v2 in seen_vals or v2.startswith("紧接首帧画面：602室") or v2.startswith("现实主义都市短剧风格，夜晚老式居民楼"):
                stats["presets_drop"]+=1; continue
            if (kid,p["label"]) in DROP: stats["presets_drop"]+=1; continue
            seen_vals.add(v2)
            p=dict(p, label=RENAME.get(p["label"],p["label"]))
            presets.append({"label":p["label"],"values":{kk: v2}}); stats["presets"]+=1
        if modes or presets:
            out[kid]={"modes":modes,"presets":presets}
json.dump(out, open("/home/merlin/toiv/tmp/app_variants.json","w"), ensure_ascii=False, indent=1)
print(len(out), stats)
