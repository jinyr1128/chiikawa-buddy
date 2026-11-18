const lines = {
  "치이카와": {
    "idle": "에헤헤 (여기서 기다릴게)",
    "typing": "에? (나도 한 글자씩 톡톡!)",
    "ai": "에에… (AI랑 답을 찾고 있어)",
    "studying": "와…! (오늘 할 일, 해 볼게!)",
    "dancing": "에? (이것 좀 봐!)"
  },
  "하치와레": {
    "idle": "있지, 나 여기 있어!",
    "typing": "타닥타닥, 같이 쓰는 거야!",
    "ai": "AI랑 머리 맞대는 중이야!",
    "studying": "좋아, 하나씩 해 보자!",
    "dancing": "있지, 이거 봤어?"
  },
  "우사기": {
    "idle": "우나… (잠깐 쉬는 중!)",
    "typing": "우라라! (키보드다다다!)",
    "ai": "푸루루루! (AI 작업 중!)",
    "studying": "야하! (일한다!)",
    "dancing": "이야하~!!! (여기 봐!)"
  },
  "시사": {
    "idle": "여기서 기다리쿠다",
    "typing": "한 자씩 쓰고 있수다",
    "ai": "AI랑 답 찾고 있수다",
    "studying": "부지런히 일하고 있수다",
    "dancing": "요것 좀 봅서!"
  },
  "랏코": {
    "idle": "잠시 숨을 고르자.",
    "typing": "한 글자씩, 서두르지 마.",
    "ai": "AI와 함께 살펴보고 있어.",
    "studying": "집중하자. 내가 곁에 있어.",
    "dancing": "잠깐, 이쪽을 보렴."
  },
  "쿠리만쥬": {
    "idle": "캬아… (한숨 돌리자)",
    "typing": "캬 (톡톡, 글 쓰는 중)",
    "ai": "캬… (AI랑 궁리 중이야)",
    "studying": "캬 (슬슬 일해 볼까)",
    "dancing": "캬아 (이것 좀 봐)"
  },
  "모몽가": {
    "idle": "놀아 줄 때까지 기다릴래!",
    "typing": "봐 봐, 나도 타닥타닥!",
    "ai": "AI랑 일하는 나 좀 봐!",
    "studying": "나 일한다! 칭찬해 줘!",
    "dancing": "지금 나 좀 봐!"
  },
  "짭몽가": {
    "idle": "흥! 기다려 주는 거야!",
    "typing": "타닥타닥! 내가 칠 거라고!",
    "ai": "AI랑 일하는 중이란 말이야!",
    "studying": "흥! 벌써 일하고 있거든!",
    "dancing": "뭐어?! 이거 보라고!"
  },
  "찐몽가": {
    "idle": "…여기서 기다릴게…",
    "typing": "한 글자씩… 톡, 톡…",
    "ai": "AI랑… 열심히 해 보고 있어…",
    "studying": "나도… 조용히 일하고 있어…",
    "dancing": "저기… 한번 봐 줄래…?"
  },
  "카니": {
    "idle": "헤헤헤… (옆에서 기다릴게)",
    "typing": "으응? (톡톡, 같이 쓰자)",
    "ai": "으으으… (AI랑 생각 중이야)",
    "studying": "헤헤헤 (차근차근 일할게)",
    "dancing": "으아아~ (여기 좀 봐!)"
  },
  "세이렌": {
    "idle": "라라~♪ 기다리고 있어",
    "typing": "타닥타닥, 박자가 딱 맞네♪",
    "ai": "AI랑 답을 찾는 중이야♪",
    "studying": "룰루~ 오늘 일도 착착!",
    "dancing": "딩동♪ 들렸어?"
  },
  "아노코": {
    "idle": "후웅~ (여기서 쉴래)",
    "typing": "우우… (살살 두드릴게)",
    "ai": "후웅… (AI랑 답을 찾고 있어)",
    "studying": "우우! (나도 열심히 할게)",
    "dancing": "으앙! (이쪽이야!)"
  },
  "카니와 모몽가": {
    "idle": "모몽가: 아직이야? / 카니: 헤헤 (기다리자)",
    "typing": "모몽가: 내가 칠래! / 카니: 으응 (톡톡!)",
    "ai": "모몽가: AI랑 일한다고! / 카니: 헤헤 (같이!)",
    "studying": "모몽가: 내 일 봐! / 카니: 헤헤 (돕고 있어)",
    "dancing": "모몽가: 봐 봐! / 카니: 으응? (여기!)"
  }
};
const builtinNames = {
  "shisa": "시사",
  "hachi": "하치와레",
  "rakko": "랏코",
  "usagi": "우사기",
  "kuri": "쿠리만쥬",
  "momonga": "모몽가",
  "chiikawa": "치이카와",
  "kani": "카니"
};
export const statusNames = {
  "idle": "대기 중",
  "typing": "타이핑 중",
  "ai": "AI 작업 중",
  "studying": "업무 중",
  "dancing": "알림 · 리액션"
};
export function motionLine(id, meta, state) {
  const voice = lines[meta?.name] ?? lines[builtinNames[id]] ?? lines[builtinNames[meta?.from]];
  return voice?.[state] ?? statusNames[state];
}
