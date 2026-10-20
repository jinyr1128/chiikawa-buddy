# 치이카와 매니저 한 번에 설치(윈도우 10·11). 저장소 폴더에서:
#   powershell -ExecutionPolicy Bypass -File ops\setup-win.ps1
#  1) 이 폴더를 받아 온 GitHub 저장소의 릴리스에서 윈도우 설치 파일(ChiikawaManager-<버전>-Setup.exe)과 캐릭터 묶음(있으면)을 받아 SHA-256 으로 검증한다
#  2) 설치한다(관리자 권한 필요 없음 · %LOCALAPPDATA%\ChiikawaManager). 바탕 화면·시작 메뉴 바로 가기, 로그인할 때 자동 실행
#  3) 캐릭터 묶음을 %USERPROFILE%\.cy-agent 에 넣고, Claude Code 가 있으면 AI 를 Claude Code 로 정하고 Claude Code 연동(hook)을 켠다
#  4) 앱을 켠다. Slack·메일·캘린더·노션은 앱의 「연결 관리」에서 각자 계정으로
# 옵션: -NoHooks (Claude Code 연동 안 켜기) · -Repo owner/name (다른 저장소에서 받기)
param([switch]$NoHooks, [string]$Repo = '', [switch]$UpdateOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Say($t) { Write-Host "`n▶ $t" -ForegroundColor Cyan }
function Die($t) { Write-Host "`n✖ $t" -ForegroundColor Red; exit 1 }

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Repo) {
  try { $u = (git -C $Root remote get-url origin 2>$null); if ($u -match 'github\.com[:/]([^/]+/[^/.]+)') { $Repo = $Matches[1] } } catch {}
}
if (-not $Repo) { $Repo = 'jinyr1128/chiikawa-manager' }

$HomeDir = if ($env:CY_AGENT_HOME) { $env:CY_AGENT_HOME } else { Join-Path $env:USERPROFILE '.cy-agent' }
$existingApp = Join-Path $env:LOCALAPPDATA 'ChiikawaManager\Update.exe'
if ((Test-Path $existingApp) -or (Test-Path (Join-Path $HomeDir 'config.json'))) { $UpdateOnly = $true }
if ($UpdateOnly) { $NoHooks = $true; Say "기존 설치 확인 — 연결·설정·캐릭터를 유지하고 앱만 업데이트" }

Say "윈도우 확인"
if ($env:OS -ne 'Windows_NT') { Die "윈도우에서만 돼요." }
$Work = Join-Path $env:TEMP ("chiikawa-setup-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Work | Out-Null

Say "GitHub 릴리스에서 앱·캐릭터 받기 ($Repo)"
$H = @{ 'User-Agent' = 'chiikawa-manager-setup'; 'Accept' = 'application/vnd.github+json' }
try { $rels = Invoke-RestMethod -Headers $H -Uri "https://api.github.com/repos/$Repo/releases?per_page=30" } catch { Die "릴리스 목록을 못 받았어요. 인터넷 연결을 확인해 주세요. ($($_.Exception.Message))" }
$win = $rels | Where-Object { -not $_.draft -and $_.tag_name -like '*-windows' } | Select-Object -First 1
if (-not $win) { Die "윈도우 릴리스가 아직 없어요(태그 v<버전>-windows)." }
$main = $rels | Where-Object { -not $_.draft -and $_.tag_name -notlike '*-windows' } | Select-Object -First 1
$setupAsset = $win.assets | Where-Object { $_.name -match '-Setup\.exe$' -and $_.name -notmatch '-arm64-Setup\.exe$' } | Select-Object -First 1
$sumAsset = $win.assets | Where-Object { $_.name -like 'SHA256SUMS*win-x64.txt' } | Select-Object -First 1
if (-not $setupAsset -or -not $sumAsset) { Die "윈도우 설치 파일을 찾지 못했어요($($win.tag_name))." }
function Get-Asset($a) { $p = Join-Path $Work $a.name; Invoke-WebRequest -Headers @{ 'User-Agent' = 'chiikawa-manager-setup' } -Uri $a.browser_download_url -OutFile $p -UseBasicParsing; return $p }
function Test-Sum($file, $sumFile) {
  $want = (Get-Content $sumFile | Where-Object { $_ -match ([regex]::Escape((Split-Path -Leaf $file)) + '$') } | Select-Object -First 1)
  if (-not $want) { Die "검증 목록에 $(Split-Path -Leaf $file) 이(가) 없어요." }
  $got = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if (-not $want.ToLower().StartsWith($got)) { Die "다운로드 파일 검증에 실패했어요: $(Split-Path -Leaf $file)" }
  Write-Host "$(Split-Path -Leaf $file): OK"
}
$setup = Get-Asset $setupAsset; $sums = Get-Asset $sumAsset; Test-Sum $setup $sums
$pack = $null
if ($main -and -not $UpdateOnly) {
  $packAsset = $main.assets | Where-Object { $_.name -eq 'chiikawa-characters.zip' } | Select-Object -First 1
  $packSum = $main.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if ($packAsset -and $packSum) { $pack = Get-Asset $packAsset; $ps = Get-Asset $packSum; Test-Sum $pack $ps }
}
if (-not $pack) { Write-Host "캐릭터 묶음 없음 — 기본 캐릭터 8명으로 시작해요." }

Say "앱 설치(%LOCALAPPDATA%\ChiikawaManager)"
Get-Process -Name 'ChiikawaManager' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $setup -ArgumentList '--silent' -Wait
$base = Join-Path $env:LOCALAPPDATA 'ChiikawaManager'
$appDir = Get-ChildItem -Path $base -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $appDir) { Die "설치 폴더를 찾지 못했어요: $base" }
$exe = Join-Path $appDir.FullName 'ChiikawaManager.exe'
Start-Sleep -Seconds 3
Get-Process -Name 'ChiikawaManager' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue  # 설정을 넣는 동안 잠깐 끈다

# 앱 안의 Electron 을 Node 로 쓴다(Node.js 를 따로 깔지 않아도 되게)
function Run-Node { param([Parameter(ValueFromRemainingArguments = $true)]$Args2) $env:ELECTRON_RUN_AS_NODE = '1'; & $exe @Args2; $code = $LASTEXITCODE; Remove-Item Env:ELECTRON_RUN_AS_NODE; return $code }
$HomeDir = if ($env:CY_AGENT_HOME) { $env:CY_AGENT_HOME } else { Join-Path $env:USERPROFILE '.cy-agent' }
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null

if ($pack -and -not $UpdateOnly) { Say "캐릭터 넣기"; Run-Node (Join-Path $Root 'ops\character-pack\import.mjs') $pack | Out-Null }

$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
$cfgPath = Join-Path $HomeDir 'config.json'
if (-not $UpdateOnly -and -not (Test-Path $cfgPath)) {
Say "처음 설정"
$cfg = @{}
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
if (-not $cfg.ContainsKey('brain') -and $hasClaude) { $cfg['brain'] = @{ provider = 'claude-code' } }
if ($cfg.ContainsKey('brain') -and -not $cfg.ContainsKey('onboarded')) { $cfg['onboarded'] = $true }
if (-not $cfg.ContainsKey('calendarAlert')) { $cfg['calendarAlert'] = @{ minutesBefore = @(30, 10) } }
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
if ($hasClaude) { Write-Host "AI: Claude Code" } else { Write-Host "AI: 앱을 켜면 고르는 화면이 나와요" }

}

if (-not $NoHooks) {
  Say "AI 작업 연동"
  if ((Test-Path (Join-Path $env:USERPROFILE '.claude')) -or $hasClaude) { Run-Node (Join-Path $Root 'ops\claude-hooks.mjs') 'on' | Out-Host } else { Write-Host "Claude Code 없음 — 건너뜀(나중에 앱 「연결 관리」에서 켤 수 있어요)" }
  if (Test-Path (Join-Path $env:USERPROFILE '.codex')) { Write-Host "Codex: 기록을 자동으로 지켜봐요(설정 필요 없음)" }
}

Say "앱 켜기"
Start-Process -FilePath (Join-Path $base 'Update.exe') -ArgumentList '--processStart', 'ChiikawaManager.exe'
$ok = $false; for ($i = 0; $i -lt 40; $i++) { try { Invoke-RestMethod -Uri 'http://127.0.0.1:47823/health' -TimeoutSec 1 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 1 } }
if (-not $ok) { Write-Host "앱이 아직 안 켜졌어요 — 시작 메뉴에서 「치이카와 매니저」를 열어 주세요." }
Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue

Write-Host @"

🎉 설치 끝! 작업 표시줄 오른쪽 알림 영역(시계 옆, 안 보이면 ^)의 캐릭터 얼굴 아이콘 → 「홈」, 캐릭터는 「캐릭터 바꾸기」에서.
기존 계정 연결·설정·기록은 유지됩니다. 처음 설치한 분만 「연결 관리」에서 연결하세요:
  • Slack · 메일(Gmail 앱 비밀번호) · 캘린더(iCal 비공개 주소) · 노션 · GitHub
처음 실행할 때 파란 「Windows의 PC 보호」 창이 뜨면 「추가 정보」 → 「실행」.
"@
