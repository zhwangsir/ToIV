"""联网搜索(web_search 工具执行器;2026-08-19,子 Agent 深度调研配套)。

实现:DuckDuckGo HTML 端点(html.duckduckgo.com/html/)——免 API key、无配额,
解析结果页的标题/摘要/链接,取 top N 拼成给 LLM 的文本块。

设计约束:
- 纯出站 HTTP(httpx.AsyncClient),超时 12s,失败返回友好文本不抛异常
  (agent 上下文里工具失败 = 文本告知 LLM,见 runner 原则 7);
- 结果只保留 title/snippet/url,不抓正文(控制上下文体量;深挖由 LLM 多轮
  换关键词查询完成,每轮 query 独立);
- 关闭键:settings.web_search_enabled=False 时返回未启用文本。
"""
from __future__ import annotations

import html as html_mod
import logging
import re

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

# DDG HTML 结果行模式(class="result__a" 标题链接 / result__snippet 摘要)
_TITLE_RE = re.compile(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_SNIPPET_RE = re.compile(r'class="result__snippet"[^>]*>(.*?)</a?>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def _strip(h: str) -> str:
    return html_mod.unescape(_TAG_RE.sub("", h)).strip()


def _clean_url(u: str) -> str:
    """DDG 跳转链接(/l/?uddg=<urlencoded>)还原真实 URL。"""
    if "uddg=" in u:
        from urllib.parse import parse_qs, unquote

        qs = parse_qs(u.split("?", 1)[1] if "?" in u else "")
        if qs.get("uddg"):
            return unquote(qs["uddg"][0])
    return u


async def duckduckgo_search(query: str, k: int = 5, timeout: float = 12.0) -> list[dict]:
    """返回 [{title, snippet, url}];网络失败/无结果返回空列表(不抛)。

    国内环境 DDG 直连不可达时,配置 TOIV_WEB_SEARCH_PROXY(如 http://127.0.0.1:7897)
    走出站代理。
    """
    if not query.strip():
        return []
    proxy = get_settings().web_search_proxy or None
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=timeout, proxy=proxy,
            headers={"User-Agent": "Mozilla/5.0 (compatible; ToIV-Agent/1.0)"},
        ) as cli:
            rsp = await cli.post(
                "https://html.duckduckgo.com/html/",
                data={"q": query, "kl": "wt-wt"},
            )
            rsp.raise_for_status()
    except httpx.HTTPError as e:
        logger.warning("websearch.fail: q_len=%d err=%s", len(query), e)
        return []

    titles = [(m.group(1), _strip(m.group(2))) for m in _TITLE_RE.finditer(rsp.text)]
    snippets = [_strip(m.group(1)) for m in _SNIPPET_RE.finditer(rsp.text)]
    out: list[dict] = []
    for i, (href, title) in enumerate(titles[:k]):
        out.append({
            "title": title,
            "snippet": snippets[i] if i < len(snippets) else "",
            "url": _clean_url(href),
        })
    return out


async def exec_web_search(args: dict, pool, user, session, attachment: dict | None = None):
    """web_search 工具执行器(签名与 tools.exec_* 一致,经 _wrap 接入)。"""
    if not get_settings().web_search_enabled:
        return "联网搜索未启用(TOIV_WEB_SEARCH_ENABLED=false)。", []
    query = (args.get("query") or "").strip()
    if not query:
        return "缺少 query 参数。", []
    k = max(1, min(int(args.get("k") or 5), 8))
    hits = await duckduckgo_search(query, k=k)
    if not hits:
        return f"「{query}」未搜到结果(或网络不可达)。可换个关键词重试。", []
    body = "\n\n".join(
        f"[{i}] {h['title']}\n{h['snippet']}\n来源: {h['url']}" for i, h in enumerate(hits, 1)
    )
    return f"联网搜索「{query}」top {len(hits)}:\n\n{body}", []
