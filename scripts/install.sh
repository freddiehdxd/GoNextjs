#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════╗
# ║  ServerPanel — One-Liner Installer                                         ║
# ║                                                                            ║
# ║  Usage:                                                                    ║
# ║    curl -fsSL https://raw.githubusercontent.com/freddiehdxd/panel/main/scripts/install.sh | bash
# ║                                                                            ║
# ║  This script clones the repo and runs setup_panel.sh automatically.        ║
# ╚════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

PANEL_DIR="/opt/panel"
REPO="https://github.com/freddiehdxd/panel.git"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

# Must be root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[error]${NC} Please run as root: curl ... | sudo bash" >&2
  exit 1
fi

# Install git if missing
if ! command -v git &>/dev/null; then
  echo -e "${CYAN}[info]${NC}  Installing git..."
  apt-get update -qq && apt-get install -y -qq git > /dev/null
fi

# Clone or update
if [ -d "${PANEL_DIR}/.git" ]; then
  echo -e "${CYAN}[info]${NC}  Panel directory exists — pulling latest..."
  git -C "${PANEL_DIR}" pull --ff-only
else
  echo -e "${CYAN}[info]${NC}  Cloning ServerPanel..."
  rm -rf "${PANEL_DIR}"
  git clone "${REPO}" "${PANEL_DIR}"
fi

# Run the full setup
chmod +x "${PANEL_DIR}/scripts/setup_panel.sh"
exec bash "${PANEL_DIR}/scripts/setup_panel.sh"
