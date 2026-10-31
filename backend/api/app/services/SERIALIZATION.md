# 规范序列化（ingest / freeze 哈希）

防跨端哈希漂移。实现：`app/services/canonical_json.py`。

## 伪代码

```
canonical_dumps(obj) -> bytes:
  1. dict：按 key UTF-8 字节序排序（嵌套同样）
  2. list：保序
  3. json.dumps(..., ensure_ascii=False, sort_keys=True,
                separators=(',', ':'), allow_nan=False)
  4. encode('utf-8')；无 BOM；无尾换行

sha256 = hashlib.sha256(canonical_dumps(obj)).hexdigest()
```

## 夹具例外

试点黄潜文件 `ProjectBible_yellow_submarine_4B.0.0.json` 的权威 sha256
`e19a0b4c…f3fa0` 钉的是**磁盘文件原始字节**（pretty-print 含空白）。
`POST /ingest` 若带 `expected_sha256`，对上传 raw / 原文字节校验；
写入后工作副本与 freeze 再哈希时走 `canonical_dumps`。

## 禁止

- 生产路径用 `latest` / 缺省 version 隐式解析版本
- 各端自写 dumps 参数（空白、key 序不一致）
