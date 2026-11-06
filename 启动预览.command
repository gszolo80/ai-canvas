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

# 网页服务已经在跑就跳过启动，但出图代理仍要检查（见下）
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "✅ 预览服务已在运行（PID $(cat "$PIDFILE")）"
else
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
fi

# 等网页端口就绪
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then break; fi
  sleep 0.3
done

# ---- 出图代理一并拉起：一个脚本把网页 + 代理都准备好 ----
PROXY_PORT=9004
PROXY_PIDFILE=".proxy.pid"
PROXY_CFG="server/config.json"
PROXY_HEALTH="http://127.0.0.1:${PROXY_PORT}/v1/health"

if curl -s --noproxy '*' -m 2 -o /dev/null "$PROXY_HEALTH" 2>/dev/null; then
  echo "✅ 出图代理已在运行（端口 ${PROXY_PORT}）"
else
  if [ ! -f "$PROXY_CFG" ]; then
    cp server/config.example.json "$PROXY_CFG"
    printf '📝 已生成 %s（默认 upstream=mock 自检，不消耗积分）\n' "$PROXY_CFG"
  fi
  POLD=$(lsof -ti tcp:${PROXY_PORT} 2>/dev/null)
  if [ -n "$POLD" ]; then
    echo "⚠️  端口 ${PROXY_PORT} 被进程 ${POLD} 占用但健康接口不通，跳过代理启动。"
    echo "   可用「停止出图代理.command」清理后重试。"
  else
    echo "🚀 启动出图代理：http://127.0.0.1:${PROXY_PORT}"
    nohup python3 server/ai_proxy.py --config "$PROXY_CFG" >> ".proxy.log" 2>&1 &
    echo $! > "$PROXY_PIDFILE"
    PROXY_READY=0
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      if curl -s --noproxy '*' -m 2 -o /dev/null "$PROXY_HEALTH" 2>/dev/null; then PROXY_READY=1; break; fi
      sleep 0.3
    done
    if [ "$PROXY_READY" -eq 1 ]; then
      echo "✅ 出图代理已就绪（PID $(cat "$PROXY_PIDFILE")，默认 mock 自检上游）"
    else
      echo "❌ 出图代理启动失败，日志末尾："; tail -12 ".proxy.log"
    fi
  fi
fi

# 无人值守 / 自检时用 AICANVAS_NO_OPEN=1 跳过自动开浏览器
if [ "${AICANVAS_NO_OPEN:-0}" != "1" ]; then open "$URL"; fi
echo ""
echo "✅ 网页 ${URL}   ·   出图代理 127.0.0.1:${PROXY_PORT}"
echo "   默认出图仍是「演示占位图」；点顶栏状态灯即可切到本地代理。"
echo "   此窗口可以直接关闭，服务在后台继续运行。"
echo "   要全部停止：双击「停止预览.command」"
sleep 1
