# 소개 글 초안 (사람이 직접 올림)

올리기 전에: 저장소 설명·토픽·홈페이지가 채워졌는지, 소개 페이지(https://webjihong.github.io/hivelane/)가 열리는지, 최신 릴리스에 DMG 가 있는지 확인한다.
링크 하나만 쓸 때는 소개 페이지를, 개발자 커뮤니티(HN·Reddit)에는 GitHub 저장소를 건다.

---

## Show HN (news.ycombinator.com/submit)

**Title:** Show HN: Hivelane – a local control room that runs teams of Claude Code agents on your Mac

**URL:** https://github.com/webjihong/hivelane

**First comment:**

I kept running five Claude Code sessions in five terminals and losing track of who was doing what, while my laptop fans screamed during parallel builds. Hivelane is my attempt to turn that into something closer to a small company:

- You chat with a "Lead" agent. It proposes a team for the task (PM + developer + QA, models, budget). You approve, and the team works in its own git worktree.
- A resource engine samples CPU/memory every 5s and pauses/resumes teams; heavy commands (tests, builds) go through a queue so parallel teams don't melt the machine.
- Questions from teams land in one inbox with answer buttons. Production DB / deploy commands always need human approval, and release creation needs approval for that exact command, once.
- Multiple Claude accounts and Codex accounts per role; when one hits its usage limit it switches to the next and keeps the same conversation (it moves the session file).
- Everything (chat, tool calls, diffs) is stored in SQLite, searchable, and can be backed up to a folder, a Synology NAS or S3.

It's local-only (Node server + messenger-style web UI, phone access via Tailscale), MIT, macOS/Apple silicon. It uses your existing Claude subscription through the Agent SDK — no API key. UI is in English and Korean.

Happy to hear what breaks, and whether the "Lead proposes a team" model is useful or just gets in the way.

---

## Product Hunt

**Name:** Hivelane
**Tagline (60):** A control room for AI dev teams on your Mac
**Topics:** Developer Tools, Artificial Intelligence, Mac, Open Source
**Description (260):** Tell the Lead AI what you need; it sets up teams of Claude Code and Codex agents (PM, dev, QA) that work in parallel in git worktrees on your Mac. It watches CPU/memory, asks you only when a decision is needed, and works from your phone too. Free and open source.
**Gallery:** docs/images/en/po-chat.png, team-detail.png, now.png, mobile.png, backup.png
**Maker comment:** (Show HN 첫 댓글을 줄여서)

---

## Reddit (r/ClaudeAI · r/ClaudeCode · r/macapps · r/SideProject)

**Title:** I built a local "control room" that runs several Claude Code teams in parallel on one Mac (open source)

**Body:**

Hivelane lets you hand work to a Lead agent in chat. It proposes a team (PM, dev, QA), each team works in its own git worktree, and you only answer when a decision is needed — from your Mac or phone.

What I found useful in daily use:
- CPU/memory-aware scheduling: teams pause and resume instead of freezing the laptop
- One inbox for all questions; prod DB/deploy commands require approval
- Several Claude/Codex accounts per role with automatic switching at a usage threshold, same conversation continues
- Searchable history + backups (folder / NAS / S3)

Install: `brew tap webjihong/hivelane https://github.com/webjihong/hivelane && brew install --cask hivelane`
Repo: https://github.com/webjihong/hivelane (MIT)

(r/macapps 는 홍보 글 규칙이 있으니 올리기 전 사이드바 규칙 확인)

---

## GeekNews (news.hada.io) · 디스콰이엇

**제목:** Hivelane – 맥 한 대에서 Claude Code 팀 여러 개를 동시에 돌리는 오픈 소스 관제실

**본문:**

총괄 AI에게 말로 일을 맡기면 PM·개발·QA 팀을 꾸려 업무마다 git worktree에서 동시에 일하게 하는 맥 앱입니다.

- 총괄 엔진이 CPU·메모리를 보고 팀을 멈추고 다시 돌리며, 테스트·빌드 같은 무거운 명령은 대기열로 돌립니다.
- 팀의 질문은 「지금 볼 것」에 모여 단추로 답하고, 운영 DB·배포 명령은 사람 승인을 거칩니다.
- Claude·Codex 계정을 역할마다 고르고, 사용량이 기준을 넘으면 다음 계정으로 바꿔 하던 대화를 이어 갑니다.
- 대화·명령·변경 기록을 검색하고 맥 폴더·시놀로지 NAS·S3 에 백업합니다.
- 휴대폰은 Tailscale 로 내 기기에서만, 화면은 한국어·영어.

설치: `brew tap webjihong/hivelane https://github.com/webjihong/hivelane && brew install --cask hivelane`
저장소: https://github.com/webjihong/hivelane (MIT)
