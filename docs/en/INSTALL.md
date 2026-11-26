[한국어](../INSTALL.md) · **English**

# Installation guide

> **The recommended way to install is the Mac app (DMG).** Download [the latest release](https://github.com/webjihong/hivelane/releases/latest) and follow the **[Mac app guide](MAC_APP.md)**. This document describes the **optional** method (installing from source) for people who want to modify the code or build it themselves.

## 1. Requirements

| Item | Details |
| --- | --- |
| macOS | Apple Silicon recommended. Always-on mode uses launchd |
| Node.js | 22 or later (`node --version`) |
| git | The repositories teams work on must be git repositories |
| Claude Code | `claude` must be working and logged in on this Mac. Hivelane uses the same login (no API key needed). With a Pro/Max subscription, plan usage appears in the sidebar |
| GitHub CLI (optional) | After `gh auth login`, the PR list, checks and merging work |
| Tailscale (optional) | Required if you want to use Hivelane from your phone |

### New to this? Installing the requirements

Open Terminal (Applications › Utilities › Terminal) and paste these one line at a time. Skip anything you already have.

```bash
# 1) Homebrew (a package installer for macOS) — enter your Mac password when asked
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# 2) Node.js and git
brew install node git
# 3) Install Claude Code, then log in (when the browser opens, approve with your Claude account)
npm install -g @anthropic-ai/claude-code
claude
```

Once the `claude` screen appears and you've finished logging in, leave with `/exit`.

Check your Claude Code login:

```bash
claude auth status --text
```

## 2. Install

```bash
git clone https://github.com/webjihong/hivelane.git
cd hivelane
npm install
```

### Always-on mode (recommended)

```bash
npm run service:install
```

What it does:

1. Builds the UI (`dist/web`).
2. Registers and starts the launchd user service `com.webjihong.hivelane`. It starts automatically when you log in to your Mac and restarts if it crashes. It shows up as **Hivelane** under "Allow in the Background" in System Settings › General › Login Items (a small `~/.hivelane/Hivelane.app` wrapper launches the server).
3. If Tailscale is installed, it runs `tailscale serve --bg 4312` to open the remote UI only inside your tailnet.

Open <http://127.0.0.1:4310> in your browser.

| Command | Description |
| --- | --- |
| `npm run service:status` | launchd status · tailscale serve address · server response |
| `npm run service:restart` | Rebuilds the UI and restarts the server (this interrupts the current turn of any working team, so do it while teams are idle) |
| `npm run service:uninstall` | Removes the service and tailscale serve (your data is kept) |

### Running manually (for testing)

```bash
npm run build
npm start          # http://127.0.0.1:4310
```

## 3. Where data and settings live

| Path | Contents |
| --- | --- |
| `~/.hivelane/hivelane.db` | All records (SQLite) |
| `~/.hivelane/worktrees/` | git worktrees where task teams work |
| `~/.hivelane/po/`, `standing/` | Working folders for the Lead and standing teams |
| `~/.hivelane/logs/server.log` | Server log |
| `~/.hivelane/archive/` | Change patches from cleaned-up worktrees and branches |
| `~/.hivelane/vapid.json` | Web push keys (generated automatically, don't share) |

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HIVELANE_HOME` | `~/.hivelane` | Data folder |
| `HIVELANE_PORT` | `4310` | Local UI on the Mac |
| `HIVELANE_REMOTE_PORT` | `4312` | Remote listener used only by tailscale serve |
| `VOYAGE_API_KEY` | none | Only if you use Voyage for vector search |

## 4. First-time setup

1. **Settings › Projects**: Register the path of a repository for teams to work on (you can pick the folder with "Choose in Finder"). The base branch and Claude Code memory folder are filled in automatically. If the folder isn't a git repository, "Initialize git here" creates a default `.gitignore` (excluding node_modules, .env, etc.) and a first commit, then registers it.
   - **git permissions**: The default is `none` (commits, pushes and PRs blocked). Switch to `push` to let teams push branches and open PRs (protected branches, force pushes and merging stay blocked).
   - **Blocked commands / Heavy commands**: Review these for your project. Always put production deploy and database commands in Blocked commands.
2. **Settings › Notifications** (optional): Slack webhook, and "Turn on notifications" on this device for web push.
3. Tell the **Lead** chat what you want done. For how to use it, see the [user guide](GUIDE.md).

> The UI language follows your Mac or browser the first time; change it in **Settings › Display › Language**. AI replies and notifications are in Korean by default; switch them in **Settings › Lead & engine › AI reply & notification language**.

## 5. Using it from your phone (Tailscale)

1. Install Tailscale on your Mac and phone and log in with the same account.
2. In the Tailscale admin console › DNS, turn on **HTTPS Certificates**.
3. Run `npm run service:install` (if you already have, check the `https://<mac-name>.<tailnet>.ts.net` address with `npm run service:status`).
4. Open that address once on your phone → on the Mac, when the account appears under "Last remote access attempt" in **Settings › Remote access**, click **Make this account the owner**.
5. Use "Add to Home Screen" in your phone browser to use it like an app and receive web push notifications.

Remotely you can view, give instructions, answer, merge PRs and run scripts, but changing settings, templates and projects, and adding or editing scripts, only works on the Mac.

## 6. Updating

```bash
cd hivelane
git pull
npm install
npm run service:install   # rebuild and re-register the service
```

Database schema changes (migrations) are applied automatically when the server starts. If teams are working, wait until they finish.

## 7. Troubleshooting

| Symptom | What to check |
| --- | --- |
| The UI doesn't load | `npm run service:status`, `~/.hivelane/logs/server.log`, `~/.hivelane/logs/launchd.err.log` |
| Teams fail immediately · login errors | If "Auth" in the sidebar is red, click **Re-authenticate**. Or run `claude auth login` in a terminal |
| The Tokens line doesn't appear | Logins that aren't subscriptions (API key, Bedrock, etc.) have no plan usage |
| The PR list is empty | `gh auth status` · whether the repository has a GitHub remote |
| 403 on the phone | Whether an owner account is registered in Settings › Remote access · whether it's a Tailscale user device (tagged devices are refused) |
| The Mac gets slow | Click the resource line in the sidebar to see who's using CPU and memory. Adjust zone thresholds and concurrency in Settings › Lead & engine |
| The UI is blank white | This can happen when only the server is outdated. Run `npm run service:restart` and reload |

## 8. Uninstalling

```bash
npm run service:uninstall
rm -rf ~/.hivelane     # to delete your records as well (cannot be undone)
```

Branches created by teams remain in each repository. Ask the Lead to "clean up git" and it will pick out the worktrees and local branches that can be removed.
