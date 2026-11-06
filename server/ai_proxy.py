#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 画布生图 · 本地出图代理（零第三方依赖，Python 3.8+ 标准库）

职责：
  1. 给网页一个同源可控的 HTTP 端点，统一 CORS 与 OPTIONS 预检；
  2. API Key 只留在服务端 config.json，不进浏览器、不回传、不打印日志；
  3. 统一出图协议 POST /v1/generate，把参考图真正送进能吃图的上游。

上游三种：
  mock  —— 自检用，不消耗积分；回显「收到几张参考图」的可核对证据；
  cloud —— OpenAI 兼容接口；无参考图走 /images/generations，有参考图走 /images/edits（multipart）；
  comfy —— 本地 ComfyUI；参考图 POST /upload/image，按 workflow 模板注入后提交 /prompt 并轮询取图。

重要：参考图有没有真的参与生成，由 meta.refs_used / meta.refs_dropped 明确回报，
      绝不在上游不接图时假装成功。网页会据此提示用户。

启动：python3 server/ai_proxy.py             （默认读 server/config.json，没有就用内置默认）
配置：复制 server/config.example.json 为 server/config.json 后修改。
"""

import argparse
import base64
import json
import os
import re
import struct
import sys
import time
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = "1.0.0"

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 9004,
    # 默认上游。请求体可用 "upstream" 覆盖，除非 allow_upstream_override=false
    "upstream": "mock",
    "allow_upstream_override": True,
    "max_refs": 4,
    "max_body_mb": 24,
    "cloud": {
        "base": "https://ark.cn-beijing.volces.com/api/v3",
        "key": "",
        "model": "doubao-seedream-3.0",
        "edit_model": "gpt-image-1",
        "supports_edits": True,
        "timeout": 120,
    },
    "comfy": {
        "base": "http://127.0.0.1:8188",
        "workflow": "server/workflows/txt2img.json",
        "timeout": 180,
        "poll_interval": 1.0,
    },
}

# 参考图角色 → 自检图里的色块（也用于日志辨识）
ROLE_COLORS = {
    "style": (9, 47, 136),
    "layout": (232, 93, 47),
    "color": (245, 158, 11),
    "character": (34, 139, 87),
    "canvas": (91, 91, 214),
    "custom": (219, 39, 119),
}
DEFAULT_ROLE_COLOR = (100, 116, 139)

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization, x-aicanvas-upstream",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Private-Network": "true",
}


class ProxyError(Exception):
    def __init__(self, message, code="upstream_error", status=502, detail=None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.detail = detail


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def load_config(path):
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if path and os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            user = json.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    elif path:
        log("未找到配置文件 %s，使用内置默认（upstream=mock）" % path)
    return cfg


def cors_headers():
    return dict(CORS)


def parse_size(s, default=(1024, 1024)):
    m = re.match(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$", str(s or ""))
    if not m:
        return default
    return max(64, min(4096, int(m.group(1)))), max(64, min(4096, int(m.group(2))))


DATA_URL_RE = re.compile(r"^data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$", re.S)


def parse_data_url(s):
    """返回 (mime, bytes)。非法格式直接抛错，不静默吞掉。"""
    if not isinstance(s, str):
        raise ProxyError("参考图不是 dataURL 字符串", "bad_ref", 400)
    m = DATA_URL_RE.match(s.strip())
    if not m:
        raise ProxyError("参考图格式不对（应为 data:image/...;base64,...）", "bad_ref", 400)
    mime = m.group(1).lower()
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", m.group(2)), validate=True)
    except Exception:
        raise ProxyError("参考图 base64 解码失败", "bad_ref", 400)
    if not raw:
        raise ProxyError("参考图内容为空", "bad_ref", 400)
    return mime, raw


def to_data_url(mime, raw):
    return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))


def ext_for_mime(mime):
    return {
        "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
        "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp",
    }.get(mime, "png")


# ---------------------------------------------------------------- HTTP 工具
# 本机常设系统 HTTP_PROXY，urllib 会把 127.0.0.1 的请求也转给代理，导致本地
# ComfyUI / 本地假上游收到 502。做法：本地地址一律直连，外网仍尊重环境代理。
_DEFAULT_OPENER = urlrequest.build_opener()
_NO_PROXY_OPENER = urlrequest.build_opener(urlrequest.ProxyHandler({}))
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}


def opener_for(url):
    host = (urlparse.urlparse(url).hostname or "").lower()
    return _NO_PROXY_OPENER if host in _LOCAL_HOSTS or host.startswith("192.168.") else _DEFAULT_OPENER


def http_call(url, data=None, headers=None, method=None, timeout=60, raw=False):
    """返回 (status, headers, body_bytes)。HTTPError 也作为正常返回，交给调用方判断。"""
    req = urlrequest.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with opener_for(url).open(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urlerror.HTTPError as e:
        return e.code, dict(e.headers or {}), e.read()
    except urlerror.URLError as e:
        raise ProxyError("连不上上游 %s：%s" % (urlparse.urlparse(url).netloc, e.reason),
                         "upstream_unreachable", 502)
    except Exception as e:
        raise ProxyError("请求上游异常：%s" % e, "upstream_error", 502)


def json_body(body_bytes):
    try:
        return json.loads(body_bytes.decode("utf-8"))
    except Exception:
        return None


def err_text(body_bytes, limit=400):
    j = json_body(body_bytes)
    if isinstance(j, dict):
        e = j.get("error")
        if isinstance(e, dict):
            return str(e.get("message") or e.get("msg") or j)[:limit]
        if e:
            return str(e)[:limit]
        if j.get("message"):
            return str(j["message"])[:limit]
    try:
        return body_bytes.decode("utf-8", "replace")[:limit]
    except Exception:
        return "(无响应体)"


def multipart(fields, files):
    """fields: [(name, value)]；files: [(name, filename, mime, bytes)]。返回 (content_type, body)。"""
    boundary = "----aicanvas" + uuid.uuid4().hex
    out = bytearray()
    for name, value in fields:
        out += ("--%s\r\n" % boundary).encode()
        out += ('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode()
        out += str(value).encode("utf-8") + b"\r\n"
    for name, filename, mime, raw in files:
        out += ("--%s\r\n" % boundary).encode()
        out += ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
                % (name, filename)).encode()
        out += ("Content-Type: %s\r\n\r\n" % mime).encode()
        out += raw + b"\r\n"
    out += ("--%s--\r\n" % boundary).encode()
    return "multipart/form-data; boundary=%s" % boundary, bytes(out)


def png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def make_mock_png(width, height, roles, variant=0, total=1):
    """自检图：浅底 + 顶部标题条 + 每个收到的参考图一个色块。不含文字，纯像素可核对。

    total > 1 时在底部画 total 个小方块，第 variant 个是深色 —— 多张变体并排时
    能一眼区分，也让「代理确实按 n 生成了多张」这件事有可核对的像素证据。
    """
    bg = (238, 242, 255)
    bar = (49, 62, 110)
    white = (255, 255, 255)
    hbar = max(8, height // 12)
    pad = max(8, width // 40)
    n = max(1, len(roles))
    block_w = max(4, (width - pad * (n + 1)) // n)
    y0 = hbar + (height - hbar) // 3
    y1 = min(height - pad, y0 + max(12, (height - hbar) // 3))
    marker_h = max(3, height // 70)
    marker_w = max(4, width // 24)
    y2 = max(y1, height - pad - marker_h)

    rows = []
    for y in range(height):
        base = bar if y < hbar else bg
        line = bytearray(bytes(base) * width)
        if total > 1 and y2 <= y < y2 + marker_h:
            for i in range(total):
                x0 = pad + i * (marker_w + max(2, pad // 4))
                x1 = min(width, x0 + marker_w)
                if x1 > x0:
                    line[x0 * 3:x1 * 3] = bytes(bar if i == variant else (203, 209, 228)) * (x1 - x0)
        if y0 <= y < y1:
            for i, role in enumerate(roles):
                x0 = pad + i * (block_w + pad)
                x1 = min(width, x0 + block_w)
                if x1 <= x0:
                    continue
                col = ROLE_COLORS.get(role, DEFAULT_ROLE_COLOR)
                line[x0 * 3:x1 * 3] = bytes(col) * (x1 - x0)
                # 色块内留一条白缝，让张数一眼可数
                seam = x0 + max(1, block_w // 12)
                if seam < x1:
                    line[seam * 3:(seam + 1) * 3] = bytes(white)
        rows.append(b"\x00" + bytes(line))
    raw = b"".join(rows)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr)
            + png_chunk(b"IDAT", zlib.compress(raw, 6)) + png_chunk(b"IEND", b""))


# ---------------------------------------------------------------- 参考图
def normalize_refs(payload, cfg):
    max_refs = int(cfg.get("max_refs", 4))
    refs = payload.get("refs") or []
    if not isinstance(refs, list):
        raise ProxyError("refs 必须是数组", "bad_ref", 400)
    out = []
    for i, r in enumerate(refs[:max_refs]):
        if not isinstance(r, dict) or "dataUrl" not in r:
            raise ProxyError("第 %d 张参考图缺少 dataUrl" % (i + 1), "bad_ref", 400)
        mime, raw = parse_data_url(r["dataUrl"])
        out.append({
            "role": str(r.get("role") or "custom"),
            "name": str(r.get("name") or ("ref-%d" % (i + 1)))[:80],
            "mime": mime,
            "bytes": raw,
            "size": len(raw),
        })
    if len(refs) > max_refs:
        log("参考图 %d 张超过上限 %d，只取前 %d 张" % (len(refs), max_refs, max_refs))
    return out


def base_meta(payload, refs):
    return {
        "ref_count": len(refs),
        "ref_bytes": [{"role": r["role"], "name": r["name"], "size": r["size"]} for r in refs],
        "prompt_chars": len(str(payload.get("prompt") or "")),
        "size": str(payload.get("size") or ""),
        "n": max(1, min(4, int(payload.get("n") or 1))),
        "seed": int((payload.get("options") or {}).get("seed") or 0),
        "refs_used": [],
        "refs_dropped": [r["role"] for r in refs],
        "note": "",
    }


# ---------------------------------------------------------------- 上游：mock
def upstream_mock(payload, cfg, refs, meta):
    w, h = parse_size(payload.get("size"))
    # 自检图固定较小尺寸，避免大画幅时逐行拼像素太慢
    w, h = min(w, 768), min(h, 768)
    roles = [r["role"] for r in refs] or []
    count = max(1, min(4, int(payload.get("n") or 1)))
    base_seed = int((payload.get("options") or {}).get("seed") or 0)
    images = [to_data_url("image/png", make_mock_png(w, h, roles, i, count)) for i in range(count)]
    meta["refs_used"] = roles
    meta["refs_dropped"] = []
    meta["simulated"] = True
    meta["variants"] = [{"index": i + 1, "seed": (base_seed + i * 7919) % (2 ** 31)} for i in range(count)]
    meta["note"] = ("mock 上游不是真出图：它只验证『参考图确实送到了服务端』。"
                    "顶部深蓝条 = 收到请求，%d 个色块 = 收到 %d 张参考图，底部方块标出第几张变体。"
                    "切到 cloud / comfy 才会真生成。" % (len(roles), len(roles)))
    return images, meta


# ---------------------------------------------------------------- 上游：cloud
def decode_cloud_images(j, cfg):
    """兼容 b64_json / url，并把远端 url 下载成 dataURL，避免画布被跨域污染。"""
    items = []
    if isinstance(j, dict):
        if isinstance(j.get("data"), list):
            items = j["data"]
        elif isinstance(j.get("images"), list):
            items = j["images"]
        elif isinstance(j.get("output"), dict) and isinstance(j["output"].get("data"), list):
            items = j["output"]["data"]
    out = []
    timeout = int(cfg.get("timeout", 120))
    for it in items[:4]:
        if not isinstance(it, dict):
            continue
        b64 = it.get("b64_json") or it.get("base64")
        if b64:
            out.append("data:image/png;base64," + str(b64).strip())
            continue
        u = it.get("url") or it.get("image_url")
        if isinstance(u, dict):
            u = u.get("url")
        if u:
            st, _, body = http_call(str(u), timeout=timeout)
            if st != 200 or not body:
                raise ProxyError("上游返回了图片链接但下载失败（HTTP %s）" % st, "upstream_error")
            mime = "image/png"
            if body[:3] == b"\xff\xd8\xff":
                mime = "image/jpeg"
            elif body[:4] == b"RIFF" and body[8:12] == b"WEBP":
                mime = "image/webp"
            out.append(to_data_url(mime, body))
    return out


def upstream_cloud(payload, cfg, refs, meta):
    base = str(cfg.get("base") or "").rstrip("/")
    key = str(cfg.get("key") or "")
    if not base:
        raise ProxyError("cloud 上游没配 base（server/config.json → cloud.base）", "config_missing", 500)
    prompt = str(payload.get("prompt") or "")
    model = str(payload.get("model") or cfg.get("model") or "gpt-image-1")
    size = str(payload.get("size") or "1024x1024")
    n = int(payload.get("n") or 1)
    timeout = int(cfg.get("timeout", 120))
    auth = {"Authorization": "Bearer " + key} if key else {}
    note = ""

    if refs and cfg.get("supports_edits", True):
        # 带参考图：走 OpenAI 兼容的 images/edits（multipart），图是真发给模型的
        edit_model = str(cfg.get("edit_model") or "gpt-image-1")
        fields = [("model", edit_model), ("prompt", prompt), ("size", size),
                  ("n", n), ("response_format", "b64_json")]
        files = [("image[]", "ref_%d_%s.%s" % (i + 1, re.sub(r"\W+", "_", r["role"]), ext_for_mime(r["mime"])),
                  r["mime"], r["bytes"]) for i, r in enumerate(refs)]
        ctype, body = multipart(fields, files)
        headers = dict(auth)
        headers["Content-Type"] = ctype
        st, _, raw = http_call(base + "/images/edits", data=body, headers=headers,
                               method="POST", timeout=timeout)
        if st in (404, 405, 501):
            # 上游不支持带图端点：诚实降级，绝不假装参考图生效
            note = ("上游不支持 /images/edits（HTTP %s），已降级为纯文生图；"
                    "参考图未进模型。要真锁风格请改用 comfy + IP-Adapter workflow。" % st)
            log(note)
        elif st != 200:
            raise ProxyError("cloud /images/edits HTTP %s：%s" % (st, err_text(raw)), "upstream_error", 502)
        else:
            j = json_body(raw)
            if j is None:
                raise ProxyError("cloud /images/edits 返回的不是 JSON", "upstream_error", 502)
            imgs = decode_cloud_images(j, cfg)
            meta["refs_used"] = [r["role"] for r in refs]
            meta["refs_dropped"] = []
            meta["upstream_path"] = "/images/edits"
            return imgs, meta
    elif refs:
        note = "配置里 cloud.supports_edits=false，参考图未发送，走纯文生图。"

    # 纯文生图
    body_obj = {"model": model, "prompt": prompt, "n": n, "size": size, "response_format": "b64_json"}
    headers = dict(auth)
    headers["Content-Type"] = "application/json"
    st, _, raw = http_call(base + "/images/generations", data=json.dumps(body_obj).encode("utf-8"),
                           headers=headers, method="POST", timeout=timeout)
    if st != 200:
        raise ProxyError("cloud /images/generations HTTP %s：%s" % (st, err_text(raw)), "upstream_error", 502)
    j = json_body(raw)
    if j is None:
        raise ProxyError("cloud /images/generations 返回的不是 JSON", "upstream_error", 502)
    imgs = decode_cloud_images(j, cfg)
    if not imgs:
        raise ProxyError("cloud 返回里没有图片（既无 b64_json 也无 url）", "upstream_error", 502)
    meta["refs_used"] = []
    meta["refs_dropped"] = [r["role"] for r in refs]
    meta["upstream_path"] = "/images/generations"
    meta["note"] = note or "纯文生图，未发送参考图。"
    return imgs, meta


# ---------------------------------------------------------------- 上游：comfy
def comfy_upload(base, ref, timeout):
    ctype, body = multipart(
        [("overwrite", "true")],
        [("image", "aicanvas_%s_%s.%s" % (re.sub(r"\W+", "_", ref["role"]), uuid.uuid4().hex[:6],
                                           ext_for_mime(ref["mime"])), ref["mime"], ref["bytes"])],
    )
    st, _, raw = http_call(base + "/upload/image", data=body,
                           headers={"Content-Type": ctype}, method="POST", timeout=timeout)
    if st != 200:
        raise ProxyError("ComfyUI 上传参考图失败 HTTP %s：%s" % (st, err_text(raw)), "upstream_error", 502)
    j = json_body(raw) or {}
    return j.get("name") or ""


def load_workflow(cfg):
    p = cfg.get("workflow") or ""
    if not os.path.isabs(p):
        p = os.path.join(ROOT, p)
    if not os.path.isfile(p):
        raise ProxyError("找不到 ComfyUI workflow 模板：%s" % p, "config_missing", 500)
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def fill_workflow(text, payload, first_ref_name, cfg):
    w, h = parse_size(payload.get("size"))
    w = max(64, min(2048, (w // 64) * 64))
    h = max(64, min(2048, (h // 64) * 64))
    opts = payload.get("options") or {}
    repl = {
        "{{PROMPT}}": str(payload.get("prompt") or ""),
        "{{NEGATIVE}}": str(opts.get("negative") or ""),
        "{{WIDTH}}": str(w),
        "{{HEIGHT}}": str(h),
        "{{SEED}}": str(int(opts.get("seed") if opts.get("seed") not in (None, "", -1) else time.time()) % (2 ** 31)),
        "{{REF_IMAGE}}": first_ref_name or "",
        "{{STRENGTH}}": str(float(opts.get("strength") or 0.65)),
    }
    str_keys = {"{{PROMPT}}", "{{NEGATIVE}}", "{{REF_IMAGE}}"}
    for k, v in repl.items():
        # 字符串占位符做 JSON 转义（提示词里常有换行/引号）；数字占位符原样写
        val = json.dumps(str(v), ensure_ascii=False)[1:-1] if k in str_keys else str(v)
        text = text.replace(k, val)
    wf = json.loads(text)
    # 允许模板里写 "_说明" 之类的注释键，提交给 ComfyUI 前剔掉
    if isinstance(wf, dict):
        for k in [k for k in wf if str(k).startswith("_")]:
            wf.pop(k, None)
    return wf, (w, h)


def upstream_comfy(payload, cfg, refs, meta):
    base = str(cfg.get("base") or "http://127.0.0.1:8188").rstrip("/")
    timeout = int(cfg.get("timeout", 180))
    poll = float(cfg.get("poll_interval", 1.0))

    # 先探活，避免提交后才发现没开 ComfyUI
    st, _, _ = http_call(base + "/system_stats", timeout=5)
    if st != 200:
        raise ProxyError("未检测到本地 ComfyUI（%s /system_stats HTTP %s）。先启动 ComfyUI 或改用 mock / cloud。"
                         % (base, st), "upstream_unreachable", 502)

    uploaded = []
    for r in refs:
        name = comfy_upload(base, r, 30)
        if name:
            uploaded.append((r, name))
    raw_tpl = load_workflow(cfg)
    has_ref_slot = "{{REF_IMAGE}}" in raw_tpl
    workflow, (w, h) = fill_workflow(raw_tpl, payload, uploaded[0][1] if uploaded else "", cfg)

    body = json.dumps({"prompt": workflow, "client_id": "aicanvas-" + uuid.uuid4().hex[:8]}).encode("utf-8")
    st, _, raw = http_call(base + "/prompt", data=body, headers={"Content-Type": "application/json"},
                           method="POST", timeout=30)
    if st != 200:
        raise ProxyError("ComfyUI /prompt HTTP %s：%s" % (st, err_text(raw)), "upstream_error", 502)
    j = json_body(raw) or {}
    pid = j.get("prompt_id")
    if not pid:
        raise ProxyError("ComfyUI 没返回 prompt_id：%s" % err_text(raw), "upstream_error", 502)

    deadline = time.time() + timeout
    history = None
    while time.time() < deadline:
        st, _, hraw = http_call(base + "/history/" + urlparse.quote(str(pid)), timeout=15)
        if st == 200:
            hj = json_body(hraw) or {}
            rec = hj.get(str(pid))
            if rec and rec.get("outputs"):
                history = rec
                break
        time.sleep(poll)
    if not history:
        raise ProxyError("ComfyUI 生成超时（%ss），可在 config.json 调 comfy.timeout" % timeout, "upstream_timeout", 504)

    images = []
    for node in history["outputs"].values():
        for im in (node.get("images") or []):
            q = urlparse.urlencode({"filename": im.get("filename", ""),
                                    "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
            st, _, body = http_call(base + "/view?" + q, timeout=60)
            if st == 200 and body:
                mime = "image/png"
                if body[:3] == b"\xff\xd8\xff":
                    mime = "image/jpeg"
                elif body[:4] == b"RIFF" and body[8:12] == b"WEBP":
                    mime = "image/webp"
                images.append(to_data_url(mime, body))
    if not images:
        raise ProxyError("ComfyUI 完成但没取到图片（检查 SaveImage/PreviewImage 节点）", "upstream_error", 502)

    if has_ref_slot and uploaded:
        meta["refs_used"] = [r["role"] for r, _ in uploaded]
        meta["refs_dropped"] = []
        meta["note"] = ("参考图已上传 ComfyUI 并注入 workflow 的 {{REF_IMAGE}} 槽位"
                        "（%s），由你的 IPAdapter/ControlNet 节点真正参与生成。" % uploaded[0][1])
    else:
        meta["refs_used"] = []
        meta["refs_dropped"] = [r["role"] for r, _ in uploaded]
        meta["note"] = ("参考图已上传到 ComfyUI（%d 张），但当前 workflow 模板没有 {{REF_IMAGE}} 槽位，"
                        "图没有接进 IPAdapter/ControlNet 节点，未参与生成。"
                        "请换用含该占位符的 workflow 模板。" % len(uploaded))
    meta["comfy_prompt_id"] = pid
    meta["comfy_size"] = "%dx%d" % (w, h)
    return images, meta


def upstream_comfy_multi(payload, cfg, refs, meta, count):
    """ComfyUI 一次只出一个 batch；要 n 张不同变体就按不同 seed 提交 n 次再汇总。

    每次都重新上传参考图（慢一点但每张都真的吃了图），meta 里逐张记录 prompt_id。
    """
    if count <= 1:
        return upstream_comfy(payload, cfg, refs, meta)
    base_seed = int((payload.get("options") or {}).get("seed") or time.time())
    images, ids, seeds = [], [], []
    last = {}
    for i in range(count):
        p2 = dict(payload)
        o2 = dict(payload.get("options") or {})
        o2["seed"] = (base_seed + i * 7919) % (2 ** 31)
        p2["options"] = o2
        imgs, last = upstream_comfy(p2, cfg, refs, dict(meta))
        images.extend(imgs)
        seeds.append(o2["seed"])
        ids.append(last.get("comfy_prompt_id") or "")
    for k in ("refs_used", "refs_dropped", "note", "comfy_size"):
        if k in last:
            meta[k] = last[k]
    meta["comfy_prompt_ids"] = ids
    meta["variants"] = [{"index": i + 1, "seed": s} for i, s in enumerate(seeds)]
    return images, meta


# ---------------------------------------------------------------- Handler
class Handler(BaseHTTPRequestHandler):
    server_version = "AICanvasProxy/" + VERSION

    def log_message(self, fmt, *args):
        # 默认日志会打印完整 URL（可能带敏感参数），这里只留方法与路径
        try:
            log("%s %s" % (self.command, urlparse.urlparse(self.path).path))
        except Exception:
            pass

    def _send(self, status, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        # 预检响应不带 body，避免 204 带内容被浏览器判为异常
        self.send_response(204)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        p = urlparse.urlparse(self.path).path.rstrip("/") or "/"
        if p in ("/v1/health", "/health", "/"):
            cfg = self.server.cfg
            cloud, comfy = cfg["cloud"], cfg["comfy"]
            self._send(200, {
                "ok": True, "service": "ai-canvas-proxy", "version": VERSION,
                "upstream": cfg["upstream"],
                "allow_upstream_override": bool(cfg.get("allow_upstream_override", True)),
                "max_refs": cfg.get("max_refs", 4),
                "cloud": {"base": cloud.get("base"), "model": cloud.get("model"),
                          "edit_model": cloud.get("edit_model"),
                          "supports_edits": bool(cloud.get("supports_edits", True)),
                          "key_present": bool(cloud.get("key"))},
                "comfy": {"base": comfy.get("base"), "workflow": comfy.get("workflow")},
                "cors": True, "server_time": time.strftime("%Y-%m-%d %H:%M:%S"),
            })
        else:
            self._send(404, {"ok": False, "error": {"code": "not_found", "message": "没有这个端点：" + p}})

    def do_POST(self):
        t0 = time.time()
        p = urlparse.urlparse(self.path).path.rstrip("/") or "/"
        if p not in ("/v1/generate", "/generate"):
            self._send(404, {"ok": False, "error": {"code": "not_found", "message": "没有这个端点：" + p}})
            return
        cfg = self.server.cfg
        try:
            limit = int(cfg.get("max_body_mb", 24)) * 1024 * 1024
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                raise ProxyError("请求体 %d MB 超过上限 %d MB" % (n // 1048576, limit // 1048576),
                                 "body_too_large", 413)
            raw = self.rfile.read(n) if n else b""
            payload = json_body(raw)
            if not isinstance(payload, dict):
                raise ProxyError("请求体必须是 JSON 对象", "bad_request", 400)
            prompt = str(payload.get("prompt") or "").strip()
            if not prompt:
                raise ProxyError("prompt 不能为空", "bad_request", 400)

            # 一次出图张数：1..4，网页端与三个上游统一按这个值走
            count = max(1, min(4, int(payload.get("n") or 1)))
            payload["n"] = count
            refs = normalize_refs(payload, cfg)
            upstream = str(payload.get("upstream") or cfg["upstream"]).lower()
            if upstream != cfg["upstream"] and not cfg.get("allow_upstream_override", True):
                upstream = cfg["upstream"]
            if upstream not in ("mock", "cloud", "comfy"):
                raise ProxyError("未知上游：%s（可用 mock / cloud / comfy）" % upstream, "bad_request", 400)

            meta = base_meta(payload, refs)
            meta["upstream"] = upstream
            log("generate upstream=%s refs=%d roles=%s" % (upstream, len(refs),
                ",".join(r["role"] for r in refs) or "-"))

            if upstream == "mock":
                images, meta = upstream_mock(payload, cfg, refs, meta)
            elif upstream == "cloud":
                images, meta = upstream_cloud(payload, cfg["cloud"], refs, meta)
            else:
                images, meta = upstream_comfy_multi(payload, cfg["comfy"], refs, meta, count)

            if not images:
                raise ProxyError("上游没返回任何图片", "upstream_error", 502)
            if len(images) < count:
                meta["note"] = ((meta.get("note") or "") +
                                " 上游只返回 %d/%d 张（n=%d 未被完整支持），已按实际张数展示，不复制充数。"
                                % (len(images), count, count))
            meta["elapsed_ms"] = int((time.time() - t0) * 1000)
            self._send(200, {"ok": True, "images": images, "meta": meta})
            log("done images=%d used=%s dropped=%s %dms" % (
                len(images), ",".join(meta.get("refs_used") or []) or "-",
                ",".join(meta.get("refs_dropped") or []) or "-", meta["elapsed_ms"]))
        except ProxyError as e:
            log("ERROR [%s] %s" % (e.code, e.message))
            self._send(e.status, {"ok": False, "error": {"code": e.code, "message": e.message,
                                                          "detail": e.detail}})
        except Exception as e:
            log("ERROR unexpected %s: %s" % (type(e).__name__, e))
            self._send(500, {"ok": False, "error": {"code": "internal_error", "message": str(e)}})


def main():
    ap = argparse.ArgumentParser(description="AI 画布生图 · 本地出图代理")
    ap.add_argument("--config", default=os.path.join(ROOT, "server", "config.json"))
    ap.add_argument("--host", default=None)
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--upstream", default=None, choices=["mock", "cloud", "comfy"])
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = args.port
    if args.upstream:
        cfg["upstream"] = args.upstream

    srv = ThreadingHTTPServer((cfg["host"], int(cfg["port"])), Handler)
    srv.daemon_threads = True
    srv.cfg = cfg
    log("已启动 http://%s:%s  upstream=%s  config=%s"
        % (cfg["host"], cfg["port"], cfg["upstream"], args.config))
    log("健康检查：curl http://%s:%s/v1/health" % (cfg["host"], cfg["port"]))
    if cfg["upstream"] == "cloud" and not cfg["cloud"].get("key"):
        log("⚠ cloud.key 为空：上游可能返回 401。请在 server/config.json 填 Key。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("已停止")
    finally:
        srv.server_close()


if __name__ == "__main__":
    sys.exit(main())
