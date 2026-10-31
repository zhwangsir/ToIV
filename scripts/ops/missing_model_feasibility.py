"""157 条「缺模型」fail 的可得性分流:同名权重到底能不能匿名拿到。

分流口径(全实测,不按 notes 里现成结论):
  ledger_ok     账本 status=ok → 盘上/已知可下,属"该下但没下"
  ledger_blocked 账本 status=blocked → 溯源已知受阻
  ledger_absent 账本里没有这个 basename
  hf_hit        hf-mirror 名字检索有候选
  hf_miss       无候选
只读:不下任何权重。
"""
import json,re,subprocess,urllib.request,urllib.parse,collections,time,sys
PG="PGPASSWORD=68799b59242beeccfd54963902a35006 psql -h 127.0.0.1 -U toiv -d toiv -tA -F'@@' -c"
def q(sql):
    r=subprocess.run(["ssh","-o","ConnectTimeout=30","merlin@192.168.71.47",f"{PG} \"{sql}\""],
                     capture_output=True,text=True,timeout=180)
    if r.returncode!=0: raise RuntimeError(r.stderr[:200])
    return r.stdout
UA="Mozilla/5.0 (Macintosh) ToIV/1.0"
def hf(name):
    u="https://hf-mirror.com/api/models?"+urllib.parse.urlencode({"search":name,"limit":5})
    r=urllib.request.Request(u); r.add_header("User-Agent",UA)
    try:
        with urllib.request.urlopen(r,timeout=25) as x: d=json.load(x)
        return [m.get("id") for m in d][:3]
    except Exception as e:
        return {"err":f"{type(e).__name__}"}
led={ (i.get("basename") or "").lower(): i for i in json.load(
    open("backend/api/app/data/model_sources.json"))["items"]}
rows=[l.split("@@") for l in q("select id, left(coalesce(smoke_error,''),400) from app "
        "where smoke_status='fail' and coalesce(smoke_error,'') like '%缺模型%'").strip().splitlines() if "@@" in l]
print("缺模型 fail 行:",len(rows))
NAMES=re.compile(r"[\w\-. ()\u4e00-\u9fff]+?\.(?:safetensors|ckpt|pt|pth|bin|onnx|gguf)",re.I)
tally=collections.Counter(); out=[]
for aid,err in rows:
    seg=err.split("缺模型",1)[-1].split("缺节点")[0]
    for nm in NAMES.findall(seg):
        b=nm.strip(); low=b.lower()
        st=(led.get(low) or {}).get("status")
        if st=="ok": cls="ledger_ok"
        elif st=="blocked": cls="ledger_blocked"
        else: cls="ledger_absent"
        h=hf(re.sub(r"\.(safetensors|ckpt|pt|pth|bin|onnx|gguf)$","",b,flags=re.I))
        hf_state = "hf_hit" if isinstance(h,list) and h else ("hf_err" if isinstance(h,dict) else "hf_miss")
        tally[cls]+=1; tally[hf_state]+=1
        out.append({"name":b,"ledger":st or "-","cls":cls,"hf":hf_state,"cands":h,"app":aid})
print(json.dumps(dict(tally),ensure_ascii=False))
json.dump(out,open("tmp/rh_resmoke_20261013/missing_model_feasibility.json","w"),ensure_ascii=False,indent=1)
print("样本 8 条:")
for o in out[:8]: print("  ·",o["name"][:44],"|",o["cls"],"|",o["hf"],"|",str(o["cands"])[:56])
