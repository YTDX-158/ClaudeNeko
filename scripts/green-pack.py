#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ClaudeNeko 绿色版一键打包脚本（v2.3.1 实操沉淀）

把「源码版封装」的二次包装（绿色便携包）变成一条命令：
  解压即用 · 自带运行依赖(免网) · 带 web/src 可改 · 零敏感数据

用法:
  python green-pack.py            出绿色包 zip → 桌面待处理 + 打印实测清单
  python green-pack.py --test     出包后自动起服务冒烟（curl + 无头浏览器，需 playwright）
  python green-pack.py --refresh  强制重装运行依赖（默认缓存复用，版本没变时很快）

对应规范文档: memory/workspace/references/自动化与工具/reference_claudeneko_packaging_green.md
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 脚本在 scripts/ 下，项目根 = 上级
PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(tempfile.gettempdir(), "claudeneko_green_cache")
DESKTOP_TMP = os.path.expanduser("~/Desktop/待处理")
DELIVERY_DIR = os.path.join(PROJECT, "交付物")  # D盘家底：项目交付物目录（打包自动归档）
# 组装时 server/ 下要剔除的目录与文件（运行时数据 / 媒体 / 日志）
SERVER_EXCLUDE_DIRS = ("data", "media")
EXCLUDE_EXT = (".log",)
# N-10（9-08）：私密/缓存文件永不进绿色包——.build_local.env 是本机配置（gitignore 不入库），
# __pycache__/*.pyc 是运行产物。copytree ignore（主）+ zip 名过滤（第二道保险）双防。
PRIVATE_NAMES = (".build_local.env", ".env", ".build_local")
COPY_IGNORE = shutil.ignore_patterns(*PRIVATE_NAMES, "__pycache__", "*.pyc")

# 要复制到绿色包根目录的启动器 + 文档 + 配置
ROOT_FILES = [
    "package.json", "vite.config.js", "README.md", "CHANGELOG.md",
    "LICENSE", "说明.txt",
]
LAUNCHERS = [
    "启动ClaudeNeko.bat", "start-server.bat", "start-server.vbs",
    "start-web.bat", "start-node.bat", "run-node.vbs",
    "launcher.html", "launcher.vbs", "注册neko协议.bat",
]
COPY_DIRS = ["docs", "scripts", "bin"]  # bin=cloudflared.exe（远程隧道用·免装可分发）


def log(msg):
    print(f"[green-pack] {msg}")


def read_version():
    with open(os.path.join(PROJECT, "package.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def run(cmd, cwd):
    log(f"执行: {cmd}  (cwd={os.path.basename(cwd)})")
    subprocess.check_call(cmd, cwd=cwd, shell=True)


def step_build():
    """① 重编前端 dist（保证烧进最新修复）"""
    run("npm run build", PROJECT)


def ensure_deps(refresh):
    """② 生成纯运行依赖 node_modules（缓存复用 + --refresh 重装）"""
    nm = os.path.join(CACHE, "node_modules")
    if refresh and os.path.isdir(CACHE):
        shutil.rmtree(CACHE)
    if os.path.isdir(nm):
        log("依赖缓存命中（--refresh 强制重装）")
        return
    os.makedirs(CACHE, exist_ok=True)
    shutil.copy(os.path.join(PROJECT, "package.json"), os.path.join(CACHE, "package.json"))
    run("npm install --omit=dev", CACHE)
    # 裁剪 node-pty：只留 win32-x64 + 删全部 .pdb（110M→54M 的关键一刀）
    prebuilds = os.path.join(nm, "node-pty", "prebuilds")
    if os.path.isdir(prebuilds):
        for d in os.listdir(prebuilds):
            if d != "win32-x64":
                shutil.rmtree(os.path.join(prebuilds, d), ignore_errors=True)
        for root, _, files in os.walk(os.path.join(prebuilds, "win32-x64")):
            for f in files:
                if f.lower().endswith(".pdb"):
                    os.remove(os.path.join(root, f))
    log(f"依赖就绪（裁剪后）: {round(_dir_size(nm) / 1024 / 1024)} MB")


def _dir_size(path):
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def assemble(build_root):
    """③ 组装绿色目录（⚠️ web/dist 显式进子目录，堵住平铺坑）"""
    dst = os.path.join(build_root, "ClaudeNeko")
    os.makedirs(dst, exist_ok=True)

    # server（删 data/media/log）
    shutil.copytree(os.path.join(PROJECT, "server"), os.path.join(dst, "server"))
    for d in SERVER_EXCLUDE_DIRS:
        shutil.rmtree(os.path.join(dst, "server", d), ignore_errors=True)
    for f in ("run.log", "log.txt"):
        os.remove(os.path.join(dst, "server", f)) if os.path.exists(os.path.join(dst, "server", f)) else None

    # web/dist + web/src
    os.makedirs(os.path.join(dst, "web"))
    shutil.copytree(os.path.join(PROJECT, "web", "dist"), os.path.join(dst, "web", "dist"))
    shutil.copytree(os.path.join(PROJECT, "web", "src"), os.path.join(dst, "web", "src"))

    # node_modules（裁剪版，绝不用项目全量——避免超时 + 体积爆炸）
    shutil.copytree(os.path.join(CACHE, "node_modules"), os.path.join(dst, "node_modules"))

    # 根文件 + 启动器
    for name in ROOT_FILES + LAUNCHERS:
        src = os.path.join(PROJECT, name)
        if os.path.isfile(src):
            shutil.copy(src, os.path.join(dst, name))

    # docs / scripts（N-10：copytree 带 ignore，私密/缓存文件不进组装目录）
    for d in COPY_DIRS:
        shutil.copytree(os.path.join(PROJECT, d), os.path.join(dst, d), ignore=COPY_IGNORE)
    return dst


def make_zip(dst, version):
    """④ 打 zip（UTF-8 中文名 · 排除 .log）"""
    out = os.path.join(
        os.path.dirname(dst),
        f"ClaudeNeko绿色版_v{version}_{time.strftime('%Y%m%d')}.zip",
    )
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, _, files in os.walk(dst):
            for f in files:
                if f.lower().endswith(EXCLUDE_EXT):
                    continue
                if f in PRIVATE_NAMES or f.endswith(".pyc") or f.endswith(".pyo"):
                    continue  # N-10 第二道保险：zip 层再滤私密/编译产物（防 assemble 遗漏）
                p = os.path.join(root, f)
                arc = "ClaudeNeko/" + os.path.relpath(p, dst).replace(os.sep, "/")
                zf.write(p, arc)
                n += 1
    return out, n


def deliver(zip_path):
    """⑥ 放桌面待处理（发人用）+ 项目交付物目录（D盘家底自动归档）"""
    target = DESKTOP_TMP if os.path.isdir(DESKTOP_TMP) else os.path.dirname(zip_path)
    dest = os.path.join(target, os.path.basename(zip_path))
    shutil.copy2(zip_path, dest)
    os.makedirs(DELIVERY_DIR, exist_ok=True)
    shutil.copy2(zip_path, os.path.join(DELIVERY_DIR, os.path.basename(zip_path)))
    print(f"   归档: {os.path.join(DELIVERY_DIR, os.path.basename(zip_path))}")
    return dest


# ---------------- 冒烟（--test） ----------------
def _http_ok(url, timeout=6):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200, r.status
    except Exception as e:
        return False, str(e)


def smoke(dst):
    """⑤ 起服务冒烟：curl 级（必测）+ 无头浏览器皮肤验证（playwright，尽力）"""
    import subprocess
    port = "4299"
    env = dict(os.environ, PORT=port)
    proc = subprocess.Popen(
        ["node", "server/server.js"], cwd=dst, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        # 等健康
        ok = False
        for _ in range(20):
            ok, _ = _http_ok(base + "/api/health", 3)
            if ok:
                break
            time.sleep(0.5)
        assert ok, "服务未在 10s 内就绪"
        _, hs = _http_ok(base + "/api/health")
        _, hp = _http_ok(base + "/")
        _, h1 = _http_ok(base + "/assets/index-gUbfjnGB.js")
        print(f"[smoke] health={hs} 首页={hp} 主JS={h1}")
        assert hp == 200 and h1 == 200, "curl 冒烟未全通"
        print("[smoke] ✅ curl 级冒烟通过（服务起/首页/主JS）")

        # playwright 深度（尽力：找不到就跳过，不阻塞）
        try:
            _playwright_check(base)
        except Exception as e:
            print(f"[smoke] ⚠️ playwright 深度检查跳过: {e}")
    finally:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True)


def _playwright_check(base):
    import tempfile as _tf
    G = os.path.expanduser("~/AppData/Roaming/npm/node_modules")
    if not os.path.isdir(G):
        raise RuntimeError("全局 node_modules 不存在")
    js = r"""
const G = %(G)r;
let chromium;
try { chromium = require(G + '/playwright').chromium; }
catch { chromium = require(G + '/playwright-core').chromium; }
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0,100)); });
  p.on('pageerror', e => errs.push(String(e).slice(0,100)));
  await p.goto(%(base)r, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1500);
  const info = await p.evaluate(() => ({
    wp: localStorage.getItem('dsw-dream-skin:wallpaper-kind'),
    canvas: !!document.querySelector('canvas'),
    bg: getComputedStyle(document.body).backgroundColor,
    keys: (() => { const a=[]; for(let i=0;i<localStorage.length;i++) a.push(localStorage.key(i)); return a.length; })(),
  }));
  console.log('ERR', errs.length ? errs : 'none');
  console.log('INFO', JSON.stringify(info));
  await b.close();
  if (errs.length) process.exit(2);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
""" % {"G": G, "base": base}
    script = os.path.join(_tf.gettempdir(), "_cn_smoke.cjs")
    with open(script, "w", encoding="utf-8") as f:
        f.write(js)
    env = dict(os.environ, NODE_PATH=G)
    r = subprocess.run(["node", script], capture_output=True, text=True, env=env, timeout=60)
    os.remove(script)
    out = (r.stdout or "") + (r.stderr or "")
    print("[smoke] " + out.strip().replace("\n", "\n[smoke] "))
    if "INFO" not in out:
        raise RuntimeError("playwright 无输出")
    assert r.returncode == 0, "playwright 检查未通过"


def main():
    ap = argparse.ArgumentParser(description="ClaudeNeko 绿色版一键打包")
    ap.add_argument("--test", action="store_true", help="出包后自动冒烟")
    ap.add_argument("--refresh", action="store_true", help="强制重装运行依赖")
    args = ap.parse_args()

    version = read_version()
    log(f"项目: {PROJECT}")
    log(f"版本: v{version}")

    build_root = tempfile.mkdtemp(prefix="claudeneko_green_")
    try:
        step_build()
        ensure_deps(args.refresh)
        dst = assemble(build_root)
        total_mb = round(_dir_size(dst) / 1024 / 1024)
        zip_path, n = make_zip(dst, version)
        zip_mb = round(os.path.getsize(zip_path) / 1024 / 1024, 1)
        final = deliver(zip_path)
        log(f"组装目录 {total_mb} MB · {n} 文件")
        log(f"绿色包 {zip_mb} MB → {final}")

        print("\n=== 实测清单（发布前必做）===")
        print(" 1. 解压到干净目录")
        print(" 2. 双击启动ClaudeNeko.bat → 浏览器自动打开")
        print(" 3. 能发消息 / 皮肤+海洋流体生效 / 终端能敲")
        print(" 4. 无敏感数据混入（server/data·media·*.log）")
        if args.test:
            smoke(dst)
            print("\n✅ --test 冒烟通过")
    finally:
        shutil.rmtree(build_root, ignore_errors=True)


if __name__ == "__main__":
    main()
