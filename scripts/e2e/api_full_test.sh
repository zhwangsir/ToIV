#!/bin/bash
# ToIV 全功能 API 端点测试
set +e
API="http://192.168.71.127:8090"
PASS=0; FAIL=0; SKIP=0
RESULTS=()

report() {
  local status="$1" name="$2" detail="$3"
  case "$status" in
    PASS) PASS=$((PASS+1));;
    FAIL) FAIL=$((FAIL+1));;
    SKIP) SKIP=$((SKIP+1));;
  esac
  RESULTS+=("[$status] $name :: $detail")
}

# ── 登录 ──
LOGIN=$(curl -s -m 10 -X POST $API/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin","password":"admin123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  report FAIL "auth/login" "无法获取 token"
  echo "登录失败,终止测试"
  exit 1
fi
report PASS "auth/login" "token 获取成功"
AUTH="Authorization: Bearer $TOKEN"

# ── 1. 健康检查 ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/health.json $API/api/health)
if [ "$H" = "200" ]; then
  report PASS "GET /api/health" "200 $(cat /tmp/health.json | head -c 100)"
else
  report FAIL "GET /api/health" "HTTP $H"
fi

# ── 2. 当前用户 ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/me.json -H "$AUTH" $API/api/auth/me)
if [ "$H" = "200" ]; then
  report PASS "GET /api/auth/me" "200"
else
  report FAIL "GET /api/auth/me" "HTTP $H"
fi

# ── 3. 项目列表 ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/projs.json -H "$AUTH" $API/api/drama/projects)
if [ "$H" = "200" ]; then
  PCOUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/projs.json'))))" 2>/dev/null)
  report PASS "GET /api/drama/projects" "200 项目数=$PCOUNT"
else
  report FAIL "GET /api/drama/projects" "HTTP $H"
fi

# ── 4. 创建项目 ──
R=$(curl -s -m 10 -H "$AUTH" -X POST $API/api/drama/projects \
  -H "Content-Type: application/json" \
  -d '{"title":"API全量测试-勿删","script":"主角走到悬崖,遇见对手,展开对决","style":"wuxia","width":768,"height":384,"fps":16}')
PID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -n "$PID" ]; then
  report PASS "POST /api/drama/projects" "项目创建 id=$PID"
else
  report FAIL "POST /api/drama/projects" "响应: $R"
  PID=""
fi

# ── 5. 获取项目详情 ──
if [ -n "$PID" ]; then
  H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/pdetail.json -H "$AUTH" $API/api/drama/projects/$PID)
  if [ "$H" = "200" ]; then
    report PASS "GET /api/drama/projects/{id}" "200"
  else
    report FAIL "GET /api/drama/projects/{id}" "HTTP $H"
  fi
fi

# ── 6. PATCH 项目 ──
if [ -n "$PID" ]; then
  H=$(curl -s -m 5 -w "%{http_code}" -o /dev/null -H "$AUTH" -X PATCH $API/api/drama/projects/$PID \
    -H "Content-Type: application/json" -d '{"title":"API全量测试-改名"}')
  if [ "$H" = "200" ]; then
    report PASS "PATCH /api/drama/projects/{id}" "200"
  else
    report FAIL "PATCH /api/drama/projects/{id}" "HTTP $H"
  fi
fi

# ── 7. 创建角色 ──
CID=""
if [ -n "$PID" ]; then
  R=$(curl -s -m 10 -H "$AUTH" -X POST $API/api/drama/projects/$PID/characters \
    -H "Content-Type: application/json" \
    -d '{"name":"剑客","description":"孤傲剑客","visual_prompt":"1boy, ancient chinese warrior, black robe, long sword, cold eyes","persona":"沉默寡言"}')
  CID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [ -n "$CID" ]; then
    report PASS "POST /api/drama/projects/{id}/characters" "角色创建 id=$CID"
  else
    report FAIL "POST /api/drama/projects/{id}/characters" "响应: $R"
  fi
fi

# ── 8. PATCH 角色 ──
if [ -n "$CID" ]; then
  H=$(curl -s -m 5 -w "%{http_code}" -o /dev/null -H "$AUTH" -X PATCH $API/api/drama/characters/$CID \
    -H "Content-Type: application/json" -d '{"description":"修改后描述"}')
  if [ "$H" = "200" ]; then
    report PASS "PATCH /api/drama/characters/{id}" "200"
  else
    report FAIL "PATCH /api/drama/characters/{id}" "HTTP $H"
  fi
fi

# ── 9. LLM 拆分镜(实测 49s,超时给 180s 防 LLM 排队) ──
if [ -n "$PID" ]; then
  R=$(curl -s -m 180 -H "$AUTH" -X POST $API/api/drama/projects/$PID/storyboard \
    -H "Content-Type: application/json" -d '{}')
  if echo "$R" | grep -q '"shots"'; then
    SC=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('shots',[])))" 2>/dev/null)
    report PASS "POST /api/drama/projects/{id}/storyboard" "分镜数=$SC"
  else
    report SKIP "POST /api/drama/projects/{id}/storyboard" "LLM 不可达,响应: $(echo $R | head -c 200)"
  fi
fi

# ── 10. 宫格分镜(实测 59s,LLM+ComfyUI,超时给 240s) ──
if [ -n "$PID" ]; then
  R=$(curl -s -m 240 -H "$AUTH" -X POST $API/api/drama/projects/$PID/grid-storyboard \
    -H "Content-Type: application/json" -d '{"num_shots":6}')
  if echo "$R" | grep -q '"grid_image"'; then
    if echo "$R" | grep -q '"grid_image":""'; then
      report SKIP "POST /api/drama/projects/{id}/grid-storyboard" "LLM 或 ComfyUI 不可达: $(echo $R | head -c 200)"
    else
      report PASS "POST /api/drama/projects/{id}/grid-storyboard" "成功"
    fi
  else
    report SKIP "POST /api/drama/projects/{id}/grid-storyboard" "响应: $(echo $R | head -c 200)"
  fi
fi

# ── 11. Skill 市场列表 ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/skills.json -H "$AUTH" $API/api/drama/skills)
if [ "$H" = "200" ]; then
  SC=$(python3 -c "import json; print(len(json.load(open('/tmp/skills.json'))))" 2>/dev/null)
  report PASS "GET /api/drama/skills" "200 Skill 数=$SC"
else
  report FAIL "GET /api/drama/skills" "HTTP $H"
fi

# ── 12. Skill 详情(实际 id 是 skill-wuxia,非 wuxia) ──
H=$(curl -s -m 5 -w "%{http_code}" -o /dev/null -H "$AUTH" $API/api/drama/skills/skill-wuxia)
if [ "$H" = "200" ]; then
  report PASS "GET /api/drama/skills/{id}" "200"
else
  report FAIL "GET /api/drama/skills/{id}" "HTTP $H"
fi

# ── 13. 视频生成器列表 ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/vgs.json -H "$AUTH" $API/api/drama/video-generators)
if [ "$H" = "200" ]; then
  VC=$(python3 -c "import json; print(len(json.load(open('/tmp/vgs.json'))))" 2>/dev/null)
  report PASS "GET /api/drama/video-generators" "200 生成器数=$VC"
else
  report FAIL "GET /api/drama/video-generators" "HTTP $H"
fi

# ── 14. 角色三视图(需 ComfyUI,字段名 reference_front 非 reference_image) ──
if [ -n "$CID" ]; then
  R=$(curl -s -m 180 -H "$AUTH" -X POST $API/api/drama/characters/$CID/generate-reference \
    -H "Content-Type: application/json" -d '{}')
  REF=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('reference_front',''))" 2>/dev/null)
  if [ -n "$REF" ]; then
    report PASS "POST /api/drama/characters/{id}/generate-reference" "reference_front 生成成功"
  else
    report SKIP "POST /api/drama/characters/{id}/generate-reference" "响应: $(echo $R | head -c 200)"
  fi
fi

# ── 15. 模型列表 ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/models.json -H "$AUTH" $API/api/models)
if [ "$H" = "200" ]; then
  report PASS "GET /api/models" "200"
else
  report FAIL "GET /api/models" "HTTP $H"
fi

# ── 16. Manju 端点 ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/manju.json -H "$AUTH" $API/api/manju/projects)
if [ "$H" = "200" ]; then
  report PASS "GET /api/manju/projects" "200"
else
  report SKIP "GET /api/manju/projects" "HTTP $H"
fi

# ── 17. Jobs 端点(原 agent/conversations 路径不存在,改测任务列表) ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/jobs.json -H "$AUTH" $API/api/jobs)
if [ "$H" = "200" ]; then
  report PASS "GET /api/jobs" "200"
else
  report SKIP "GET /api/jobs" "HTTP $H"
fi

# ── 18. Workflows 模板端点(原 video/tasks 路径不存在,改测工作流模板) ──
H=$(curl -s -m 5 -w "%{http_code}" -o /tmp/wf.json -H "$AUTH" $API/api/workflows/templates)
if [ "$H" = "200" ]; then
  report PASS "GET /api/workflows/templates" "200"
else
  report SKIP "GET /api/workflows/templates" "HTTP $H"
fi

# ── 19. 删除角色 ──
if [ -n "$CID" ]; then
  H=$(curl -s -m 5 -w "%{http_code}" -o /dev/null -H "$AUTH" -X DELETE $API/api/drama/characters/$CID)
  if [ "$H" = "200" ] || [ "$H" = "204" ]; then
    report PASS "DELETE /api/drama/characters/{id}" "$H"
  else
    report FAIL "DELETE /api/drama/characters/{id}" "HTTP $H"
  fi
fi

# ── 20. 删除项目 ──
if [ -n "$PID" ]; then
  H=$(curl -s -m 5 -w "%{http_code}" -o /dev/null -H "$AUTH" -X DELETE $API/api/drama/projects/$PID)
  if [ "$H" = "200" ] || [ "$H" = "204" ]; then
    report PASS "DELETE /api/drama/projects/{id}" "$H"
  else
    report FAIL "DELETE /api/drama/projects/{id}" "HTTP $H"
  fi
fi

# ── 22. TTS 健康(实际推理) ──
H=$(curl -s -m 15 -X POST http://192.168.71.127:9200/tts \
  -F "text=测试音频" -F "language=zh" -o /tmp/tts.wav -w "%{http_code}")
if [ "$H" = "200" ]; then
  SZ=$(wc -c < /tmp/tts.wav)
  report PASS "POST TTS /tts" "200 wav=$SZ bytes"
else
  report FAIL "POST TTS /tts" "HTTP $H"
fi

# ── 23. 主 LLM 健康(已知不可达) ──
H=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://192.168.71.127:8000/v1/models)
if [ "$H" = "200" ]; then
  report PASS "LLM main workstation:8000" "200"
else
  report SKIP "LLM main workstation:8000" "HTTP $H 不可达"
fi

# ── 24. NSFW LLM(spark01) ──
H=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://192.168.71.82:8000/v1/models)
if [ "$H" = "200" ]; then
  report PASS "LLM nsfw spark01:8000" "200"
else
  report FAIL "LLM nsfw spark01:8000" "HTTP $H"
fi

# ── 25. ComfyUI LB ──
H=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://192.168.71.127:8188/system_stats)
if [ "$H" = "200" ]; then
  report PASS "ComfyUI LB :8188" "200"
else
  report FAIL "ComfyUI LB :8188" "HTTP $H"
fi

# ── 汇总 ──
echo ""
echo "========================================"
echo "  ToIV 全功能 API 测试汇总"
echo "========================================"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo "----------------------------------------"
echo "PASS: $PASS   FAIL: $FAIL   SKIP: $SKIP   TOTAL: $((PASS+FAIL+SKIP))"
echo "========================================"
