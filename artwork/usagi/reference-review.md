# 우사기 자산 레퍼런스

기본 외형과 상태별 동작을 따로 대조했다. 공식 참고 이미지 자체를 앱 자산으로 복사하지 않고, 내장 image_gen으로 생성한 팬 아트를 사용한다. 생성 원본·프롬프트·최종 자산은 저장소에 함께 보관한다.

| 자산 | 참고 자료 | 반영한 요소 |
|---|---|---|
| 기본 | [애니메이션 공식 캐릭터 소개](https://www.anime-chiikawa.jp/chara.html) | 크림색 몸, 긴 분홍색 귀 안쪽, 진한 윤곽선, 작은 손발 |
| 집중 | [키탄클럽 공식 상품](https://kitan.jp/products/chiikawa_cardboardwatch2/) | 파란 필기구와 종이·책상 자세 |
| 춤 | [영화 공식 사이트](https://chiikawa.toho-movie.jp/#homeTrailer)가 연결하는 [도호 공식 랩 영상](https://www.youtube.com/watch?v=sT1A-4zjKqQ) | 선글라스·금색 목걸이·마이크. 무대·자막·음원 제외 |
| 응원·일정 알림 | [원작자 게시물](https://x.com/ngnchiikawa/status/1452645677792567297)의 만화 이미지와 애니메이션 134화 장면 | 양손의 치타라로 날개짓하며 점프. 치즈 한 줄·대구포 두 줄은 중앙에서만 연결하고 양끝을 펼침 |

랩 시트는 머리 옆의 불필요한 돌출 부분을 제거하고 작고 둥근 손으로 정리했다. 마이크 방향을 유지하며, 치타라 시트는 네 자세의 간식 여덟 개에서 세 갈래·양끝 모양을 대조했다. 기본 표정에는 임의의 감은 눈을 추가하지 않았다.

각 시트는 네 자세를 반복하며 응원·알림에는 최대 48px 점프를 더한다. 자세별 머리 너비와 발바닥 기준은 [alignment.json](alignment.json)에 기록했다. 역할·URL·원본 해시는 [references.json](references.json), 생성·편집 지시는 [prompts.json](prompts.json)에 있다.

공식 제작물이 아니며 원작 캐릭터의 권리는 © Nagano / chiikawa committee에 있다. 코드의 MIT 라이선스와 캐릭터 자산의 권리는 별개다. 기존 저장소의 캐릭터 자산 이용 조건을 함께 따른다.
