#!/bin/sh
# Install the BioCompute agent as a per-user background service.
#   Linux: systemd user unit   macOS: launchd LaunchAgent
# Run as the user who owns this machine AFTER `biocompute_agent.py enroll ...`.
# Works from an interactive terminal and from an SSH session (BioCompute's Tailscale SSH enrollment).
# Nothing here requires root, installs other software or opens network ports.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
dest="${BIOCOMPUTE_AGENT_HOME:-$HOME/.local/share/biocompute-agent}"
mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"
if [ "$here" != "$dest" ]; then
  cp "$here/biocompute_agent.py" "$dest/"
  cp -L "$here/hostinfo.py" "$dest/"
fi
py="$(command -v python3)"
case "$(uname -s)" in
  Linux)
    mkdir -p "$HOME/.config/systemd/user"
    sed -e "s#@PYTHON@#$py#g" -e "s#@DEST@#$dest#g" "$here/systemd/biocompute-agent.service" > "$HOME/.config/systemd/user/biocompute-agent.service"
    systemctl --user daemon-reload
    systemctl --user enable biocompute-agent.service
    systemctl --user restart biocompute-agent.service
    # keep running after logout (allowed for your own account on most distributions)
    loginctl enable-linger "$USER" 2>/dev/null || echo "note: could not enable lingering; the agent stops when you log out (ask an admin: loginctl enable-linger $USER)"
    echo "Installed. Logs: journalctl --user -u biocompute-agent -f"
    ;;
  Darwin)
    plist="$HOME/Library/LaunchAgents/org.biocompute.agent.plist"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    sed -e "s#@PYTHON@#$py#g" -e "s#@DEST@#$dest#g" -e "s#@HOME@#$HOME#g" "$here/launchd/org.biocompute.agent.plist" > "$plist"
    domain="gui/$(id -u)"
    launchctl bootout "$domain" "$plist" 2>/dev/null || true
    if launchctl bootstrap "$domain" "$plist" 2>/dev/null; then
      :
    else
      # no GUI session (e.g. nobody logged in): fall back to the legacy loader for this login session
      launchctl unload "$plist" 2>/dev/null || true
      launchctl load -w "$plist" || { echo "launchd refused the agent; log in to the Mac once and rerun install.sh" >&2; exit 1; }
    fi
    echo "Installed. Logs: ~/Library/Logs/biocompute-agent.log"
    ;;
  *) echo "Unsupported OS"; exit 1;;
esac
