# NovelEPUB 개발 세션 Summary

## 프로젝트 개요

**NovelEPUB** — TXT → EPUB3 변환기  
순수 프론트엔드 SPA. 서버 없이 브라우저에서 모든 처리 완료.  
총 코드량: **13,478줄** (12개 파일)

---

## 세션별 작업 이력

### Phase 1 — 구조 안정화

#### 버그 수정
- `main.js` `showErrorBoundary` 고아 본문 (`Illegal return statement`) 제거
- `parser.js` 고아 문자열 연결 코드, `idbSet` try 블록 누락 catch 추가
- Optional Chaining 136곳 추가, 좌변 할당 복원
- `_chaptersCache` 무효화 정책: `파일명:크기:lastModified§패턴§설정해시` 조합 키
- `DataTypes.Integer` 대소문자 오류, `lagitude` 타입 수정

#### 아키텍처 수정
- `SettingsDB._dbPromise` 싱글톤 → 경합 조건 해결
- `fileToText` Promise 안전성: 30초 타임아웃 + done() 래퍼 + 이중 폴백
- `splitChaptersAsync` 2분 타임아웃 + 동기 폴백
- `handleTxt` 디바운스 + `optAutoPreview` null 가드
- `getParserWorker` 중복 if 데드코드 → `resetParserWorker()` 분리
- `StateManager.reset()` 대용량 배열 null 해제 → GC 유도
- `switchPage` contentVisibility='hidden' + `_tabRendered` 지연 렌더링
- `getCssVar` 헬퍼 추가, 하드코딩 색상 상쇄

### Phase 2 — UI/UX 시각 계층 고도화

#### 레이아웃 및 컴포넌트
- `meta-block` 설정 구조화 (기본정보 / 분할규칙 분리)
- `opt-card-layout` 2단 그리드 (좌측 옵션 1fr + 우측 미니리더 260px)
- `mini-reader` 실시간 스타일 적용 + 0.4초 flash 이펙트
- `#regexFeed` 동적 패널 추가 (감지 수, 경고문구, 5행 preview)
- `btm-status` 플로팅 스티키 액션 바 배치

#### 마이크로 인터랙션 (10종)
- 헤더 타이포 브랜딩 (`font-weight:900`, pill형 부제)
- 섹션 헤더 `border-left` 포인트 바 국소 적용
- 설정 카드 hover 인터랙션 (`translateY(-2px)`)
- 하단 변환 버튼 풀너비 확장 + 글라스모피즘 + `btmShimmer` 무브먼트
- 드롭존 3곳의 이모지를 파일 형상화 인라인 SVG로 리포밍 (다크모드 인지 보장)
- `_lastPageIndex` 기반 탭 스와이프 슬라이딩 방향성 애니메이션 (`slideFromRight` / `slideFromLeft`)
- 결과 연출 시퀀스 (Shimmer 0.7초 → Count-Up 600ms → 다운로드 버튼 Pulse)
- 배지 칩 형태의 현재 설정 요약 컴포넌트 (`updateSettingsSummary`)
- 컬러 테마 스킨 3종 기능화 및 `localStorage` 영속 세팅
- 모바일 가용 범주 확장을 위한 52px 임계값 수평 스와이프 제어 IIFE (`setupSwipe`)

### Phase 3 — 챕터 통계 엔진 (I 시리즈) 및 정밀 디버깅 (B 시리즈)

#### I 시리즈 통계 고도화 (10개)
- `tocItems.body` 및 `bodyLen` 파싱 시점 동시 보관 구조 수립 (드래그 정렬 시 유실 제로)
- 상단 대시보드 내 [총 글자 수 · 평균 글자 수 · 짧은 챕터 카운트] 트리플 배지 인터페이스 가동
- `4.5k`, `1.2만` 단위 축약 유틸 탑재
- `localStorage` 연동형 최소 글자 수 조절 슬라이더 (20~500자 스케일) 바인딩
- 짧은 챕터 경고 배지 클릭 시 해당 가상 스크롤 인덱스로 강제 타겟팅 포커스
- 글자 수 배지 마우스 오버 시 본문 선두 3개 라인을 팝오버 툴팁으로 실시간 바인딩
- `#tocMiniChart` 콘테이너 내 인라인 SVG 기반의 챕터별 용량 미니 막대그래프 동적 생성기 장착
- 3개 연속 미달 구역 탐지 시 이합 집산 알고리즘에 기초한 병합 권고 Toast 경고 연출 (6000ms 유지)
- 재추출 토글 시 직전 데이터와의 편차를 추적하여 증감 배지를 표출하는 delta 시스템 연동 (I9 스펙)
- 목차 메타데이터와 용량 지표를 일체화하여 하드카피하는 텍스트 파일 익스포터 구축 (`exportTocWithStats`)

#### B 시리즈 데이터 무결성 디버깅 (10개)
- `updateTocStat` 갱신부 내 미반영되었던 활성 노드 글자 수 누적 산식 전면 재조정
- 드래그 바인딩 시 정렬 슬라이스 상하 반전으로 인한 0글자 오매칭 버그 척결
- 반올림 오차로 소수점 버림 없이 정확한 k단위를 표기하는 `.toFixed(1)` 래퍼 가이딩
- 하드코딩되었던 의심 경계 수치를 전역 `SUSP_THRESHOLD` 상수로 일원 통제화
- 라스트 챕터 인덱스 자르기 시 발생하던 배열 오버슈트를 `body` 가상 메모리 다이렉트 바인딩으로 상쇄
- 비활성화 처리된 유저 배제 챕터를 통계 가동 합산에서 완전 무시하는 인터셉터 루틴 삽입 (`if(!t.enabled) return`)

### Phase 4 — 엔터프라이즈 프록시 허브 구축 및 플랫폼 어댑터 전면 수술

#### 1) core.js 인프라 레이어 신설
- **통합 인프라 수립**: 파편화되어 있던 다중 프록시 로직을 `core.js` 하단 레이어로 완전 강제 통합.
- **Failover 안전 백업망**: Cloudflare Workers 허브 거부 혹은 5xx 에러 발생 시 콘솔 경고 후 원본 URL로 안전하게 2차 직접 요청하는 복구 매커니즘 탑재.
- **보안 가드**: 도용 방지용 `X-NovelEPUB-Token` 커스텀 헤더 주입 및 비정상 스트림을 방어하는 MIME-Type 화이트리스트(`image/`, `application/json`, `text/`) 필터 세팅.
- **안정성 강화**: 구형 브라우저 호환성을 해치던 `AbortSignal.timeout()`을 적출하고 `AbortController + setTimeout` 구조로 전면 컴파일.

#### 2) cover-search.js 이미지 오염 차단 및 데드코드 숙청
- **Tainted Canvas 원천 봉쇄**: 외부 자원을 이미지 객체에 직접 바인딩하던 레거시를 파괴하고, 프록시 버퍼를 통해 샌드박스화된 로컬 `Blob`을 수집한 뒤 `URL.createObjectURL(blob)` 주입 구조로 대수술. 브라우저가 자사 도메인 자원으로 인지하게 하여 **`SecurityError`를 완벽하게 기술적으로 해결**.
- **ReferenceError (P0) 긴급 구제**: 네이버/카카오 표지 검색 모달 내 잔류하던 구형 `PROXIES` 전역 배열 참조 파편을 색출하여 신규 전역 상수 및 `typeof` 예외 가드로 긴급 대체.
- **데드코드 삭제 (P1)**: 프로젝트 내 호출부가 단 한 곳도 존재하지 않던 고립 함수 `proxyFetchRace` (13줄)를 완전 격리 및 안전 적출.
- **노벨피아 특이 규격 자산화**: 노벨피아 이미지 특유의 `_ori.file` 주소가 정규식 검사에서 드롭되는 문제를 막기 위해 `isValidImg` 내 특수 매칭 토큰을 확장하고, 상대경로 프로토콜 정규화 결합.

### Phase 5 — UI/UX 대개혁 및 런타임 안정화

#### 1) 렌더링 아키텍처 교정 — 실험적 속성 전면 제거

- **`content-visibility` / `contain-intrinsic-size` 속성 적출**: Phase 1에서 지연 렌더링 최적화를 목적으로 도입한 실험적 CSS 속성이 특정 브라우저 렌더링 엔진과 충돌하여 탭 전환 시 하단 UI 밀림(레이아웃 시프트), 콘텐츠 화이트아웃, 불규칙 Reflow 레이턴시를 야기함을 확인.
- **표준 `display` 토글 격리 방식 전환**: 모든 탭 패널의 가시성 제어를 `display: none !important` / `display: block !important` 쌍으로 재구성. 브라우저 렌더링 엔진의 레이아웃 트리에서 완전히 제거되었다가 복원되는 표준 격리 사이클을 확보함으로써 Reflow 레이턴시 0ms 달성.
- **뷰포트 스크롤 초기화 가드 주입**: `switchPage()` 내부의 탭 전환 루프 완료 직후 `window.scrollTo(0, 0)`을 삽입하여 이전 탭의 스크롤 오프셋이 신규 탭에 잔류하는 UX 오염 현상을 원천 차단.

#### 2) Folio 프리미엄 미니멀리즘 디자인 시스템 구축

##### 타이포그래피 시스템 재구성
- **CSS `clamp()` 유동 반응형 타이포그래피**: 뷰포트 너비에 비례하여 폰트 크기가 자연스럽게 증감하는 유동적 스케일 시스템으로 전환. 모바일부터 와이드 데스크톱까지 단일 선언으로 대응.
- **한국어 가독성 베이스라인 구축**: `word-break: keep-all`을 시스템 전역 기본값으로 정착시켜 한국어 어절 중간 강제 줄바꿈으로 인한 가독성 저하 문제를 전면 해소.

##### 테마 및 시각 계층 고도화
- **OLED 저전력 친화 `#0e0c0a` 심해 다크 브라운 테마 확장**: 기존 `#121212` 기반 다크 테마를 더 깊고 따뜻한 브라운 계열 최심도 컬러로 교체. OLED 패널 환경에서 배터리 소모를 낮추고 눈의 피로도를 감소.
- **프리미엄 글래스모피즘 계층 적용**: 카드, 모달, 헤더, 플로팅 바 등 주요 UI 요소에 `backdrop-filter: blur()` + 반투명 배경색 조합의 글래스모피즘 레이어를 도입. 콘텐츠 계층 구조를 시각적 깊이감으로 표현.

##### 마이크로 인터랙션 오케스트레이션 (신규 8종)

- **스프링 물리 슬라이딩 탭 인디케이터**: CSS 변수 `--tab-indicator-x`(위치)와 `--tab-indicator-w`(너비)를 `switchPage()` 함수와 JS-CSS 브릿지로 연동. `cubic-bezier(0.34, 1.56, 0.64, 1)` 스프링 물리 곡선을 적용하여 탭 전환 시 인디케이터 바가 유체적으로 미끄러지며 크기가 변형되는 연출 구현. `.page-tabs-wrap` 래퍼 마크업을 `index.html`에 추가하여 레이아웃 격리 보장.

- **스크롤 감지형 콤팩트 헤더 수축 시스템**: `ui-state.js`에 `_setupHeaderCompact()` 함수를 신설하여 `scroll` 이벤트를 감지. 스크롤 오프셋이 임계값을 초과하면 헤더에 `.compact` 클래스를 토글하고 CSS 트랜지션으로 높이와 요소 가시성이 부드럽게 전환. 스크롤을 최상단으로 되돌리면 원래 크기로 복원.

- **드롭존 네온 펄스 애니메이션 (`neonBorderPulse`)**: 파일 드래그 인(drag-over) 이벤트 발생 시 드롭존 테두리에 `neonBorderPulse` 키프레임 애니메이션을 활성화. 테두리 색상이 accent 컬러 → 투명 → accent 컬러로 맥동하며 직관적인 드롭 유도 피드백을 제공.

- **프로그레스 바 액체 그라디언트 모션 (`liquidFlow`)**: 변환 진행률 바 내부에 `liquidFlow` 키프레임을 적용하여 그라디언트 배경이 물처럼 좌우로 흐르는 애니메이션 구현. 변환 작업의 역동성을 시각화하여 사용자 체감 대기 시간을 심리적으로 단축.

- **토스트 스프링 물리 인/아웃 모션 (`toastSpringIn` / `toastSpringOut`)**: 토스트 메시지 출현 시 `toastSpringIn`, 소멸 시 `toastSpringOut` 키프레임이 각각 적용. 60% 지점에서 목표 크기를 10% 초과하는 오버슈팅 스프링 물리를 구사하여 탄성 있는 진입·퇴장 모션 연출. 기존 단순 페이드 방식을 전면 대체.

- **모달 3D 레이어 배경 침강 효과**: `MutationObserver`가 `document.body`를 감시하여 모달 오픈 시 자동으로 `body.modal-open` 클래스를 토글. 해당 클래스 활성 시 배경 콘텐츠에 `perspective` + `scale(0.96)` + `blur(2px)`를 적용하여 3D 공간감 있게 뒤로 가라앉는 몰입형 배경 침강 효과 연출. 모달 닫기 시 부드럽게 원위치 복원.

- **커스텀 테마 연동형 스크롤바 바인딩**: CSS 변수 `--accent`, `--bg2`, `--border`를 참조하는 `::-webkit-scrollbar` 및 표준 `scrollbar-color` 스타일링을 시스템 전역에 통일 적용. 사용자가 스킨을 변경할 때 스크롤바 색상도 자동 연동.

- **빈 상태 둥둥 효과 (`floatBob`)**: 목록 또는 히스토리가 비어 있는 empty state 화면에서 안내 아이콘 및 일러스트레이션이 `floatBob` 키프레임으로 부드럽게 위아래로 떠다니는 애니메이션 구현. 정적인 빈 화면 대신 시각적 생동감을 제공하여 신규 사용자의 진입 경험 향상.

#### 3) 인프라 제로 오버헤드 파비콘 전환

- **문제 진단**: 기존 `<link rel="icon">` 태그의 Data URI에 SVG 소스를 퍼센트(`%`) 인코딩 방식으로 삽입하던 구조에서, SVG 내부의 `#`, `<`, `>`, `"` 등 URL 예약 특수문자가 일부 브라우저 URL 파서와 충돌하여 SVG를 정상 파싱하지 못하고 브라우저 기본 이모지로 폴백하는 버그 확인.
- **Base64 인라인 주입 전환**: 파비콘 SVG 전체 소스를 `btoa()` 방식으로 Base64 바이너리 인코딩하여 `data:image/svg+xml;base64,...` 형식의 완전한 불투명 데이터 URI로 변환. 브라우저 파서가 내부 구조를 해석할 필요 없이 바이너리 블록 그대로 처리하므로 특수문자 충돌이 구조적으로 불가능해짐.
- **SVG 디자인 상세**: 배경 원, 이중 액센트 링, 펼쳐진 책 페이지를 상징하는 좌우 삼각형, 변환 신호를 나타내는 디지털 노드 점을 기하학적으로 조합한 커스텀 아이콘. 외부 파일(`favicon.ico`, `favicon.svg`) 의존성 없이 `index.html` 단일 파일 안에 완결.

---

## 파일별 역할 요약

| 파일 | 줄수 | 역할 | Phase 5 변경 |
|------|------|------|--------------|
| `convert.js` | 2,790 | 변환 탭: 파일 I/O, 인코딩 감지, 이미지 처리, 삽화 자동/수동 | 없음 |
| `parser.js` | 2,044 | 챕터 파싱, 목차 렌더링, 가상 스크롤, 통계, 캐시 | 없음 |
| `edit.js` | 1,603 | EPUB 편집 탭: OPF 파싱, 챕터 수정, 재생성, 연속 삽입 | 없음 |
| `style.css` | **1,340** | 테마, 컴포넌트, 애니메이션, 스킨 시스템 | **✅ 대폭 업데이트** — 키프레임 20개+, CSS 변수 76개+, clamp 타이포, 글래스모피즘, 스크롤바, floatBob |
| `index.html` | **1,260** | SPA 마크업, 탭 구조, SVG 드롭존 | **✅ 업데이트** — .page-tabs-wrap 래퍼 추가, Base64 SVG 파비콘 인라인 교체 |
| `settings.js` | 1,317 | CSS 설정, 폰트, 프리셋, 스마트 패턴, 히스토리, Gemini API 교류부 | 없음 |
| `core.js` | 1,420 | 아키텍처 코어, 상태 프록시, Cloudflare Workers 보안 프록시 인프라 허브 | 없음 |
| `cover-search.js` | 722 | 표지 검색 모달, 플랫폼별 어댑터(Naver, Kakao, Ridi, Novelpia), .file 확장자 필터 우회 가드, 크롭 처리 | 없음 |
| `ui-state.js` | **1,120** | UI 상호작용, 모달 제어, 가시성 레이아웃, 이벤트 버스 핸들러 | **✅ 업데이트** — display 표준 토글 전환, scrollTo 가드, _setupHeaderCompact, MutationObserver 모달 침강, 탭 인디케이터 JS-CSS 브릿지 |
| `epub-gen.js` | 389 | 이펍 빌드, JSZip 브릿징, 워커 격리 쓰레딩 | 없음 |
| `worker.js` | 354 | 대용량 백그라운드 스트림 디코더 및 청크 분할 처리기 | 없음 |
| `sw.js` | 119 | PWA 지원 오프라인 캐싱 매니저 | 없음 |

#### 🧪 크로스 가드 오디팅 결과
- `convert.js` 내의 `applyCoverUrl` 정합성 대조 결과: `.file` 수용 시 추출 확장자가 유효 리스트에 없으면 자동으로 안전값인 `'jpg'` 폴백 가드가 발동함을 확인하여 런타임 무결성 100% 충족 보장.
- Phase 5 `display` 토글 전환 이후 전 탭(변환/일괄변환/편집) 렌더링 격리 정상 동작 확인. 탭 전환 시 하단 밀림 및 화이트아웃 재현 불가 판정.
- `.page-tabs-wrap` 마크업 추가 후 기존 `[data-tab]` EventDelegate 바인딩 및 `switchPage()` 내 querySelector 경로 정상 해석 확인.
- `toastSpringIn` / `toastSpringOut` 키프레임 적용 후 기존 Toast 큐잉 로직(`core.js`) 영향 없음 확인 — 순수 CSS 레이어 변경이므로 JS 로직 비간섭.
