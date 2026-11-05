#!/bin/bash
# ============================================================
#  AI 画布生图 · 一键启动本地预览
#  双击运行：后台起本地服务 + 自动打开浏览器
#  停止请双击「停止预览.command」
# ============================================================

cd "$(dirname "$0")" || exit 1

PORT=8123
PIDFILE=".preview.pid"
URL="http://localhost:${PORT}/"

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 没有找到 python3，请先安装 Python 3。"
  echo "按回车键关闭…"; read -r _; exit 1
fi

# 已经在跑就直接打开网页
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "✅ 预览服务已在运行（PID $(cat "$PIDFILE")），直接打开网页…"
  open "$URL"
  sleep 1
  exit 0
fi

# 端口被旧进程占用，先清理
OLD=$(lsof -ti tcp:${PORT} 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "♻️  端口 ${PORT} 被占用，先关闭旧进程…"
  kill ${OLD} 2>/dev/null
  sleep 0.5
fi

echo "🚀 启动本地预览：${URL}"
nohup python3 -m http.server "${PORT}" --bind 127.0.0.1 > ".preview.log" 2>&1 &
echo $! > "$PIDFILE"

# 等端口就绪再开浏览器
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then break; fi
  sleep 0.3
done

open "$URL"
echo ""
echo "✅ 已启动（PID $(cat "$PIDFILE")）。此窗口可以直接关闭，服务在后台继续运行。"
echo "   要停止：双击「停止预览.command」"
sleep 1
