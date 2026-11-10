# Adding worker machines

Enrolling a computer always takes deliberate steps. Discovery alone never makes a machine a worker.

1. **Discover or add.** On the *Nodes* page, run *Discover*, or *Add manually* with a hostname or IP. The device appears as *Discovered*.
2. **Authorize.** An admin opens the device and clicks *Authorize for enrollment*.
3. **Issue a token.** *Enrollment tokens*, then *Create token*. Choose its site (e.g. `home`).
   Tick "report other devices" only for one agent per remote network that should act as that network's discovery agent.
4. **Enroll on the machine,** as its owner. The agent needs only Python 3.9+; installing `psutil` improves the metrics.
   ```bash
   git clone <repo> && cd BioCompute/agent
   python3 biocompute_agent.py enroll --controller https://lab-ws.example.org --token bce_…
   ./install.sh        # systemd user service (Linux) or launchd agent (macOS)
   ```
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
