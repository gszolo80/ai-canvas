#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地出图代理自检：端点 / CORS / 参考图证据 / 上游适配 / 错误路径。

运行： python3 tools/proxy-smoke-test.py
依赖： 仅 Python 标准库。脚本自己起一个假上游 + 一个临时代理进程，跑完自动清理。
"""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urlerror
from urllib import request as urlrequest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY = os.path.join(ROOT, "server", "ai_proxy.py")
PASSED, FAILED = [], []


def ok(name, cond, extra=""):
    (PASSED if cond else FAILED).append(name)
    print(("  ✅ " if cond else "  ❌ ") + name + (("  " + str(extra)) if extra else ""))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def tiny_png(rgb=(9, 47, 136)):
    w = h = 8
    row = b"\x00" + bytes(rgb) * w
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(row * h)) + chunk(b"IEND", b""))


TINY_B64 = base64.b64encode(tiny_png()).decode()
SAW = {"edits": [], "generations": []}


class FakeUpstream(BaseHTTPRequestHandler):
    """假 OpenAI 兼容上游：记录 multipart 是否真的带图，可模拟 /images/edits 不支持。"""
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        is_edits = self.path.endswith("/images/edits")
        SAW["edits" if is_edits else "generations"].append({
            "path": self.path, "body": body, "ctype": self.headers.get("Content-Type", ""),
        })
        if is_edits and b"FORCE_EDIT_405" in body:
            self.send_response(405)
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"edits not supported"}}')
            return
        out = json.dumps({"data": [{"b64_json": TINY_B64}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


# 本机有系统 HTTP_PROXY，测试请求的都是 127.0.0.1，必须绕过
LOCAL_OPENER = urlrequest.build_opener(urlrequest.ProxyHandler({}))


def request(url, obj=None, method=None):
    data = json.dumps(obj).encode("utf-8") if obj is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urlrequest.Request(url, data=data, headers=headers, method=method or ("POST" if data else "GET"))
    try:
        with LOCAL_OPENER.open(req, timeout=30) as r:
            return r.status, dict(r.headers), json.loads(r.read().decode("utf-8") or "{}")
    except urlerror.HTTPError as e:
        try:
            j = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            j = {}
        return e.code, dict(e.headers or {}), j


def main():
    proxy_port, up_port = free_port(), free_port()
    fake = ThreadingHTTPServer(("127.0.0.1", up_port), FakeUpstream)
    fake.daemon_threads = True
    threading.Thread(target=fake.serve_forever, daemon=True).start()

    cfg = {
        "host": "127.0.0.1", "port": proxy_port, "upstream": "mock",
        "allow_upstream_override": True, "max_refs": 4, "max_body_mb": 24,
        "cloud": {"base": "http://127.0.0.1:%d/v1" % up_port, "key": "sk-fake-test",
                  "model": "fake-model", "edit_model": "fake-edit", "supports_edits": True, "timeout": 10},
        "comfy": {"base": "http://127.0.0.1:%d" % free_port(), "workflow": "server/workflows/txt2img.json",
                  "timeout": 5, "poll_interval": 0.2},
    }
    fd, cfg_path = tempfile.mkstemp(suffix=".json", prefix="aicanvas_proxy_test_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False)

    log_path = cfg_path + ".log"
    logf = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, PROXY, "--config", cfg_path],
                            cwd=ROOT, stdout=logf, stderr=subprocess.STDOUT)
    base = "http://127.0.0.1:%d" % proxy_port
    try:
        for _ in range(60):
            try:
                request(base + "/v1/health")
                break
            except Exception:
                time.sleep(0.15)
        else:
            raise RuntimeError("代理没起来")

        print("\n== 1. 健康检查 / CORS ==")
        st, hd, j = request(base + "/v1/health")
        if st != 200:
            print("  [诊断] proxy=%s status=%s body=%s" % (base, st, json.dumps(j, ensure_ascii=False)[:260]))
        ok("GET /v1/health 返回 200", st == 200 and j.get("ok") is True)
        ok("health 不回传 Key 明文", "sk-fake-test" not in json.dumps(j, ensure_ascii=False)
           and j["cloud"]["key_present"] is True, j["cloud"])
        ok("health 标出 cors / upstream / max_refs",
           j.get("cors") is True and j.get("upstream") == "mock" and j.get("max_refs") == 4)
        # 手动发预检（urlopen 不便设 OPTIONS 的 Access-Control-Request-*，直接构造）
        req = urlrequest.Request(base + "/v1/generate", method="OPTIONS",
                                 headers={"Origin": "http://localhost:8123",
                                          "Access-Control-Request-Method": "POST",
                                          "Access-Control-Request-Headers": "content-type"})
        with LOCAL_OPENER.open(req, timeout=10) as r:
            ok("OPTIONS 预检 204 + CORS 头", r.status == 204
               and r.headers.get("Access-Control-Allow-Origin") == "*"
               and "POST" in r.headers.get("Access-Control-Allow-Methods", ""),
               {"status": r.status, "allow": r.headers.get("Access-Control-Allow-Methods")})

        print("\n== 2. mock 上游 + 参考图证据 ==")
        st, _, j = request(base + "/v1/generate", {
            "prompt": "一只橘猫", "size": "1024x1366", "n": 1, "upstream": "mock", "refs": []})
        ok("无参考图：返回有效 PNG", st == 200 and j.get("ok") and len(j["images"]) == 1
           and j["images"][0].startswith("data:image/png;base64,"))
        ok("无参考图：meta.ref_count=0 / refs_used 空",
           j["meta"]["ref_count"] == 0 and j["meta"]["refs_used"] == [] and j["meta"]["simulated"] is True)

        refs = [
            {"role": "style", "name": "FA-001", "dataUrl": "data:image/jpeg;base64," + base64.b64encode(b"STYLE-REF-BYTES").decode()},
            {"role": "layout", "name": "SC-001", "dataUrl": "data:image/webp;base64," + base64.b64encode(b"LAYOUT-REF-BYTES").decode()},
            {"role": "canvas", "name": "画布快照", "dataUrl": "data:image/png;base64," + TINY_B64},
        ]
        st, _, j = request(base + "/v1/generate", {
            "prompt": "一只橘猫", "size": "1024x1366", "upstream": "mock",
            "refs": refs, "options": {"strength": 0.7, "negative": "watermark"}})
        m = j.get("meta") or {}
        ok("带 3 张参考图：200 + 返回图片", st == 200 and j.get("ok") and len(j["images"]) == 1)
        ok("meta.ref_count=3 且 refs_used 三个角色齐全",
           m.get("ref_count") == 3 and m.get("refs_used") == ["style", "layout", "canvas"], m.get("refs_used"))
        ok("meta.ref_bytes 逐张有真实字节数（不是空壳）",
           len(m.get("ref_bytes") or []) == 3 and all(x["size"] > 0 for x in m["ref_bytes"]), m.get("ref_bytes"))
        ok("refs_dropped 为空 + note 明确说明是模拟",
           m.get("refs_dropped") == [] and "不是真出图" in (m.get("note") or ""))

        # 解码自检图，验证色块像素确实按参考图数量画出来
        png = base64.b64decode(j["images"][0].split(",", 1)[1])
        w = struct.unpack(">I", png[16:20])[0]
        h = struct.unpack(">I", png[20:24])[0]
        ok("自检图是合法 PNG 且尺寸随请求", png[:8] == b"\x89PNG\r\n\x1a\n" and w > 0 and h > 0,
           {"w": w, "h": h, "bytes": len(png)})

        print("\n== 3. cloud 上游：参考图真的进 multipart ==")
        st, _, j = request(base + "/v1/generate", {
            "prompt": "一只橘猫", "size": "1024x1024", "upstream": "cloud", "refs": refs[:2]})
        if st != 200:
            print("  [诊断] cloud status=%s body=%s" % (st, json.dumps(j, ensure_ascii=False)[:300]))
            logf.flush()
            print("  [诊断] 代理日志尾部: " + open(log_path, encoding="utf-8").read()[-600:].replace("\n", " | "))
        m = j.get("meta") or {}
        edits = SAW["edits"]
        ok("带图走 /images/edits（不是 generations）",
           st == 200 and len(edits) >= 1 and m.get("upstream_path") == "/images/edits")
        body = edits[-1]["body"] if edits else b""
        ok("multipart 里真带两张参考图字节（可核对）",
           b"STYLE-REF-BYTES" in body and b"LAYOUT-REF-BYTES" in body
           and body.count(b'name="image[]"') == 2, {"multipart_bytes": len(body)})
        ok("cloud 带图：refs_used 有值 / refs_dropped 为空",
           m.get("refs_used") == ["style", "layout"] and m.get("refs_dropped") == [])
        ok("fake 上游 b64_json 被解析回 dataURL",
           j["images"][0].startswith("data:image/png;base64,") and TINY_B64 in j["images"][0])

        st, _, j2 = request(base + "/v1/generate", {
            "prompt": "一只橘猫", "size": "1024x1024", "upstream": "cloud", "refs": []})
        ok("不带图自动走 /images/generations",
           st == 200 and len(SAW["generations"]) >= 1 and j2["meta"]["upstream_path"] == "/images/generations")

        before = len(SAW["generations"])
        st, _, j3 = request(base + "/v1/generate", {
            "prompt": "FORCE_EDIT_405 一只橘猫", "size": "1024x1024", "upstream": "cloud", "refs": refs[:1]})
        m3 = j3.get("meta") or {}
        ok("上游不支持 edits 时诚实降级（并自动补发 generations）",
           st == 200 and len(SAW["generations"]) > before and m3.get("upstream_path") == "/images/generations")
        ok("降级时明确标记 refs_dropped，绝不假装参考图生效",
           m3.get("refs_dropped") == ["style"] and "未进模型" in (m3.get("note") or ""), m3.get("note"))

        print("\n== 4. 错误路径（必须给可操作的中文提示） ==")
        cases = [
            ("空 prompt 400", {"prompt": "", "upstream": "mock"}, 400, "bad_request"),
            ("非法参考图 400", {"prompt": "x", "upstream": "mock",
                                "refs": [{"role": "style", "dataUrl": "not-a-dataurl"}]}, 400, "bad_ref"),
            ("未知上游 400", {"prompt": "x", "upstream": "nope"}, 400, "bad_request"),
            ("comfy 未启动 502", {"prompt": "x", "upstream": "comfy"}, 502, "upstream_unreachable"),
        ]
        for name, payload, status, code in cases:
            st, _, jj = request(base + "/v1/generate", payload)
            ok(name, st == status and (jj.get("error") or {}).get("code") == code,
               {"status": st, "msg": (jj.get("error") or {}).get("message", "")[:70]})
        st, _, j4 = request(base + "/v1/nope", {"x": 1})
        ok("未知端点 404", st == 404 and (j4.get("error") or {}).get("code") == "not_found")

        print("\n== 5. Key 不泄漏到日志 / 响应 ==")
        # health 已验；这里再确认错误响应里也不含 key
        ok("错误响应不含 Key", "sk-fake-test" not in json.dumps(j4, ensure_ascii=False))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        logf.close()
        try:
            with open(log_path, "r", encoding="utf-8") as f:
                out = f.read()
        except Exception:
            out = ""
        # 只把「Key 明文」和「真实图片 base64」算泄漏；错误提示里的 data:image/...;base64,... 是格式说明
        import re
        hits = []
        if "sk-fake-test" in out:
            hits.append("key")
        if re.search(r"data:image/[a-z]+;base64,[A-Za-z0-9+/=]{80,}", out):
            hits.append("image-base64")
        ok("代理进程日志不打印 Key / 图片 base64", not hits,
           ("命中 %s" % hits) if hits else "日志 %d 字" % len(out))
        try:
            os.unlink(log_path)
        except Exception:
            pass
        fake.shutdown()
        try:
            os.unlink(cfg_path)
        except Exception:
            pass

    print("\n通过 %d / %d，失败 %d" % (len(PASSED), len(PASSED) + len(FAILED), len(FAILED)))
    if FAILED:
        print("失败项：" + "、".join(FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
