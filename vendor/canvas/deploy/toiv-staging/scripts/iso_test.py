#!/usr/bin/env python3
"""Two-way ToIV isolation proof (A vs B). Never prints tokens. Writes iso_results.json."""
import json, urllib.request, urllib.error, sys, time
S="/home/merlin/beeftv-staging/secrets/"; API="http://127.0.0.1:8090"
TOK={"A":open(S+"toiv_test_token").read().strip(),"B":open(S+"toiv_test_token_b").read().strip()}
def call(who, method, path):
    req=urllib.request.Request(API+path, method=method, headers={"Authorization":"Bearer "+TOK[who]})
    try:
        r=urllib.request.urlopen(req, timeout=20); body=r.read(); code=r.status
    except urllib.error.HTTPError as e:
        body=e.read(); code=e.code
    ct=""
    try: txt=json.loads(body)
    except Exception: txt={"_bytes":len(body)}
    return code, txt
def me(who):
    j=call(who,"GET","/api/auth/me")[1]; return j.get("id") or (j.get("user") or {}).get("id")
def latest_job(who, prompt_id):
    c,j=call(who,"GET","/api/jobs/lookup?prompt_id="+prompt_id); return c,j
A_PROMPT, B_PROMPT = sys.argv[1], sys.argv[2]
out={"generated_at":time.strftime("%Y-%m-%dT%H:%M:%S%z"),"users":{"A":me("A"),"B":me("B")},"cases":[]}
owners={}
for owner,pid in (("A",A_PROMPT),("B",B_PROMPT)):
    c,j=latest_job(owner,pid); owners[owner]=j
    out["cases"].append({"case":f"{owner} lookup own job","http":c,"status":j.get("status"),"job_id":j.get("id"),"prompt_id":pid,"worker_in_result":("100.68.100.90%3A8264" in (j.get("results") or [""])[0]) if j.get("results") else None})
for owner,other in (("A","B"),("B","A")):
    j=owners[owner]; pid=j.get("prompt_id"); jid=j.get("id")
    c,r=call(other,"GET","/api/jobs/lookup?prompt_id="+pid); out["cases"].append({"case":f"{other} lookup {owner} job by prompt_id","http":c,"body":r,"expect":404,"pass":c==404})
    c,r=call(other,"GET",f"/api/jobs/{jid}/versions"); out["cases"].append({"case":f"{other} versions {owner} job by job_id","http":c,"body":r,"expect":404,"pass":c==404})
    url=(j.get("results") or [None])[0]
    if url:
        import re
        c,r=call(other,"GET",url); out["cases"].append({"case":f"{other} fetch {owner} result file WITH leaked {owner} signed URL","http":c,"bytes":r.get("_bytes") if isinstance(r,dict) else None,"note":"by design: ToIV sig = HMAC capability (no DB check); URL only obtainable via owner-checked lookup, so only an explicit leak exposes it","informational":True})
        unsigned=re.sub(r"&sig=[^&]*","",url)
        c,r=call(other,"GET",unsigned); out["cases"].append({"case":f"{other} fetch {owner} result file WITHOUT sig (DB ownership path)","http":c,"body":r if "_bytes" not in r else {"bytes":r["_bytes"]},"expect":"403/404","pass":c in (403,404)})
        tampered=re.sub(r"&sig=([^&]*)",lambda m:"&sig="+("0"*len(m.group(1))),url)
        c,r=call(other,"GET",tampered); out["cases"].append({"case":f"{other} fetch {owner} result file with forged sig","http":c,"body":r if "_bytes" not in r else {"bytes":r["_bytes"]},"expect":"403/404","pass":c in (403,404)})
        c,r=call(owner,"GET",url); out["cases"].append({"case":f"{owner} fetch own result file (control)","http":c,"bytes":r.get("_bytes") if isinstance(r,dict) else None,"expect":200,"pass":c==200})
    for key,kind in ((jid,"job_id"),(pid,"prompt_id")):
        c,r=call(other,"POST",f"/api/jobs/{key}/cancel"); out["cases"].append({"case":f"{other} cancel {owner} job by {kind}","http":c,"body":r,"expect":404,"pass":c==404})
    c,r=latest_job(owner,pid); out["cases"].append({"case":f"{owner} job unchanged after {other} attempts","http":c,"status":r.get("status"),"pass":r.get("status")==j.get("status")})
out["all_pass"]=all(x.get("pass",True) for x in out["cases"])
json.dump(out,open("/home/merlin/beeftv-staging/logs/iso_results.json","w"),ensure_ascii=False,indent=1)
for x in out["cases"]: print(x["case"],"->",x["http"],"PASS" if x.get("pass",True) else "FAIL")
print("all_pass",out["all_pass"], "users", out["users"])
