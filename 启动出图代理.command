#!/bin/bash
# ============================================================
#  AI 画布生图 · 一键启动本地出图代理
#  双击运行：后台起 127.0.0.1:9004，自动检查健康状态
#  停止请双击「停止出图代理.command」
# ============================================================

cd "$(dirname "$0")" || exit 1

PORT=9004
PIDFILE=".proxy.pid"
LOGFILE=".proxy.log"
CFG="server/config.json"
URL="http://127.0.0.1:${PORT}/v1/health"

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 没有找到 python3，请先安装 Python 3。"
  echo "按回车键关闭…"; read -r _; exit 1
fi

# 首次使用：从样例生成配置（config.json 已被 .gitignore 忽略，不会进 git）
if [ ! -f "$CFG" ]; then
  cp server/config.example.json "$CFG"
  printf '📝 已生成 %s（默认 upstream=mock 自检模式，不消耗积分）\n' "$CFG"
  echo "   要出真图：编辑该文件填 cloud.key，并把 upstream 改成 cloud 或 comfy。"
fi

# 已经在跑就直接体检
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "✅ 出图代理已在运行（PID $(cat "$PIDFILE")），状态："
  curl -s --noproxy '*' "$URL"; echo
  echo "按回车键关闭…"; read -r _; exit 0
fi

# 端口被别的进程占用：不擅自 kill，避免误杀用户其它服务
OLD=$(lsof -ti tcp:${PORT} 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "⚠️  端口 ${PORT} 已被进程 ${OLD} 占用，但没有对应的 ${PIDFILE}。"
  echo "   请先双击「停止出图代理.command」，或手动确认该进程后再重试。"
  echo "按回车键关闭…"; read -r _; exit 1
fi

echo "🚀 启动本地出图代理：http://127.0.0.1:${PORT}"
nohup python3 server/ai_proxy.py --config "$CFG" >> "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

# 等健康接口就绪
READY=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -s --noproxy '*' -o /dev/null "$URL" 2>/dev/null; then READY=1; break; fi
  sleep 0.3
done

if [ "$READY" -eq 1 ]; then
  echo "✅ 已启动（PID $(cat "$PIDFILE")）。当前配置："
  curl -s --noproxy '*' "$URL" | python3 -m json.tool 2>/dev/null || curl -s --noproxy '*' "$URL"
  echo ""
  echo "📌 网页里：⚙ 设置 → 出图后端 → 模式选「本地代理」→ 测试连接 → 保存。"
  echo "   默认是 mock 自检（不消耗积分，画布会出现带色块的回执图）。"
  echo "   要出真图请改 $CFG 的 upstream / cloud.key 后重启本脚本。"
  # 无人值守 / 自检时可用 AICANVAS_NO_OPEN=1 跳过自动开浏览器
  if [ "${AICANVAS_NO_OPEN:-0}" != "1" ]; then open "$URL"; fi
else
  echo "❌ 启动失败，日志末尾："
  tail -20 "$LOGFILE"
fi

echo ""
echo "   日志：$LOGFILE   停止：双击「停止出图代理.command」"
sleep 2
