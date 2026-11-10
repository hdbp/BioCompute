#!/usr/bin/env bash
# Install the BioCompute agent as a per-user background service.
#   Linux: systemd user unit   macOS: launchd LaunchAgent
# Run as the user who owns this machine AFTER `biocompute_agent.py enroll ...`.
# Nothing here requires root, installs other software or opens network ports.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${BIOCOMPUTE_AGENT_HOME:-$HOME/.local/share/biocompute-agent}"
mkdir -p "$dest"
cp "$here/biocompute_agent.py" "$dest/"
cp -L "$here/hostinfo.py" "$dest/"
py="$(command -v python3)"
case "$(uname -s)" in
  Linux)
    mkdir -p "$HOME/.config/systemd/user"
    sed -e "s#@PYTHON@#$py#g" -e "s#@DEST@#$dest#g" "$here/systemd/biocompute-agent.service" > "$HOME/.config/systemd/user/biocompute-agent.service"
    systemctl --user daemon-reload
    systemctl --user enable --now biocompute-agent.service
    echo "Installed. Logs: journalctl --user -u biocompute-agent -f"
    echo "To keep it running when you are logged out: loginctl enable-linger $USER"
    ;;
  Darwin)
    plist="$HOME/Library/LaunchAgents/org.biocompute.agent.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    sed -e "s#@PYTHON@#$py#g" -e "s#@DEST@#$dest#g" -e "s#@HOME@#$HOME#g" "$here/launchd/org.biocompute.agent.plist" > "$plist"
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load -w "$plist"
    echo "Installed. Logs: ~/Library/Logs/biocompute-agent.log"
    ;;
  *) echo "Unsupported OS"; exit 1;;
esac
