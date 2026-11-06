#!/bin/bash
# ============================================================
#  AI 画布生图 · 一键停止本地预览
#  双击运行：关掉后台本地服务
# ============================================================

cd "$(dirname "$0")" || exit 1

PORT=8123
PIDFILE=".preview.pid"
PROXY_PORT=9004
PROXY_PIDFILE=".proxy.pid"
STOPPED=0

# 1) 按记录的 PID 停止
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && echo "🛑 已停止预览服务（PID ${PID}）。"
    STOPPED=1
  fi
  rm -f "$PIDFILE"
fi

# 2) 兜底：按端口清理残留进程
LEFT=$(lsof -ti tcp:${PORT} 2>/dev/null)
if [ -n "$LEFT" ]; then
  kill ${LEFT} 2>/dev/null && echo "🛑 已清理占用端口 ${PORT} 的进程。"
  STOPPED=1
fi

if [ "$STOPPED" -eq 0 ]; then
  echo "ℹ️  预览服务当前没有在运行。"
fi

# 3) 一并停掉出图代理（同一个一键脚本拉起的，就一起收掉）
if [ -f "$PROXY_PIDFILE" ]; then
  PID=$(cat "$PROXY_PIDFILE" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && echo "🛑 已停止出图代理（PID ${PID}）。"
  fi
  rm -f "$PROXY_PIDFILE"
fi

PLEFT=$(lsof -ti tcp:${PROXY_PORT} 2>/dev/null)
if [ -n "$PLEFT" ]; then
  kill ${PLEFT} 2>/dev/null && echo "🛑 已清理占用端口 ${PROXY_PORT} 的进程。"
fi

sleep 1
