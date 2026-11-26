[한국어](../MAC_APP.md) · **English**

# Mac app guide (DMG)

The Mac app lets you use Hivelane without knowing anything about the terminal.
This document has two parts.

- **[Part 1. Using the app](#part-1-using-the-app)**: for people who have downloaded the DMG and want to install and use it
- **[Part 2. Building the DMG](#part-2-building-the-dmg)**: for people who want to build the DMG from source and share it

> **What's a DMG?** It's the file format commonly used to distribute Mac apps. Double-click it and a window opens as if you'd plugged in a USB drive; drag the app inside it into your Applications folder and the installation is done.

---

## Part 1. Using the app

### 1-1. Before you begin

| Item | Required? | Details |
| --- | --- | --- |
| Apple silicon Mac (M1, M2, M3, M4, …) | Required | Go to the Apple menu at the top left › "About This Mac"; if "Chip" shows **Apple M…**, you're set. Intel Macs aren't supported yet. |
| Claude account | Required | Any account with a Claude Pro or Max subscription. The AI teams work using this account's usage. |
| git (developer tools) | Required | It's fine if you don't have it. The app shows an install button the first time it runs. |
| Tailscale | Optional | Only needed if you also want to use Hivelane from your phone. |

You don't need to install Node.js or anything else. Everything is bundled inside the app.

### 1-2. Installing

1. Under "Assets" on **[the latest GitHub release](https://github.com/webjihong/hivelane/releases/latest)**, download `Hivelane-<version>-arm64.dmg` and double-click it.
2. In the window that opens, drag the **Hivelane** icon onto the **Applications** folder.
3. Close the window and eject the "Hivelane" disk that appeared on your desktop or in the Finder sidebar (the ⏏ button).

### 1-3. Opening it the first time: the "unidentified developer" warning

This app isn't signed through Apple's paid program, so macOS blocks it the first time you open it. Allow it once as shown below and it will open normally from then on.

1. Double-click **Hivelane** in your Applications folder.
2. When a window like "“Hivelane” Not Opened" appears, click **Done** (or Cancel).
3. Go to the Apple menu › **System Settings** › **Privacy & Security**.
4. Scroll down; next to "“Hivelane” was blocked…" there's an **Open Anyway** button. Click it.
5. Enter your Mac password (or use Touch ID), then click **Open** in the window that appears.

### 1-4. First-time setup: the "Get started with Hivelane" screen

When you open the app for the first time, you'll see the four rows below. The dot color shows each row's status (green = ready, orange = needs action, gray = optional).

| Row | What to do |
| --- | --- |
| **git (developer tools)** | If it's orange, click **Install**. When the macOS developer tools installer appears, click "Install" and wait for it to finish (a few minutes), then click **Check again** in the app. |
| **Claude account** | Nothing to do here. You'll log in from the control room after the server starts (see 1-5 below). |
| **Tailscale** | Skip it if you don't plan to use your phone. If you do, see 1-7 below. |
| **Hivelane server** | Click **Install server and start** at the bottom. Within 30 seconds the window switches to the control room. |

> **What's the server?** It's the program where the AI teams actually do their work. Once installed, it starts automatically every time you turn on your Mac and keeps working in the background even if you close the app window. It shows up as **Hivelane** in System Settings › General › Login Items.

### 1-5. Logging in to Claude

1. If the status bar at the bottom left of the control room shows a red **Auth** with "Login required", click **Re-authenticate** next to it.
2. Click the link that appears, log in to Claude in your browser, and copy the **code** shown on the page.
3. Go back to the control room and paste the code. That's it: **Auth** in the status bar turns green.

If you were already using Claude Code (the `claude` command) on this Mac, Hivelane uses that login and you can skip this step.

### 1-6. Getting started

1. In **Settings › Projects**, register the folder (repository) for the AI teams to work in. Just pick the folder with "Choose in Finder".
2. Click **Lead** on the left and type what you'd like done in the chat. For example: "Add a show-password button to the login screen."
3. For details on how to use it, see the [user guide](GUIDE.md).

The app's menu bar and setup screen follow your Mac's language (Korean or English). To force one, launch the app with the environment variable `HIVELANE_LANG` set to `en` or `ko`. The control room's language is chosen in **Settings › Display › Language** (per device), and the language of AI replies and notifications in **Settings › Lead & engine › AI reply & notification language**.

### 1-7. Using it from your phone (optional)

1. Install [Tailscale](https://tailscale.com/download) on your Mac and phone and log in with **the same account**.
2. In the Tailscale admin console (web) › **DNS**, turn on **HTTPS Certificates**.
3. Click the Hivelane icon in your Mac's menu bar › **Connect phone (Tailscale)…**. An address like `https://<mac-name>.<…>.ts.net` appears. (The **Connect phone** button in the Tailscale row of the setup screen does the same thing.)
4. Open that address in your phone's browser. It's refused at first; then, when the account you just tried appears in **Settings › Remote access** in the control room on your Mac, click **Make this account the owner**.
5. Open it again on your phone and tap **Add to Home Screen** in the browser menu to use it like an app.

### 1-8. The menu bar icon

The Hivelane honeycomb icon sits in the menu bar at the top right of your screen. Its shape tells you the current status.

| Icon | Meaning |
| --- | --- |
| Three empty honeycomb cells | The server is running and teams are idle |
| Cells filling up one by one, cycling | A team or the Lead is working |
| A dot at the top right | Something needs your attention (a team's question, a failure, a Lead proposal to approve, etc. · click the icon to see how many) |
| Faint dotted honeycomb | The server is off |

Click the icon to see the items that need you and the working teams by name; click one to jump straight to that conversation. Other menu items:

| Menu item | What it does |
| --- | --- |
| ● Server running / ○ Server stopped | Current status (click to open the window) |
| Open Hivelane | Opens the control room window |
| Open in browser | Opens `http://127.0.0.1:4310` in Safari, Chrome, etc. |
| Restart server | Use when the UI looks wrong. Working teams are briefly interrupted, then continue |
| Open logs folder | Shows the log files (`~/.hivelane/logs`) when something goes wrong |
| Connect phone (Tailscale)… | Creates and shows the address to open on your phone (1-7) |
| Stop server (turn off always-on) | Shuts the server down completely. All teams stop. A server installed from the terminal (`npm run service:install`) can't be stopped here, so the item is grayed out; stop it in the terminal with `npm run service:uninstall` |
| Quit Hivelane app (server keeps running) | Closes only the app window and icon. **The server keeps working** |

### 1-9. Updating to a new version

1. Download the new DMG and drag it into the Applications folder as in 1-2. When asked whether to replace it, click **Replace**.
2. Open the app and click the menu bar icon › **Restart server**. The new server takes over.

Your records (conversations, teams, settings) stay in the `~/.hivelane` folder, so everything carries over.

### 1-10. Uninstalling

1. Menu bar icon › **Stop server (turn off always-on)**.
2. Menu bar icon › **Quit Hivelane app (server keeps running)**.
3. Move **Hivelane** from the Applications folder to the Trash.
4. To delete your records too, press `⌘ + ⇧ + G` in Finder, type `~/.hivelane`, and delete that folder (this cannot be undone).

### 1-11. Troubleshooting

| Symptom | Fix |
| --- | --- |
| "“Hivelane” is damaged and can't be opened" | Do the "Open Anyway" step in 1-3. If it still happens, open the Terminal app, paste `xattr -dr com.apple.quarantine /Applications/Hivelane.app`, press Enter, and open the app again. |
| Nothing changes 30 seconds after "Install server and start" | Menu bar icon › Open logs folder › check `launchd.err.log` and `server.log`, or send those two files to whoever built the app. |
| Teams fail immediately | Check whether **Auth** in the status bar is red, and redo 1-5. |
| The menu bar icon isn't visible | It can be hidden when the menu bar has many icons. Open Hivelane again from the Applications folder and the window appears. |
| The UI is white or looks outdated | Menu bar icon › Restart server, then press `⌘ + R` in the window |

---

## Part 2. Building the DMG

How to build the DMG file from source. Once you've set things up, it's a single command from then on.

### 2-1. Requirements (first time only)

| Item | How to check | If missing |
| --- | --- | --- |
| Apple silicon Mac | See 1-1 | For now, only DMGs for Apple silicon are built |
| Developer tools (including git) | `xcode-select -p` prints a path in Terminal | `xcode-select --install` |
| Node.js 22 or later | `node --version` | Install the LTS from <https://nodejs.org> |
| Source code | — | See 2-2 below |

> **How to open Terminal**: press `⌘ + Space` to open Spotlight, type "Terminal" and press Enter.

### 2-2. Getting the source and installing dependencies (first time only)

Paste these into Terminal one line at a time, pressing Enter after each.

```bash
git clone https://github.com/webjihong/hivelane.git
cd hivelane
npm install
```

`npm install` downloads the required packages (a few minutes, around 1 GB). When it's done, check that the Electron (app shell) binary downloaded correctly.

```bash
ls node_modules/electron/dist
```

If you see `Electron.app`, you're fine. **If nothing is listed**, run the following once (depending on your npm configuration, it sometimes isn't downloaded automatically).

```bash
node node_modules/electron/install.js
```

### 2-3. Building the DMG

```bash
npm run dist:mac
```

It takes 1–5 minutes. What it does:

1. Builds the UI (web) and the server, and bundles the server into a single file.
2. Gathers only what goes into the app in the `desktop/.stage` folder and installs it there. Your original `node_modules` isn't touched.
3. Rebuilds the database module (better-sqlite3) for the Node inside the app, then creates the DMG.

It succeeded if you see `완료:` ("done") at the end. The output file (inside the `hivelane` folder you cloned; even if you build from a git worktree, it ends up in the original folder):

```
dist/desktop/Hivelane-<version>-arm64.dmg
```

To open it in Finder:

```bash
open dist/desktop
```

> A size of around 300 MB is normal. Most of it is the Claude binary bundled into the app.

### 2-4. Trying the app before building (optional)

```bash
npm run desktop
```

This opens just the app window without building a DMG. If a Hivelane server is already running on this Mac, it connects to that server. Closing the window leaves it in the menu bar; to quit, use menu bar icon › Quit Hivelane app.

### 2-5. Versioning

Versions follow **major.feature.fix** (e.g. `1.2.3`). Bump the middle number when you add features, and the last number for fixes only. Record what changed for each version in [CHANGELOG.md](../../CHANGELOG.md) at the top of the repository (the release notes are taken from this Korean file; the English summary is in [CHANGELOG.en.md](../../CHANGELOG.en.md)).

### 2-6. Releasing (publishing a new DMG)

In the original repository, with main clean and up to date:

1. Write a new version section at the top of `CHANGELOG.md`, like `## 1.1.0 — 2026-12-01`, then commit and push.
2. The single command below bumps the version → commits and tags (`v1.1.0`) → pushes → builds the DMG → uploads the DMG to GitHub Releases.

```bash
npm run release -- 1.1.0          # add --dry to only show what it would do
```

You need to be logged in to the GitHub CLI (`gh`) with the repository owner's account (`gh auth status`). Give recipients the [Releases](https://github.com/webjihong/hivelane/releases) address and **Part 1** of this document.

Because the app is unsigned, recipients have to do the "Open Anyway" step in 1-3 once. Removing that step would require signing and notarizing with an Apple Developer account ($99/year), which isn't supported yet.

### 2-7. Common errors

| Error message (partial) | Cause · fix |
| --- | --- |
| `Cannot find module 'electron/package.json'` | `npm install` wasn't run or failed. Redo 2-2. |
| `Electron failed to install correctly` / `npm run desktop` exits immediately | The Electron binary is missing. Run `node node_modules/electron/install.js` |
| `gyp ERR!` · `xcrun: error` | Developer tools are missing or broken. Run `xcode-select --install` and try again. |
| Network error during the `npm install` step | Check your internet connection and run `npm run dist:mac` again. |
| The built app won't open because it's "damaged" | Use the `xattr` command from 1-11. This is macOS protection kicking in because the app isn't signed. |

### 2-8. App structure (if you're curious)

| File | Role |
| --- | --- |
| `desktop/main.mjs` | The app itself: window, menu bar icon, registering the always-on server (launchd) |
| `desktop/setup.html`, `setup.js` | The "Get started with Hivelane" screen |
| `desktop/preload.cjs` | Bridge between the setup screen and the app |
| `scripts/bundle-server.ts` | Bundles the server into a single file (`dist/server/index.mjs`) (`npm run build:server`) |
| `scripts/build-desktop.ts` | The whole DMG build process (`npm run dist:mac`) |

The server runs by launching the app's bundled Electron as Node (`ELECTRON_RUN_AS_NODE=1`), so recipients don't need to install Node. The registered service is named `com.webjihong.hivelane`, and its configuration file is `~/Library/LaunchAgents/com.webjihong.hivelane.plist`. On a Mac where a server is already running via `npm run service:install`, the app just connects to that server and doesn't change the registration.
