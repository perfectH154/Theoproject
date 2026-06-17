#!/usr/bin/env python3
"""最小 HTTP MCP smoke test。

用途：
  python3 scripts/mcp_http_smoke.py http://127.0.0.1:8765/mcp

它按 MCP JSON-RPC 流程执行：
  1. initialize
  2. notifications/initialized
  3. tools/list
  4. tools/call pulse
  5. tools/call breath

脚本同时兼容返回 application/json 和 text/event-stream 的 HTTP MCP server。
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from typing import Any


class McpHttpClient:
    def __init__(self, url: str) -> None:
        self.url = url
        self.next_id = 1
        self.session_id: str | None = None

    def request(self, method: str, params: dict[str, Any] | None = None, expect_response: bool = True) -> Any:
        msg: dict[str, Any] = {
            "jsonrpc": "2.0",
            "method": method,
        }
        if expect_response:
            msg["id"] = self.next_id
            self.next_id += 1
        if params is not None:
            msg["params"] = params

        body = json.dumps(msg).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id

        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                if not self.session_id:
                    self.session_id = resp.headers.get("Mcp-Session-Id")
                payload = resp.read().decode("utf-8")
                if not expect_response:
                    return None
                return self._parse_response(payload, resp.headers.get("Content-Type", ""))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc

    @staticmethod
    def _parse_response(payload: str, content_type: str) -> Any:
        if "text/event-stream" in content_type or payload.lstrip().startswith("event:"):
            data_lines: list[str] = []
            for line in payload.splitlines():
                if line.startswith("data:"):
                    data_lines.append(line.removeprefix("data:").strip())
            if not data_lines:
                raise RuntimeError(f"SSE response did not contain data lines: {payload[:300]}")
            return json.loads(data_lines[-1])
        return json.loads(payload)


def require_tool(tools_response: dict[str, Any], name: str) -> None:
    tools = tools_response.get("result", {}).get("tools", [])
    names = {tool.get("name") for tool in tools}
    if name not in names:
        raise RuntimeError(f"tools/list 中没有 {name!r}，实际工具：{sorted(n for n in names if n)}")


def print_result(title: str, response: Any) -> None:
    print(f"\n--- {title} ---")
    print(json.dumps(response, ensure_ascii=False, indent=2))


def main() -> int:
    if len(sys.argv) != 2:
        print("用法：mcp_http_smoke.py <mcp-http-url>", file=sys.stderr)
        return 2

    client = McpHttpClient(sys.argv[1])

    initialize = client.request(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "companion-stage1-smoke", "version": "0.1.0"},
        },
    )
    print_result("initialize", initialize)

    client.request("notifications/initialized", expect_response=False)

    tools = client.request("tools/list")
    print_result("tools/list", tools)
    for name in ("pulse", "breath"):
        require_tool(tools, name)

    pulse = client.request("tools/call", {"name": "pulse", "arguments": {"include_archive": False}})
    print_result("tools/call pulse", pulse)

    breath = client.request(
        "tools/call",
        {
            "name": "breath",
            "arguments": {"query": "", "domain": "", "valence": -1, "arousal": -1},
        },
    )
    print_result("tools/call breath", breath)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
