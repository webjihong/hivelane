[한국어](CHANGELOG.md) · **English**

# Changelog

Versions follow [Semantic Versioning](https://semver.org/): **major.feature.fix** (e.g. 1.2.3).
The Mac app (DMG) for each version is published on [Releases](https://github.com/webjihong/hivelane/releases).

## 1.0.2 — 2026-11-26

### Fixed
- "Clean up team" failed when the worktree had already been removed: if the folder is gone or git no longer knows it, it is recorded as already cleaned and the team is archived. Git cleanup now also clears the team's worktree record when it removes a team folder.
- Instructions, answers and Lead chat were limited to 8,000 characters → now 100,000 (standing briefs 20,000), with a clear message before sending if you go over.
- When started as a service or Mac app, the server could not read the Mac language and defaulted AI replies and notifications to English → it now uses the Mac system language.
- Codex accounts showed up in the default and Lead account pickers.

### Changed
- AI accounts "Switch order": separate Claude and Codex lists, reordered by dragging rows (the row follows your pointer and the others slide aside; touch and keyboard work too).
- Creating, uploading to or editing a GitHub release is no longer hard-blocked: it runs once after a human approves that exact command. Deleting releases, merging PRs and the like stay blocked, and commands that cannot run even with approval are reported as "a human must run this" instead of asking for approval.

## 1.0.1 — 2026-11-26

### Korean and English
- UI language: Settings › Display › Language (한국어 / English). Saved per device; the first run follows the Mac/browser language. The Mac app's menu bar and first-run setup follow the Mac language.
- AI reply & notification language: Settings › Lead & engine. Set to English and the Lead, PMs and members answer in English, and notifications, errors and system messages are in English too (existing records stay as they are).
- English docs: README.en.md, docs/en (install, Mac app, user guide) and English screenshots.

### Also
- Team ids in text (tm-…, s-…) are shown as "team name · id" chips that open the team. Notifications write them as "name (id)".
- The app version is read from package.json and shown in the UI and integrations.
- "Clean up team": one button for finished, failed, paused, queued or waiting task teams (ends the conversation, saves worktree changes as a patch and deletes the folder while keeping the branch, moves the team to finished teams). Same in team details, the team channel and the finished-teams list; it replaces "Clean up worktree". The Lead does the same when you ask it to close a team (archive_team).

## 1.0.0 — 2026-11-26

The first official release.

### Lead and teams
- Hand work to the Lead AI in a chat and it proposes a team (PM, developer, QA, reviewer, models, budget); approve it and the team is created and gets to work.
- Each team works separately in its own git worktree, and its stage (Plan → Build → Check → Report), to-dos, what each member is doing and its cost are shown in real time.
- When a team gets stuck it posts a question, and you answer with buttons in the Inbox. Production DB and deploy commands run only after human approval.
- Standing teams: always-on teams you instruct directly without going through the Lead (checks, incident response) that revive themselves if they die.
- Lead engine: pauses and resumes teams based on CPU and memory, and queues heavy commands (tests, builds).

### AI accounts
- Connect multiple Claude accounts, pick an account per role, and see plan usage per account.
- Usage-based switching (Off · Notify, switch with one click · Switch automatically): past the threshold, the next account is borrowed, and the original returns once the limit resets. Ongoing conversations continue even when the account changes.
- Codex (OpenAI) accounts: run as Separate session members that a PM delegates work to (sandboxed to the worktree, network off).

### Records and backup
- Every conversation, tool run, changed file and summary is stored in SQLite, with Korean-aware search (optional vector search).
- Backup: a folder on this Mac, Synology NAS (connected folder or WebDAV) and AWS S3 (including compatible services); automatic every 30 minutes to weekly, skipped when nothing changed, number of backups to keep, read-only "Browse", and restore.

### UI
- Messenger-style web UI (Mac and phone); phone access limited to your own devices via Tailscale; web push, Slack and macOS notifications.
- Mac app (DMG): first-run setup guide, honeycomb menu bar icon (working / needs you), macOS notifications.
- PRs (checks, reviews, merging), repository status, script buttons, git cleanup, 11 themes and text sizes.
