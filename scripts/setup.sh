#!/usr/bin/env bash
set -euo pipefail

echo "=== Overwatch VM Setup ==="

# Install Node.js 20+ via NodeSource
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Install system dependencies
echo "Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y \
  sqlite3 \
  git \
  gh \
  ripgrep \
  tmux \
  build-essential

# Create Overwatch home directory
OW_HOME="${HOME}/.overwatch"
mkdir -p "${OW_HOME}"/{workspaces,logs,pids}

# Install npm dependencies
echo "Installing npm packages..."
cd "$(dirname "$0")/.."
npm install

# Build TypeScript
echo "Building..."
npm run build

# Copy systemd units
if [ -d /etc/systemd/system ]; then
  echo "Installing systemd units..."
  sudo cp scripts/systemd/overwatch-telegram.service /etc/systemd/system/
  sudo cp scripts/systemd/overwatch-manager.service /etc/systemd/system/
  sudo cp scripts/systemd/overwatch-daemon@.service /etc/systemd/system/
  sudo systemctl daemon-reload
  echo "Systemd units installed. Enable with:"
  echo "  sudo systemctl enable --now overwatch-telegram"
  echo "  sudo systemctl enable --now overwatch-manager"
fi

echo ""
echo "=== Setup complete ==="
echo "1. Copy .env.example to .env and fill in your tokens"
echo "2. Start the manager: npm run start:manager"
echo "3. Start the Telegram bot: npm run start:telegram"
echo "4. Start the TUI: npm run start:tui"
