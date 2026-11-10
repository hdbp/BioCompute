# Adding worker machines

## Finding machines: sources, colours and the tailnet filter

Each machine on the *Nodes* page has a coloured tag for every source that has seen it:

| Tag | Meaning |
|---|---|
| Controller | the machine running BioCompute |
| Agent | the BioCompute agent is installed and sending heartbeats |
| Tailscale | listed by `tailscale status` on the controller (the controller must be logged in to your tailnet) |
| Neighbour table | in the controller's ARP/NDP cache: the same LAN, seen passively |
| mDNS | announced itself with Bonjour/mDNS on the controller's LAN |
| HTCondor | listed by `condor_status` as a member of your HTCondor pool |
| Manual | added by hand |
| Reported by *host* | reported by the discovery agent on another network |

A machine counts as **in your tailnet** in either of two cases:

- `tailscale status` lists it. This is authoritative, and the card then also shows whether Tailscale reports it *online* or *offline*.
- One of its own addresses is in Tailscale's ranges: `100.64.0.0/10` or `fd7a:115c:a1e0::/48`. For example, its agent reports such an address.

The *Network* switch filters to *In my tailnet* or *Outside tailnet*, and the *Found by* chips filter by source.
Filters are kept in the URL (`?net=in&src=tailscale`). The API offers the same filters:
`GET /api/nodes?tailnet=true&source=tailscale,neighbors`.

Tailnet members are the natural workers for the home machines. Their agents can reach the controller
through Tailscale from any network. Tailscale itself remains optional.

## Automatic enrollment for tailnet machines (one click)

For a machine in your tailnet, its panel on the *Nodes* page offers **Enroll automatically over Tailscale SSH**.
You enter the SSH user on that machine and the controller address as that machine sees it, then confirm.
BioCompute then runs this fixed sequence and shows each step live:

1. `ssh -o BatchMode=yes <user>@<its tailnet name or IP>`, then check for Python 3.9+. There are never password prompts.
2. Check that the machine can reach the controller URL (`/api/health`). This catches a wrong address before any token is used.
3. Copy the agent into `~/.local/share/biocompute-agent`.
4. Enroll with a one-time token. The token is bound to this node, valid for 1 hour, and sent over the SSH connection's
   stdin, so it never appears on a command line or in any log.
5. Optionally install the per-user background service (systemd user unit or launchd agent), then wait for its first heartbeat.

What is enforced:

* Only admins can start it, and only for machines that are members of your tailnet.
* The SSH target can only be that machine's own tailnet IPs or MagicDNS name.
* No free-form commands. Nothing runs as root, no ports are opened, no other software is installed.
* Participation stays **off** until you enable it.
* Every attempt is in the audit log.

Set `BIOCOMPUTE_ALLOW_SSH_ENROLLMENT=false` to turn the feature off.

### What has to be in place

* **On the controller:** the `ssh` client. Connections run as the controller's service account; the demo runs as you.
  New host keys are remembered in `<state dir>/ssh_known_hosts`.
* **On the worker:** Python 3.9+, plus one of the following.
  * **Tailscale SSH**, on Linux: `sudo tailscale set --ssh`. Your tailnet policy must *accept* SSH from the controller, for example:
    ```json
    "ssh": [
      { "action": "accept", "src": ["tag:biocompute-controller"], "dst": ["tag:biocompute-worker"], "users": ["hugo"] }
    ]
    ```
    Tailscale's default policy uses a **check** rule, which needs a browser re-authentication. BioCompute cannot
    answer that prompt, so use an `accept` rule as above.
  * **Regular SSH over the tailnet.** This is required for Macs: the Tailscale app from the Mac App Store or
    the standalone download cannot act as a Tailscale SSH *server*.
    1. Enable *System Settings → General → Sharing → Remote Login*.
    2. Add the controller account's public key to `~/.ssh/authorized_keys` on the Mac. Create the key once on the
       controller with `ssh-keygen -t ed25519`, run as the account that runs BioCompute.
* **A reachable controller address.** The controller must be reachable from the worker at the URL you enter.
  Use the nginx front end (`http://<controller>.<tailnet>.ts.net:8080`) or TLS.
  For a quick test, start the API on the tailnet address:
  `uvicorn app.main:app --host $(tailscale ip -4) --port 8000`.
* **macOS background service:** to install the launchd service over SSH, someone must be logged in to the Mac's
  desktop. Otherwise the agent is still enrolled; run `install.sh` once when logged in.

If a step fails, the panel shows the output and a hint for common problems: refused key, check-mode policy,
no route, or a changed host key. *Try again* reruns the whole sequence; it is safe to repeat.

## Enrollment steps (manual)

Enrolling a computer always takes deliberate steps. Discovery alone never makes a machine a worker.

1. **Discover or add.** On the *Nodes* page, run *Discover*, or *Add manually* with a hostname or IP. The device appears as *Discovered*.
2. **Authorize.** Click the device; its panel shows an *Enroll this machine* checklist. An admin clicks *Authorize for enrollment*.
3. **Issue a token.** Click *Create enrollment token* in the same panel; the token is pre-labelled with the machine's name and site.
   (Or use *Enrollment tokens* at the top of the page.) Choose its site (e.g. `home`).
   Tick "report other devices" only for one agent per remote network that should act as that network's discovery agent.
4. **Enroll on the machine,** as its owner. The agent needs only Python 3.9+; installing `psutil` improves the metrics.
   ```bash
   git clone <repo> && cd BioCompute/agent
   python3 biocompute_agent.py enroll --controller https://lab-ws.example.org --token bce_…
   # over Tailscale, e.g.:  --controller http://lab-ws.tail1234.ts.net:8080
   ./install.sh        # systemd user service (Linux) or launchd agent (macOS)
   ```
   The `--controller` address must be reachable from that machine. Use the nginx or TLS front end
   (port 8080 or 443), not port 8000, because the API only listens on 127.0.0.1. When the machine was
   already discovered (for example through Tailscale), enrolling merges into that same entry.
5. **Allocate.** The node appears as *Online* with participation **off**. An admin sets cores, memory,
   hours, idle-only and AC-power rules, and the data policy, then enables participation.
6. **Scheduler.** For BioCompute to actually place work there, the machine must be an HTCondor
   execute node with the generated policy installed (see `docs/deployment.md`).

## What the agent does and does not do

* It sends an inventory (CPU topology, RAM, GPUs, disks, OS, software versions) and a heartbeat with
  CPU and memory use, load, battery state and idle time every 30 s, over outbound HTTPS only.
* It optionally advertises itself over mDNS (`_biocompute._tcp`) on its local network.
* With a discovery-enabled token, it passively reads the local ARP/NDP cache every 10 minutes and reports the devices it finds.
* It **never** accepts commands, opens ports, runs jobs or installs software.

## Suggested setup for the four-machine lab

| Machine | Site | Suggested allocation |
|---|---|---|
| Lab workstation (32 cores) | lab | controller; Balanced keeps about 85% of cores; holds restricted raw data |
| Home server (12 cores) | home | worker; data policy *approved-staging*; all hours |
| iMac (Intel) | home | opportunistic; idle-only; 50% of cores |
| MacBook Pro M3 Max | home | opportunistic; idle-only; AC power only; allowed hours e.g. 23:00-07:00 |

Restricted raw data stays on the lab site regardless of these settings. Home machines receive work
only for non-restricted inputs, and only through a shared filesystem or explicit staging. Staging
is planned and not yet implemented.

## Uninstall

* Linux: `systemctl --user disable --now biocompute-agent`
* macOS: `launchctl unload ~/Library/LaunchAgents/org.biocompute.agent.plist`

Then delete `~/.config/biocompute` and remove the node on the *Nodes* page.
