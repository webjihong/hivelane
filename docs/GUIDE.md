[한국어](ko/GUIDE.md) · **English**

# User guide

## 1. Screen layout

```
┌──────────────┬──────────────────────────────────────┐
│ Inbox      3 │                                      │
│ Lead         │   Center: the selected channel       │
│ Scripts      │   (Inbox / Lead chat / team channel /│
│ Standing team ＋ │    PRs / Scripts / Settings)         │
│ Task teams   │                                      │
│ ──────────── │                                      │
│ Repositories · PRs │                                      │
│ [OK] CPU Memory                                     │
│ [Tokens] 69% used (resets Thursday)                 │
│ [Auth] Login expires 12/12   [Re-authenticate]      │
└──────────────┴──────────────────────────────────────┘
```

- **Channel dots**: blinking green = working · red = needs your decision / failed / down · yellow circle = paused · dotted = queued · gray = idle. The number next to it is unread replies.
- **Phone**: the first screen is the channel list. The bottom tabs are Chat · PR · Scripts · Settings.

### Inbox

Gathers everything that needs your answer (PM questions, command approval requests, failures, team proposals), what's new (new replies, new PRs), teams that are working, and open PRs on a single screen. You can answer directly with the buttons on a question card.

## 2. Handing work to the Lead

In the Lead channel, give instructions the way you'd normally talk.

> In the my-app repository, fix the show-password button on the login screen. Include tests.

1. The Lead refines the task and posts a **team proposal card** (project, template, roles, models, budget).
2. Edit the card or **approve** it as is; the team is created and goes into the queue. (Auto-approval can be turned on in Settings.)
3. The engine checks resources and starts the team. The team works in a worktree dedicated to the task (branch `hivelane/<task id>`).
4. When it's done, the PM reports and you get a notification. Changed files and summaries are kept in the team details.

You can also ask the Lead for things like these:

| What you say | What the Lead does |
| --- | --- |
| "Who changed what in payments yesterday?" | Answers by searching the records |
| "Pause the app team" / "Do that one first" | Pause, resume, priority |
| "Why is my Mac slow?" | Diagnoses who's using CPU and memory |
| "Clean up git" | Shows unused worktrees and local branches split into Removable / Needs review / Kept → "Delete the removable ones" |
| "Learn this" / "Remember this" / "Forget that" | The Lead remembers procedures and facts (view and edit them under "What the Lead has learned") |
| "Create a check team" | Creates a standing team |

## 3. Team channels

- Your instructions appear on the right, the PM and Lead on the left. Hand-offs and reports exchanged between team members are collapsed into a single line.
- **PM questions and command approval requests** appear as cards above the input box. Click a button or answer in your own words and the team gets back to work right away.
- Instructions you send while the team is working are applied at the next step. **Cancel run** interrupts what it's doing right now.
- Buttons at the top: Pause / Resume / Restart, PRs from this team, **Team details** (to-dos, changed files, decision log, per-member activity stream, standing brief, environment).

### Standing teams

Create one with "**Standing team ＋**" in the channel list. Enter a name, project, template and standing brief, plus an optional check command and check interval.
If the check command fails (exit code ≠ 0), the team wakes up and looks at the output. Otherwise it uses no tokens.

**Environment**
- `Isolated` (default): reads only the repository's rules and uses only the tools for its role.
- `My environment`: uses your own global Claude Code settings, plugins, skills and MCP servers as is. Production commands show an approval card before they run; approving runs just that one command, once.

### Cleaning up worktrees and branches

When there are worktrees or local branches to clean up, a **Clean up worktrees & branches N** button appears next to "Finished teams" in the channel list (registered repositories are scanned every 10 minutes).
To clean up just one finished team, click **Clean up worktree** at the top of its team channel, to the left of "Team details" (the branch is kept · if there are uncommitted changes, it lists the files and asks once more).
Clicking the button shows a list per repository split into **Removable** (pre-checked) · **Needs review** (checking these discards uncommitted changes and commits that exist nowhere else) · **Kept** (in use, used in the last 12 hours, or the base branch; never deleted), and only what you select is deleted. Deleting only works on the Mac. Asking the Lead to "clean up git" uses the same rules.

### Finished teams · cleanup log

- Expanding "Finished teams" in the channel list shows the 20 most recent, and **View all** at the bottom takes you to the full finished-teams page (`#finished`). There you can search, filter by status (Done, Failed, Archived) and by repository, and load 50 more at a time. Teams that were archived after their worktree was cleaned up can also be opened here.
- The **Cleanup log** tab (`#finished/log`) shows, newest first, the worktrees and branches deleted from the UI, by the Lead, with team buttons, or automatically.
- Right before deleting a worktree, its changes (committed + uncommitted + new files) are saved to `~/.hivelane/archive/*.patch`. For branches that had unique commits, a commit patch and a restore command (`git branch <name> <sha>`) are saved. You can view them with **View changes** in the cleanup log or the file diff in team details, and the Lead can read them too. To restore, run `git apply <patch>` in the repository.
- **Auto-cleanup**: worktrees of task teams that finished more than 7 days ago (Settings › Lead & engine › Auto-clean finished team worktrees; 0 turns it off) are saved as patches and deleted. Branches are kept, and locked worktrees or ones with a program running inside are skipped.
- The UI only loads working teams and recently finished ones (within 7 days or the latest 20), so it stays fast even with hundreds of finished teams.

## 4. PRs

For each registered repository, open PRs and recently merged/closed PRs are fetched with `gh pr list` every 2 minutes.
Click a PR to expand its checks (with log links), reviews and mergeability, then pick a merge method (Merge commit, Squash, Rebase) and merge. This works from your phone, too. If protection rules or conflicts get in the way, GitHub refuses and the reason is shown.

The **repository** lines at the bottom of the sidebar run `git fetch` every 5 minutes to show ahead/behind counts and the number of uncommitted files; if you're behind, a **Pull** button appears.

## 5. Script buttons

Turn terminal commands you use often into buttons and run them from your Mac or phone.

1. **Scripts › Add** (on the Mac): project, name, command, working folder. "Pick from package.json scripts" lets you choose an `npm run …` directly.
2. For risky commands like production deploys or databases, turn on **Confirm before running** (it's turned on automatically if the name contains prod, deploy, db:, etc.).
3. When it runs, the output streams in real time, and the exit code and the last 10 runs are kept. It's stopped after 1 hour. `sudo` and `rm -rf /` are blocked.

## 6. Sidebar status lines

| Line | Contents |
| --- | --- |
| OK / Busy / Overloaded · CPU · Memory | The zone the Lead engine sees. Click to see who's using your Mac (Claude Code sessions, apps, each Hivelane team) |
| Tokens | Usage against your Claude plan limit and when it resets. Refreshed every 5 minutes (a lookup that uses no tokens) |
| Auth | When your Claude login expires (re-authenticating before then extends it). **Re-authenticate** runs the same login as `claude auth login` from the UI (open the link → log in → if a code appears, paste it) |

## 7. Settings

| Section | Contents |
| --- | --- |
| Display | Language (한국어 / English · by default the language chosen on the Mac app's setup screen), 11 themes (Default + 10 presets) and text size per area (left list, page, chat, input box) · all saved on this device only |
| Lead & engine | AI reply & notification language (한국어 / English · the language the Lead and teams answer in and that notifications and system messages use, separate from the screen language; by default the language chosen on the Mac app's setup screen (English if none)), Lead model, auto-approve team plans, default task budget, context limit, auto-clean finished team worktrees (7 days by default) · yellow/red zone thresholds, number of concurrent teams, heavy command slots |
| AI accounts | Organized in tabs ("Default & switching" · one tab per account · "+ Add account") · connect several Claude accounts (each keeps its own login · Log in button → approve in the browser) · add Codex (ChatGPT / OpenAI) accounts too (device code login or API key · "This Mac's Codex" uses ~/.codex) · once you add your own Claude account, "This Mac's default account" (~/.claude, the same login as Claude Code in the terminal) is hidden · plan usage per account (5-hour and weekly for Codex) · usage-based switching keeps the accounts you picked and only borrows the next account while one is over the threshold · choose the default account and the Lead account · when an account changes, the conversation file is moved to the new account so the same conversation continues (a new conversation from a summary only if the file can't be found) |
| Projects | Repository (choose in Finder · "Initialize git here" if it isn't a git repository · if there's no remote, "Connect remote" creates a new one on GitHub or links an existing URL), base branch, packages in team worktrees (link node_modules, install fresh, or none), dependency mode, default template, git permissions, protected branches, blocked/heavy commands |
| Standing teams | Create and shut down |
| Notifications | Reminder interval for unread replies, Slack webhook, web push |
| Remote access | Owner Tailscale account |
| Search | Used when the Lead looks up past records (team conversations, summaries, changed files, what it has learned, Lead conversations). Records are indexed automatically as they're created, and records missing vectors are filled in every 10 minutes. Shows index status (vector count, model, last indexed, errors). Vector search (Ollama or Voyage), otherwise full-text search only. Ollama can be installed (brew), started and its model downloaded with buttons in Settings › Search; Hivelane starts it when it starts and stops it when it stops (Homebrew itself needs your admin password, so install it yourself in a terminal) |
| Storage | What takes up how much space in the DB (activity logs, indexes, conversations, etc.), folder sizes (worktrees, patches, logs, images) and Ollama model size, DB compaction |
| Backup | Conversations, summaries, activity logs, settings and uploaded images in a single file (tar.gz) · automatic backup (off / every few hours (30 min, 1, 2, 3, 6, 12 hours) / daily / weekly · day and time; if missed, runs as soon as the Mac wakes; skipped if nothing changed) · keep the latest N · destinations: a folder on this Mac · Synology NAS (a folder connected in Finder, or WebDAV) · AWS S3 (including compatible services), several at once · passwords and secret keys are stored in the macOS Keychain · "Browse" shows that point in time's team conversations, summaries, activity logs and Lead conversations read-only · "Restore" first backs up the current state, then restarts the server and swaps it in (settings live in ~/.hivelane/backup.json, so they stay the same after a restore) |
| Team templates | A set of roles (name, model, account, run mode, tools, instructions) · an empty account means the default account; members called through the Agent tool use the PM's account · Codex accounts can only be picked for "Separate session" members (read tools → read-only sandbox, verify/write → write access to the worktree only · network off · model is the Codex default) |

## 8. AI accounts and models

Hivelane decides **who (which account) works with which model** per team and per role, and keeps work going when an account hits its limit.

### Connecting accounts (Settings › AI accounts)

| Type | How to connect | Where it can be used |
| --- | --- | --- |
| Claude | "+ Add account" › Claude › "Log in" → approve in the browser (if a code appears, paste it) | Lead · PM · all team members |
| Codex (OpenAI) | "+ Add account" › Codex › "Log in" → open the link and enter the one-time code shown, or use an OpenAI API key | "Separate session" members that a PM delegates work to |

- Each account keeps its own login (`~/.hivelane/accounts/…`). You can connect work and personal accounts side by side.
- Each account tab shows **plan usage** (5-hour and weekly %) and when it resets.
- Once you add your own Claude account, "This Mac's default account" (the same login as Claude Code in the terminal) is hidden. Switching accounts with `/login` in the terminal doesn't change the team accounts.

### Who uses which account and model

| Who | Where it's set | Model | Account |
| --- | --- | --- | --- |
| Lead | Settings › Lead & engine (model), Settings › AI accounts (Lead account) | Opus/Sonnet/Haiku | Lead account (default account if empty) |
| A team's PM | The `pm` role in the team template | Per role | Per role (default account if empty) |
| Separate session members | A role in the team template (run mode "Separate session") | Per role | Per role · **Codex accounts allowed** |
| Subagent members | A role in the team template (run mode "Subagent") | Per role | Same account as the PM |

For example, you can mix within a single team: "PM on Opus with the work account, developer on Sonnet with the personal account, reviews by Codex". When the Lead proposes a team it follows the template's setup, and you can change it on the proposal card.

### When a limit is reached: usage-based switching and continuing conversations

1. In Settings › AI accounts › "Default & switching", choose the mode (Off · Notify, switch with one click · Switch automatically), the threshold (e.g. 90%) and the switch order.
2. When an account's usage goes over the threshold, **your settings stay as they are**; only the places that were using that account borrow the next account in order (logged in, below the threshold, and of the same kind). It shows as "Borrowing".
3. When the limit resets and the original account drops below the threshold, it switches back automatically.
4. Even when the account changes, **the ongoing conversation (session) continues as is.** The conversation file is moved over to the new account, so members don't need to be briefed again from scratch (only if the file can't be found do they start over with a handed-over summary).

Switching only happens between Claude accounts, or between Codex accounts. Creating several subscriptions as the same person to get around limits may violate the services' terms, so connect accounts that are genuinely different, such as work and personal.

## 9. Safety rails

- Teams can't write outside their own worktree (guards on write tools and shell redirection).
- By default, commits, pushes, reset, rebase, worktree operations, production DB/deploy commands and sudo are blocked (adjustable per project). **Merging is done by a human.**
- You can set a cost cap per task; when it's exceeded, a human is asked.
- Remote access is allowed only for the owner account. Settings can only be changed on the Mac.
- The Lead's deleting actions (git cleanup, shutting down standing teams, etc.) only run in a turn responding to a message you sent. Worktrees and branches that another Claude session might be using are left alone.
