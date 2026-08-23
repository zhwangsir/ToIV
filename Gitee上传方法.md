# Gitee 上传方法（全项目统一）

> **发布**：2026-08-23 设备管家（AI Assistant）
> **背景**：GitHub 国内网络差，代码托管已统一切换至 **Gitee**（GitHub 仓库保留作历史备份，不再更新）
> **适用范围**：ALLProject 下所有项目

---

## 一、账号与仓库

- Gitee 账号：**Winery_z**（所有项目仓库建在此账号下，**一律私有**）
- 仓库命名：与项目英文名一致（如 `AICG-DownLoader`、`ToIV`）
- 仓库地址格式：`https://gitee.com/Winery_z/<仓库名>.git`
- 私人令牌：**找用户/设备管家获取**（🔒 令牌禁止写入任何文件、文档、仓库）

## 二、远程配置（标准动作）

```bash
cd <项目目录>

# 1. 原 GitHub 远程改名为备份（没有 GitHub 远程则跳过）
git remote rename origin github

# 2. Gitee 设为默认 origin
git remote add origin https://gitee.com/Winery_z/<仓库名>.git
```

## 三、推送（令牌不落盘的标准方式）

```bash
git -c credential.helper='!f(){ echo username=Winery_z; echo password=<令牌>; };f' \
  push -u origin main
```

- 令牌只存在于该次命令中，**不会写入 .git/config**
- 推送后 `main` 自动跟踪 `origin/main`，之后日常 `git push` 若提示认证，重复上面的命令即可
- 已是 Gitee 托管的项目（如 AICG-DownLoader）：日常直接 `git push`，认证失败时用上条命令

## 四、推送前自查清单（🔒 强制）

```bash
# 1. 敏感文件不得入库（.env 必须被忽略，以下命令应无输出）
git status --porcelain | grep -iE '\.env|credential|secret|\.pem|id_rsa'

# 2. 密钥不得出现在已跟踪内容（应无输出）
git grep -iE 'password=|secret=|sk-|token=' --cached -l

# 3. 大文件检查（Gitee 免费版单文件 >100MB 拒收、>50MB 警告）
git ls-files | xargs ls -l 2>/dev/null | awk '$5>50*1024*1024{print $5, $9}'
```

- 模型、视频产物、数据集：**不入库**，放 NAS（`\\192.168.71.7\NAS`），仓库只留路径引用
- `works/`、`node_modules/`、`dist/`、`target/` 等产物目录确认在 `.gitignore`

## 五、非 git 项目纳入版本控制

```bash
cd <项目目录>
git init -b main
# 先写 .gitignore（至少含 .env / node_modules / dist / 产物目录），再执行第四节自查
git add . && git commit -m "chore: 初始导入"
# 然后按第二、三节建远程并推送
```

## 六、常见问题

| 问题 | 处理 |
|------|------|
| push 报 401/403 | 令牌错误或过期，找设备管家核实 |
| push 报文件过大 | 见第四节第 3 条，大文件移出仓库改用 NAS |
| 网络超时 | Gitee 国内直连即可；⚠️ 关闭本机 mihomo 代理或加 `--noproxy` 思维排查（当前代理节点全挂） |
| 多 AI 会话并行开发 | 每任务独立分支 + PR 合并，禁止直接改 main 共享工作区 |

---

> 已完成切换的标杆项目：**AICG-DownLoader**（Winery_z/AICG-DownLoader，08-23 推送验证通过）
