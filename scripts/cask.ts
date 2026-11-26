/** Homebrew cask(Casks/hivelane.rb) 의 version·sha256 줄만 바꾼다(릴리스 스크립트가 쓴다) */
export function bumpCask(src: string, version: string, sha: string): string {
  return src.replace(/^(\s*version\s+)"[^"]*"/m, `$1"${version}"`).replace(/^(\s*sha256\s+)"[^"]*"/m, `$1"${sha}"`);
}
