#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sfx-pack.py — ClaudeNeko 绿色版 → SFX 自解压 exe 一键打包
============================================================
把绿色包（zip 或目录）变成「双击自解压 + 自动启动」的 exe。
比 zip 更近一步的交付形态：小白双击 → 选目录 → 解压 → 自动启动 ClaudeNeko。

用法：
  python sfx-pack.py --zip <绿色zip路径>       # 从绿色包 zip 出 exe
  python sfx-pack.py --dir <绿色目录>           # 从绿色目录出 exe
  python sfx-pack.py --zip <zip> --test         # 出包后 7z t CRC 冒烟
  python sfx-pack.py --zip <zip> --no-deliver   # 出包后不复制到桌面待处理

原理（7-Zip SFX 三段拼接，已验证 9-01）：
  ​7z.sfx（stub） + config.txt（解压后运行什么） + claudeneko.7z（payload）
  = 可执行 exe。双击 → 解压到当前目录（生成 ClaudeNeko/）→ 运行 RunProgram。

关键点（对应规范 reference_claudeneko_packaging_sfx.md）：
  - 7z 顶层保留 ClaudeNeko/ 文件夹 → SFX RunProgram 用相对子路径
    「ClaudeNeko\启动ClaudeNeko.bat」（不能写裸名，否则解压后找不到）
  - 拼接用 Python 二进制 copyfileobj（cmd copy /b 对带空格+中文路径会崩）
  - config 必须 UTF-8，且首行 ;!@Install@!UTF-8! 标记
  - 冒烟用 7z t（不写盘），验证全部文件 CRC
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

# Windows 控制台默认 GBK，emoji/中文 print 会 UnicodeEncodeError → 强制 UTF-8 输出
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

SEVENZ = r"C:\Program Files\7-Zip\7z.exe"
SFX_STUB = r"C:\Program Files\7-Zip\7z.sfx"
DESKTOP_TMP = os.path.expanduser("~/Desktop/待处理")
DELIVERY_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "交付物")


def read_version(green_dir):
    """从绿色目录 package.json 读版本号（与 green-pack.py 同一来源）"""
    with open(os.path.join(green_dir, "package.json"), encoding="utf-8") as f:
        return json.load(f).get("version", "0.0.0")


def prepare(src, work):
    """把 --zip 或 --dir 归一成 work/ClaudeNeko 目录，返回该路径"""
    green = os.path.join(work, "ClaudeNeko")
    if os.path.isdir(src):
        shutil.copytree(src, green)
    elif os.path.isfile(src) and src.lower().endswith(".zip"):
        with zipfile.ZipFile(src) as zf:
            zf.extractall(work)  # zip 顶层就是 ClaudeNeko/
    else:
        raise SystemExit(f"无法识别输入: {src}（用 --zip 或 --dir）")
    if not os.path.isdir(green):
        raise SystemExit(f"输入里没找到 ClaudeNeko/ 目录: {src}")
    return green


def config_text(version):
    """SFX 配置（UTF-8）。RunProgram 用相对子路径，因为 7z 顶层是 ClaudeNeko/"""
    return (
        ";!@Install@!UTF-8!\n"
        f'Title="ClaudeNeko 绿色版 v{version}"\n'
        'BeginPrompt="即将解压 ClaudeNeko 绿色版到当前文件夹（生成 ClaudeNeko 文件夹）。无需安装，解压即用。是否继续？"\n'
        'RunProgram="ClaudeNeko\\启动ClaudeNeko.bat"\n'
        'FinishPrompt="ClaudeNeko 已就绪，正在启动…浏览器将自动打开。"\n'
        'GUIMode="2"\n'
        ";!@InstallEnd@!\n"
    )


def run_7z(args):
    r = subprocess.run([SEVENZ] + args, capture_output=True, text=True, errors="replace")
    return r


def make_7z(green_dir, work):
    """压成 7z（mx=5 平衡：实测 21M zip → 13M 7z，够小够快）。
    ⚠ cwd 切到父目录压 basename —— 7z 对相对路径会保留父前缀（实测坑：手工那次
    压 _sfx_work/ClaudeNeko，顶层变成 _sfx_work\\ClaudeNeko，SFX RunProgram 找不到），
    必须保证 7z 顶层永远是 ClaudeNeko/。"""
    arch = os.path.join(work, "claudeneko.7z")
    print("① 压 7z（-mx=5）…")
    r = subprocess.run(
        [SEVENZ, "a", "-t7z", "-mx=5", arch, os.path.basename(green_dir)],
        capture_output=True, text=True, errors="replace",
        cwd=os.path.dirname(green_dir),
    )
    if r.returncode != 0:
        raise RuntimeError("7z 压缩失败:\n" + (r.stderr or r.stdout)[-400:])
    return arch


def main():
    ap = argparse.ArgumentParser(description="ClaudeNeko 绿色版 → SFX 自解压 exe")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--zip", help="绿色包 zip 路径")
    src.add_argument("--dir", help="绿色目录路径")
    ap.add_argument("--test", action="store_true", help="出包后 7z t CRC 冒烟")
    ap.add_argument("--no-deliver", action="store_true", help="不复制到桌面待处理")
    args = ap.parse_args()

    src = args.zip or args.dir
    work = tempfile.mkdtemp(prefix="claudeneko_sfx_")
    try:
        green = prepare(src, work)
        version = read_version(green)
        arch = make_7z(green, work)

        cfg = os.path.join(work, "config.txt")
        with open(cfg, "w", encoding="utf-8") as f:
            f.write(config_text(version))

        exe = os.path.join(work, f"ClaudeNeko绿色版_setup_v{version}_{time.strftime('%Y%m%d')}.exe")
        with open(exe, "wb") as out:
            for p in (SFX_STUB, cfg, arch):
                with open(p, "rb") as f:
                    shutil.copyfileobj(f, out)
        print(f"   生成: {os.path.basename(exe)}（{os.path.getsize(exe) / 1048576:.1f} MB）")

        if args.test:
            r = run_7z(["t", exe])
            ok = "Everything is Ok" in (r.stdout or "") or r.returncode == 0
            print(f"③ 冒烟（7z t CRC）: {'✅ 通过' if ok else '❌ 失败'}")
            if not ok:
                print((r.stdout or r.stderr)[-400:])
                sys.exit(1)

        if args.no_deliver:
            print(f"   留在: {exe}")
        else:
            target = DESKTOP_TMP if os.path.isdir(DESKTOP_TMP) else os.path.dirname(exe)
            dest = os.path.join(target, os.path.basename(exe))
            shutil.copy2(exe, dest)
            print(f"   已交付: {dest}")
            os.makedirs(DELIVERY_DIR, exist_ok=True)
            shutil.copy2(exe, os.path.join(DELIVERY_DIR, os.path.basename(exe)))
            print(f"   归档: {os.path.join(DELIVERY_DIR, os.path.basename(exe))}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
