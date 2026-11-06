#!/bin/bash
# ============================================================
#  AI 画布生图 · 一键停止本地出图代理
# ============================================================

cd "$(dirname "$0")" || exit 1

PORT=9004
PIDFILE=".proxy.pid"
STOPPED=0

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && echo "🛑 已停止出图代理（PID ${PID}）。"
    STOPPED=1
  fi
  rm -f "$PIDFILE"
fi

# 兜底：按端口清理残留（只清本项目端口 9004）
LEFT=$(lsof -ti tcp:${PORT} 2>/dev/null)
if [ -n "$LEFT" ]; then
  kill ${LEFT} 2>/dev/null && echo "🛑 已清理占用端口 ${PORT} 的进程。"
  STOPPED=1
fi

if [ "$STOPPED" -eq 0 ]; then
  echo "ℹ️  出图代理当前没有在运行。"
fi

sleep 1
