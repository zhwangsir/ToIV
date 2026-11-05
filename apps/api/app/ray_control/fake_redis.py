"""Minimal in-memory Redis stand-in for scratch stubs (no network)."""

from __future__ import annotations

import json
from typing import Any, MutableMapping


class FakeRedis(MutableMapping[str, Any]):
    """Supports string KV + hash/set/list ops used by registry/echo/scheduler."""

    def __init__(self) -> None:
        self._kv: dict[str, Any] = {}
        self._hashes: dict[str, dict[str, str]] = {}

    def __getitem__(self, key: str) -> Any:
        return self._kv[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self._kv[key] = value

    def __delitem__(self, key: str) -> None:
        del self._kv[key]

    def __iter__(self):
        return iter(self._kv)

    def __len__(self) -> int:
        return len(self._kv)

    def hset(self, name: str, mapping: dict[str, Any] | None = None, **kwargs: Any) -> int:
        h = self._hashes.setdefault(name, {})
        data = dict(mapping or {})
        data.update(kwargs)
        for k, v in data.items():
            h[k] = v if isinstance(v, str) else json.dumps(v, default=str)
        return len(data)

    def hgetall(self, name: str) -> dict[str, str]:
        return dict(self._hashes.get(name, {}))

    def hget(self, name: str, key: str) -> str | None:
        return self._hashes.get(name, {}).get(key)

    def delete(self, *names: str) -> int:
        n = 0
        for name in names:
            if name in self._kv:
                del self._kv[name]
                n += 1
            if name in self._hashes:
                del self._hashes[name]
                n += 1
        return n

    def sadd(self, key: str, *members: str) -> int:
        bag = self._kv.setdefault(key, set())
        if not isinstance(bag, set):
            bag = set(bag)
            self._kv[key] = bag
        before = len(bag)
        bag.update(members)
        return len(bag) - before

    def smembers(self, key: str) -> set[str]:
        bag = self._kv.get(key, set())
        return set(bag) if bag else set()

    def srem(self, key: str, *members: str) -> int:
        bag = self._kv.get(key)
        if not isinstance(bag, set):
            return 0
        n = 0
        for m in members:
            if m in bag:
                bag.remove(m)
                n += 1
        return n

    def _list(self, key: str) -> list[str]:
        bag = self._kv.setdefault(key, [])
        if not isinstance(bag, list):
            bag = list(bag)
            self._kv[key] = bag
        return bag

    def rpush(self, key: str, *values: str) -> int:
        lst = self._list(key)
        lst.extend(str(v) for v in values)
        return len(lst)

    def lpush(self, key: str, *values: str) -> int:
        lst = self._list(key)
        for v in reversed(values):
            lst.insert(0, str(v))
        return len(lst)

    def lpop(self, key: str) -> str | None:
        lst = self._kv.get(key)
        if not isinstance(lst, list) or not lst:
            return None
        return lst.pop(0)

    def rpop(self, key: str) -> str | None:
        lst = self._kv.get(key)
        if not isinstance(lst, list) or not lst:
            return None
        return lst.pop()

    def llen(self, key: str) -> int:
        lst = self._kv.get(key)
        return len(lst) if isinstance(lst, list) else 0

    def lrange(self, key: str, start: int, end: int) -> list[str]:
        lst = self._kv.get(key)
        if not isinstance(lst, list):
            return []
        if end == -1:
            return list(lst[start:])
        return list(lst[start : end + 1])

