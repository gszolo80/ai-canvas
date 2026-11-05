#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_assets.py — 从 yang0/handraw-style (MIT, 须保留署名) 拉取真实素材并本地打包。
产出：
  - assets/images/...   仓库全部风格/排版/配色原图（按原路径存放）
  - data.js             解析出的 STYLES / LAYOUTS / COLORS（含本地图片路径与真实提示词）
                        + 保留 FONTS / RATIOS 常量
"""
import re, json, os, urllib.request
from concurrent.futures import ThreadPoolExecutor

REPO = "yang0/handraw-style"
BRANCH = "master"
BASE = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/"
ROOT = "/Users/huangjing/WorkBuddy/2026-11-05-12-55-13/ai-canvas"
OUT = os.path.join(ROOT, "assets")

UA = {"User-Agent": "Mozilla/5.0 (build_assets)"}

def fetch_text(url):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "replace")

def fetch_bytes(url):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=40).read()

def clean(html):
    t = re.sub(r"<br\s*/?>", " ", html)
    t = re.sub(r"<[^>]+>", "", t)
    t = t.replace("`", "")  # 去掉 markdown 代码反引号
    t = re.sub(r"\s+", " ", t).strip()
    return t

def parse(md, src_prefix, idpat):
    items = []
    parts = md.split("<img")
    for p in parts[1:]:
        src_m = re.search(r"src='([^']+)'", p)
        alt_m = re.search(r"alt='([^']+)'", p)
        id_m = re.search(r"\*\*(%s)\*\*" % idpat, p)
        det_m = re.search(r"<details>.*?<summary>[^<]*</summary><br>(.*?)</details>", p, re.DOTALL)
        if not src_m or not id_m:
            continue
        src = src_m.group(1)
        if not src.startswith(src_prefix):
            continue
        name = clean(alt_m.group(1)) if alt_m else ""
        name = re.sub(r"^%s\s*" % re.escape(id_m.group(1)), "", name)
        prompt = clean(det_m.group(1)) if det_m else ""
        items.append({"id": id_m.group(1), "img": "assets/" + src, "name": name, "prompt": prompt})
    # 去重（同一 id 可能出现多次）
    seen = {}
    for it in items:
        seen[it["id"]] = it
    return list(seen.values())

def local_path(repo_path):
    return os.path.join(OUT, repo_path)

def download(repo_path):
    lp = local_path(repo_path)
    if os.path.exists(lp) and os.path.getsize(lp) > 0:
        return
    try:
        data = fetch_bytes(BASE + repo_path)
        os.makedirs(os.path.dirname(lp), exist_ok=True)
        with open(lp, "wb") as f:
            f.write(data)
    except Exception as e:
        print("ERR", repo_path, repr(e))

def main():
    print("fetching markdown...")
    styles_md = fetch_text(BASE + "STYLES.md")
    layouts_md = fetch_text(BASE + "LAYOUTS.md")
    colors_md = fetch_text(BASE + "COLORS.md")

    STYLES = parse(styles_md, "images/individual/", r"[A-Z]{2}-\d{3}")
    LAYOUTS = parse(layouts_md, "images/layouts/", r"[A-Z]{2}-\d{3}")
    COLORS = parse(colors_md, "images/colors/", r"C-\d{2}")
    print("parsed: styles=%d layouts=%d colors=%d" % (len(STYLES), len(LAYOUTS), len(COLORS)))

    imgs = [s["img"][len("assets/"):] for s in STYLES] + \
           [l["img"][len("assets/"):] for l in LAYOUTS] + \
           [c["img"][len("assets/"):] for c in COLORS]
    print("downloading %d images..." % len(imgs))
    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(download, imgs))
    print("download done.")

    FONTS = [
        {"name": "思源黑体", "css": '"Noto Sans SC", sans-serif', "license": "OFL-1.1", "source": "Google Fonts 在线"},
        {"name": "思源宋体", "css": '"Noto Serif SC", serif', "license": "OFL-1.1", "source": "Google Fonts 在线"},
        {"name": "站酷快乐体", "css": '"ZCOOL KuaiLe", cursive', "license": "免费商用", "source": "需本地内置 woff2"},
        {"name": "站酷小薇LOGO体", "css": '"ZCOOL XiaoWei", serif', "license": "免费商用", "source": "需本地内置 woff2"},
        {"name": "阿里普惠体", "css": '"Alibaba PuHuiTi", sans-serif', "license": "免费商用", "source": "需本地内置"},
        {"name": "MiSans", "css": '"MiSans", sans-serif', "license": "免费商用", "source": "需本地内置"},
        {"name": "苹方(系统)", "css": '"PingFang SC", sans-serif', "license": "系统字体", "source": "macOS 内置"},
        {"name": "微软雅黑(系统)", "css": '"Microsoft YaHei", sans-serif', "license": "系统字体", "source": "Windows 内置"},
    ]
    RATIOS = [
        {"id": "3:4", "w": 1024, "h": 1366, "label": "小红书竖版 3:4"},
        {"id": "1:1", "w": 1024, "h": 1024, "label": "方图 1:1"},
        {"id": "16:9", "w": 1280, "h": 720, "label": "题图 16:9"},
        {"id": "9:16", "w": 720, "h": 1280, "label": "竖屏 9:16"},
        {"id": "4:3", "w": 1024, "h": 768, "label": "信息图 4:3"},
    ]

    js_path = os.path.join(ROOT, "data.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("/*\n")
        f.write(" * data.js — AI 画布生图 · 素材库（由 build_assets.py 从 handraw-style 自动生成）\n")
        f.write(" * 授权：风格/排版/配色原图与提示词来源 yang0/handraw-style（MIT，须保留署名）。\n")
        f.write(" * 全量：%d 风格 / %d 排版 / %d 配色。\n" % (len(STYLES), len(LAYOUTS), len(COLORS)))
        f.write(" */\n\n")
        f.write("const STYLES = " + json.dumps(STYLES, ensure_ascii=False) + ";\n\n")
        f.write("const LAYOUTS = " + json.dumps(LAYOUTS, ensure_ascii=False) + ";\n\n")
        f.write("const COLORS = " + json.dumps(COLORS, ensure_ascii=False) + ";\n\n")
        f.write("const FONTS = " + json.dumps(FONTS, ensure_ascii=False) + ";\n\n")
        f.write("const RATIOS = " + json.dumps(RATIOS, ensure_ascii=False) + ";\n")
    print("wrote data.js ->", js_path)

if __name__ == "__main__":
    main()
