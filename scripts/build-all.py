#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-all.py — ClaudeNeko 一键打全部封装（绿色包 + SFX + 安装器）
==================================================================
把「手工四步接力」变成一条命令：
  ① 打包前自动归档旧版（交付物目录里版本号≠当前的 三件套 → 004 归档）
  ② 打绿色包（green-pack.py）
  ③ 打 SFX（sfx-pack.py --zip）
  ④ 重建 installer_src + 编安装器（ISCC）
  ⑤ 打印检查单

用法：
  python scripts/build-all.py             # 全流程（归档旧版 → 三件套）
  python scripts/build-all.py --test      # 每步带冒烟（绿色包 CRC + SFX 7z t）
  python scripts/build-all.py --no-installer  # 跳过安装器（只绿色包+SFX，快）
  python scripts/build-all.py --skip-archive  # 不归档旧版

对应规范：memory/workspace/references/自动化与工具/reference_claudeneko_packaging.md
归档目录统一：本机 004_归档/ClaudeNeko历史备份（源码+封装全在这，9-02 定稿；路径见下方 ARCHIVE_DIR，本机专用）
"""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time

# Windows 控制台 GBK 下 emoji/中文 print 会崩 → 强制 UTF-8
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_build_local():
    """读本机私有配置 scripts/.build_local.env（gitignore 不入仓库）。
    每行 KEY=VALUE（# 开头为注释），把真实本机路径注入环境变量。"""
    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".build_local.env")
    if not os.path.isfile(env_file):
        return
    try:
        with open(env_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    except Exception:
        pass


_load_build_local()

DELIVERY_DIR = os.path.join(PROJECT, "交付物")
DIST_INSTALLER = os.path.join(PROJECT, "dist_installer")
INSTALLER_SRC = os.path.join(PROJECT, "installer_src")
# 归档统一入口（9-02 定稿）：源码包 + 封装包全进这
# 本机归档位置：优先 scripts/.build_local.env（gitignore 不入仓库）→ 其次
# 环境变量 CLAUDE_NEKO_ARCHIVE_DIR → 最后通用默认。二次开发者按需配置。
ARCHIVE_DIR = os.environ.get(
    "CLAUDE_NEKO_ARCHIVE_DIR",
    os.path.join(os.path.expanduser("~"), "ClaudeNeko_归档"),
)
DESKTOP_TMP = os.path.expanduser("~/Desktop/待处理")
# 本机 Inno Setup 7 路径（本机专用，二次开发者按自己环境修改或注释）
ISCC = r"C:\Program Files (x86)\Inno Setup 7\ISCC.exe"
ISS = os.path.join(PROJECT, "ClaudeNeko安装器.iss")

ASSETS_DIR = os.path.join(PROJECT, "assets")  # 图标素材/7z_neko.sfx 等（打包脚本自带引用，无需额外拷贝）


def log(msg):
    print(f"[build-all] {msg}")


def read_version():
    with open(os.path.join(PROJECT, "package.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def _load_green_pack():
    """按路径加载 green-pack.py（文件名带连字符，importlib 加载）"""
    spec = importlib.util.spec_from_file_location(
        "green_pack_mod", os.path.join(PROJECT, "scripts", "green-pack.py")
    )
    gp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gp)
    return gp


def archive_old_versions(current_version):
    """① 打包前归档旧版：交付物目录里 版本号≠current 的封装三件套 → 004 归档。

    匹配规则：文件名含 '_v{X.Y.Z}_'（绿色包/SFX）或 '_v{X.Y.Z}.exe'（安装器），
    且版本号不等于当前 → 移动归档。桌面待处理里的同名旧版也一并归档（发人区保持最新）。
    """
    if not os.path.isdir(DELIVERY_DIR):
        log("交付物目录不存在，跳过归档")
        return
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    # 交付物目录 + 桌面待处理 两处都扫
    for base in (DELIVERY_DIR, DESKTOP_TMP):
        if not os.path.isdir(base):
            continue
        for f in sorted(os.listdir(base)):
            # 只认封装形态（绿色包/SFX/安装器），不碰 ClaudeNeko_v*.zip 源码包（源码归档走单独流程）
            if not (f.startswith("ClaudeNeko绿色版") or f.startswith("ClaudeNeko安装器")):
                continue
            m = re.search(r"_v([0-9]+\.[0-9]+\.[0-9]+)", f)
            if not m:
                continue
            fv = m.group(1)
            if fv == current_version:
                continue  # 当前版本保留在交付物/桌面
            src = os.path.join(base, f)
            dst = os.path.join(ARCHIVE_DIR, f)
            if os.path.exists(dst):
                # 归档区已有同名：加时间戳避免覆盖
                name, ext = os.path.splitext(f)
                dst = os.path.join(ARCHIVE_DIR, f"{name}_{time.strftime('%Y%m%d%H%M%S')}{ext}")
            shutil.move(src, dst)
            log(f"归档旧版: {f} (v{fv}) → 004 归档")


def make_installer_src(gp):
    """④a 重建 installer_src（复用 green-pack.assemble 组装最新内容）"""
    import tempfile
    build_root = tempfile.mkdtemp(prefix="claudeneko_installer_src_")
    try:
        gp.step_build()
        gp.ensure_deps(False)
        dst = gp.assemble(build_root)
        if os.path.isdir(INSTALLER_SRC):
            shutil.rmtree(INSTALLER_SRC)
        shutil.copytree(dst, INSTALLER_SRC)
        total_mb = round(gp._dir_size(INSTALLER_SRC) / 1024 / 1024)
        log(f"installer_src 重建: {total_mb} MB")
    finally:
        shutil.rmtree(build_root, ignore_errors=True)


def compile_installer(version):
    """④b 调 ISCC 编译安装器（产物进 dist_installer）。

    注意：ISCC 输出是 GBK 编码，subprocess text=True 会乱码 → **不解析输出**。
    命名规则固定（.iss 用 {#AppVersion} 拼）：ClaudeNeko安装器_v{version}.exe
    → 编译后直接按规则指向 dist_installer 里的产物。
    """
    if not os.path.isfile(ISCC):
        log(f"❌ 找不到 ISCC: {ISCC}（Inno Setup 7 未装？）")
        return None
    r = subprocess.run([ISCC, ISS], capture_output=True)
    ok = r.returncode == 0
    if not ok:
        # 输出可能 GBK，try 解码供排查
        tail = (r.stderr or r.stdout)[-600:]
        try:
            tail = tail.decode("gbk", errors="replace")
        except Exception:
            pass
        log("安装器编译失败:\n" + tail)
        return None
    # 按命名规则定位产物（不解析编码，避免乱码）
    exe = os.path.join(DIST_INSTALLER, f"ClaudeNeko安装器_v{version}.exe")
    if not os.path.isfile(exe):
        log(f"❌ 编译成功但找不到产物: {exe}")
        return None
    log(f"安装器编译成功: {os.path.basename(exe)}")
    return exe


def main():
    ap = argparse.ArgumentParser(description="ClaudeNeko 一键打包（绿色包+SFX+安装器）")
    ap.add_argument("--test", action="store_true", help="每步带冒烟")
    ap.add_argument("--no-installer", action="store_true", help="跳过安装器")
    ap.add_argument("--skip-archive", action="store_true", help="不归档旧版")
    args = ap.parse_args()

    version = read_version()
    log(f"当前版本: v{version}")

    # ① 归档旧版（默认开，可 --skip-archive 跳过）
    if not args.skip_archive:
        archive_old_versions(version)
    else:
        log("跳过旧版归档 (--skip-archive)")

    # ② 打绿色包（复用 green-pack CLI，保留它的双份 deliver）
    log("→ 打绿色包 (green-pack.py)")
    r = subprocess.run([sys.executable, os.path.join("scripts", "green-pack.py")], cwd=PROJECT)
    if r.returncode != 0:
        log("❌ 绿色包失败"); sys.exit(1)

    # 找到新绿色包（交付物目录里当前版本的最新 zip）
    zips = [
        f for f in os.listdir(DELIVERY_DIR)
        if f.startswith("ClaudeNeko绿色版_v") and f.endswith(".zip")
    ]
    if not zips:
        log("❌ 找不到新绿色包 zip"); sys.exit(1)
    zip_path = os.path.join(DELIVERY_DIR, sorted(zips)[-1])
    log(f"绿色包: {os.path.basename(zip_path)}")

    # ③ 打 SFX
    log("→ 打 SFX (sfx-pack.py)")
    sfx_args = [sys.executable, os.path.join("scripts", "sfx-pack.py"), "--zip", zip_path]
    if args.test:
        sfx_args.append("--test")
    r = subprocess.run(sfx_args, cwd=PROJECT)
    if r.returncode != 0:
        log("❌ SFX 失败"); sys.exit(1)

    # ④ 安装器（可跳过）
    if args.no_installer:
        log("跳过安装器 (--no-installer)")
    else:
        log("→ 重建 installer_src + 编安装器")
        gp = _load_green_pack()
        make_installer_src(gp)
        exe = compile_installer(version)
        if not exe:
            sys.exit(1)
        # 安装器产物从 dist_installer 复制到 交付物 + 桌面（与 green-pack 双份一致）
        if os.path.isfile(exe):
            shutil.copy2(exe, os.path.join(DELIVERY_DIR, os.path.basename(exe)))
            if os.path.isdir(DESKTOP_TMP):
                shutil.copy2(exe, os.path.join(DESKTOP_TMP, os.path.basename(exe)))
            log(f"安装器已双份: 交付物 + 桌面待处理")
        # 清理 installer_src（编译临时目录，用完即清）
        shutil.rmtree(INSTALLER_SRC, ignore_errors=True)

    # ⑤ 检查单
    print("\n=== build-all 完成 · 检查单 ===")
    print(f"版本: v{version}")
    print(" 1. 三件套是否在 交付物/ + 桌面待处理/：")
    for f in sorted(os.listdir(DELIVERY_DIR)):
        if "v" + version in f:
            print(f"    ✅ {f}")
    print(" 2. 旧版已归档 004（源码+封装统一）")
    print(" 3. 发前冒烟：解压绿色包 → 启动 → 发消息 / 开终端 / 看图标粒子小猫")
    print(" 4. 无敏感数据（server/data·media·log）")


if __name__ == "__main__":
    main()
