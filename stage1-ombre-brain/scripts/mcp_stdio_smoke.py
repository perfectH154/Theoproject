#!/usr/bin/env python3
"""最小 stdio MCP smoke test。

用途：
  cd /opt/companion/ombre-brain/app
  python3 /path/to/scripts/mcp_stdio_smoke.py "npm start"

MCP stdio transport 通常是一行一个 JSON-RPC 消息。本脚本按该方式收发。
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
import time
from typing import Any


class McpStdioClient:
    def __init__(self, command: str) -> None:
        self.command = command
        self.next_id = 1
        self.proc = subprocess.Popen(
            command,
            shell=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def request(self, method: str, params: dict[str, Any] | None = None, expect_response: bool = True) -> Any:
        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("子进程 stdio 不可用")

        msg: dict[str, Any] = {
            "jsonrpc": "2.0",
            "method": method,
        }
        wanted_id: int | None = None
        if expect_response:
            wanted_id = self.next_id
            msg["id"] = wanted_id
            self.next_id += 1
        if params is not None:
            msg["params"] = params

        self.proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

        if not expect_response:
            return None

        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                stderr = self.proc.stderr.read() if self.proc.stderr else ""
                raise RuntimeError(f"服务器提前退出，stderr:\n{stderr}")
            try:
                response = json.loads(line)
            except json.JSONDecodeError:
                # 有些 server 会把启动日志误写到 stdout；跳过非 JSON 行。
                continue
            if response.get("id") == wanted_id:
                return response

        raise TimeoutError(f"等待 {method} 响应超时")


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
        print(f"用法：{shlex.quote(sys.argv[0])} <stdio-command>", file=sys.stderr)
        return 2

    client = McpStdioClient(sys.argv[1])
    try:
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
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
