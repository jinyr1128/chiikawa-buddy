#!/bin/sh
# launchd 등록 해제(데이터 ~/.cy-agent 는 남긴다)
for l in com.cy-agent.daemon com.cy-agent.desktop; do
  launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$l.plist"
done
echo "✓ 해제 완료"
