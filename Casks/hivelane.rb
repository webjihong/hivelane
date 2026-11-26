# Homebrew 설치 · 업데이트 / Install & update with Homebrew
#   brew tap webjihong/hivelane https://github.com/webjihong/hivelane
#   brew trust webjihong/hivelane    # Homebrew 7+: 외부 tap 허용
#   brew install --cask hivelane     # 설치 / install
#   brew upgrade --cask hivelane     # 새 버전으로 / update (서버는 일하는 팀이 없을 때 새 버전으로 저절로 다시 시작)
# version·sha256 은 릴리스 때 scripts/release.ts 가 바꾼다.
cask "hivelane" do
  version "1.0.2"
  sha256 "9f4b796056ea3cdea3e587dd5b5bf4ddeabde2b02048c8e7b563c3d4250c57c7"

  url "https://github.com/webjihong/hivelane/releases/download/v#{version}/Hivelane-#{version}-arm64.dmg"
  name "Hivelane"
  desc "Local control room that runs teams of Claude Code and Codex agents"
  homepage "https://github.com/webjihong/hivelane"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Hivelane.app"

  uninstall quit: "com.webjihong.hivelane.desktop"

  zap trash: [
    "~/Library/Application Support/Hivelane",
    "~/Library/LaunchAgents/com.webjihong.hivelane.plist",
  ]

  caveats <<~EOS
    The app is not notarized yet: on first launch macOS blocks it once — open System Settings › Privacy & Security › "Open Anyway".
    아직 Apple 공증 전이라 처음 한 번은 시스템 설정 › 개인정보 보호 및 보안 › 「그래도 열기」를 누르세요.
    Then click "Install server and start". / 그다음 「서버 설치하고 시작」을 누르세요.
    Update: brew upgrade --cask hivelane — the server switches to the new version once no team is working.
    업데이트: brew upgrade --cask hivelane — 일하는 팀이 없을 때 서버가 새 버전으로 저절로 다시 시작합니다.
    Your data in ~/.hivelane is kept. / 기록(~/.hivelane)은 지우지 않습니다.
  EOS
end
