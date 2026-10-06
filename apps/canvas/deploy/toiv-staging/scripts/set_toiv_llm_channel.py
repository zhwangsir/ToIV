#!/usr/bin/env python3
"""Add/refresh the "ToIV LLM" text channel (ToIV\x27s own OpenAI-compatible vLLM, same as TOIV_LLM_BASE_URL/TOIV_LLM_MODEL)
and select it as text + assistant model. Reads base URL / model from ToIV deploy/.env (read-only). No secrets involved
(vLLM endpoint has no auth; ToIV itself uses the placeholder key "lm-studio")."""
import json, urllib.request
env={}
for line in open("/home/merlin/toiv/deploy/.env"):
    if "=" in line and not line.startswith("#"):
        k,v=line.rstrip("\n").split("=",1); env[k]=v.strip().strip("\"")
BASE=env.get("TOIV_LLM_BASE_URL") or "http://192.168.71.84:8000/v1"
MODEL=env.get("TOIV_LLM_MODEL") or "qwen3.8-27b"
B="http://127.0.0.1:8272/api/workspace/model-config"
d=json.load(urllib.request.urlopen(B))["data"]; cfg,rev=d["config"],d.get("revision")
cid="toiv-llm"
prof={"capability":"text","model":MODEL,"protocol":"chat-completion","capabilityConfig":{"version":1,"text":{"streaming":True,"references":{"maxImageBytes":0,"maxImages":0,"maxVideoBytes":0,"maxVideos":0,"promptMaxChars":32000}}}}
ch={"id":cid,"name":"ToIV LLM","baseUrl":BASE,"apiKey":"lm-studio","apiFormat":"openai","enabled":True,"headers":[],"models":[MODEL],"modelProfiles":[prof],"pinned":False,"scope":"user","sortOrder":1}
cfg["channels"]=[c for c in cfg["channels"] if c.get("id")!=cid]+[ch]
key=cid+"::"+MODEL
cfg["textModel"]=key; cfg["textModels"]=[key]
if "assistantModel" in cfg or True: cfg["assistantModel"]=key
body=json.dumps({"config":cfg,"expectedRevision":rev}).encode()
r=urllib.request.urlopen(urllib.request.Request(B,data=body,method="PUT",headers={"Content-Type":"application/json"}))
print("channel",cid,BASE,MODEL,"status",r.status,"revision",json.load(r)["data"].get("revision"))
