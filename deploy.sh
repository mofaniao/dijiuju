#!/usr/bin/env bash
# ============================================================
#  deploy.sh - 心情记录项目一键部署脚本
#  功能：提交本地变更并推送到 GitHub
#  使用：双击运行，或在 Git Bash 中执行 ./deploy.sh
# ============================================================

set -e  # 任何命令失败立即退出

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "=============================================="
echo "  心情记录 - Deploy Script"
echo "=============================================="
echo ""

# --- 检查 git 状态 ---
echo "[1/4] 检查 Git 状态..."
git status --short

# --- 暂存所有变更 ---
echo ""
echo "[2/4] 暂存变更..."
git add -A

# --- 提交（如果有变更）---
CHANGES=$(git status --short | wc -l)
if [ "$CHANGES" -gt 0 ]; then
  TIMESTAMP=$(date +"%Y-%m-%d %H:%M")
  echo ""
  echo "[3/4] 提交变更: $TIMESTAMP"
  git commit -m "deploy: $TIMESTAMP"
else
  echo ""
  echo "[3/4] 无变更，跳过提交"
fi

# --- 推送到 GitHub ---
echo ""
echo "[4/4] 推送到 GitHub..."
git -c core.sshCommand="ssh -F C:/Users/houzh/.ssh/config -o IdentitiesOnly=yes" push origin main

echo ""
echo "=============================================="
echo "  部署完成！"
echo "=============================================="
echo ""
echo "仓库地址: https://github.com/mofaniao/dijiuju"
read -p "按 Enter 退出..."
