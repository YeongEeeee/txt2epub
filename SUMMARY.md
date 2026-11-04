# NovelEPUB 개발 세션 Summary

## 프로젝트 개요

**NovelEPUB** — TXT → EPUB3 변환기  
순수 프론트엔드 SPA. 서버 없이 브라우저에서 모든 처리 완료.  
총 코드량: **약 16,750줄** (JS·HTML·CSS 15개 파일 + 테스트)

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

### Phase 6 — 표준 준수 · 패턴 단일화 · 회귀 테스트 · 죽은 코드 정리

#### 1) EPUB3 표준 메타 보완 (`epub-gen.js`)
- `dcterms:modified` 추가 (EPUB3 필수), `dc:identifier`를 `urn:uuid:` 형식으로
- 설정 탭 `optPublisher`를 `dc:publisher`에 연결 (비우면 생략) — 이전엔 저장만 되고 `TXT2EPUB 변환기` 고정
- `container.xml` 네임스페이스 오타 수정(`urn:oasis:schemas:container` → OCF 표준) — epubcheck RSC-003
- 이미지가 없으면 빈 `Images/` 폴더 미생성 — epubcheck PKG-014
- **버그**: 목차 생성 전에 `chapters.length=0`으로 원문을 해제해 nav/ncx 챕터 제목이 전부 빈 문자열이던 문제 수정

#### 2) 패턴 정의 단일화 (`parser.js` ← `worker.js`, `convert.js`)
- `buildParserWorkerSource()`: PATS·KEYWORD_PATS·bestPat·splitChapters를 toString/RegExp 직렬화로 Worker에 이식
- 이전 인라인 Worker 복사본은 fpGuard·제목 정규화·ReDoS 가드가 빠져 있어 픽스처 13개 중 4개에서 메인 스레드와 결과가 달랐음
- **버그**: `_parserWorker`·`_workerCallbacks`·`_workerIdCounter` 미선언(strict 모드) → 10만 줄+ 변환과 "변환 중단"에서 ReferenceError
- 중단은 동기 루프 Worker에 ABORT 메시지가 닿지 않으므로 `terminateParserWorker()`로 즉시 종료

#### 3) 회귀 테스트 + CI (`tests/`, `.github/workflows/test.yml`)
- 골든 15 픽스처, Worker 동등성(40만 줄 포함), 시리즈·트리·파싱 단위, EPUB 구조 검사 — 154개
- CI에서 epubcheck 5.1.0으로 생성 EPUB 표준 검증

#### 4) 계층 목차 + 시리즈 메타
- `buildTocTree()`: `1권`/`제2부`/`Vol.3` 단독 제목 → 상위 노드, `1부 3화` → 합성 그룹, 그룹 2개 미만이면 평면 유지
- `parseSeriesFromName()`: 파일명 → 시리즈·권 번호 (변환 탭 자동 채우기, 일괄 변환 자동, 분할 EPUB은 원제목/파트 순번)
- 메타데이터 블록에 `📚 시리즈` + 권 번호 입력 추가

#### 5) 화면 요소가 없어 동작하지 않던 기능 연결
- `#patSection`(파일 로드 전 흐림), `#chipGroupToggle`(칩이 한 줄 넘칠 때만 '더 보기', ResizeObserver 재계산)
- 결과 카드 `#progressSparkline` / `#convertReport` — `style.display=''`가 CSS 기본 `display:none`으로 되돌아가던 문제 수정, 경고 수집기 `_collectConvertWarnings` 추가(화수 도약·짧은 챕터·패턴 미감지·삽화 매핑 실패)
- 일괄 변환 `#batchSettingSummary`, `#batchTitle`(표지 검색어 — 존재하지 않는 `S.batch` 참조를 `B.txtFiles` 기반으로 교체)
- 설정 여백 `#padAccordionToggle/Body` + 값 요약 `#cssPad*Val` (`syncPadSummary`, 중복 클릭 리스너 제거)
- EPUB 편집 `#directEditTocList` — 항목 클릭 선택 후 ▲▼ 이동(이전: 첫 체크 항목 기준이라 항상 1번만 이동), 새 EPUB 로드·초기화 시 이전 목록 폐기

#### 6) 파싱 문제 수정 (`parser.js`)
- 제목 표시: 정규화 문자열 대신 원문 사용 → `제1화 만남`·`[EP.1] 제목`·`1부 1화 전투` 공백·괄호 보존
- 전각 숫자: `_normalizeTitleStr`의 `[ ]` 누락 정규식 수정 + `preprocessLine`에서 반각 변환 → `제１화` 감지
- 번호 목록 가드 `_isListItemLine`: 위·아래 줄과 이어지는 `N.`/`N)` 목록은 챕터 제외 (splitChapters·미리보기 공통)
- 무패턴 TXT: 키워드 줄이 실제로 있을 때만 키워드 단독 rx 사용 → 페이지 분할 폴백 복구(이전엔 도달 불가 코드)
- 미리보기 매칭 `_matchHeading`: 변환과 같은 기준(정규화 또는 원문) — `[1화] 시작`이 미리보기에선 0개, 변환에선 감지되던 불일치 해소
- 텍스트 표지: 이름 없는 Blob에서 `file.name.split` TypeError로 자동 생성 표지가 EPUB에서 빠지던 문제 수정(MIME으로 확장자 판별)

#### 7) 죽은 코드·끊긴 연결 정리
- 클릭해도 무반응이던 버튼 4종 핸들러 연결: 스마트 패턴 `✅ 적용`, `✅ 선택한 패턴 적용`, 삽입 탭 `🔍 재확인`, 색상 `리셋`
- `_decodeFromAB` 폴백 경로의 스코프 밖 `file` 참조(ReferenceError) 수정
- `crypto.randomUUID` 직접 호출 → `genUID()` (http LAN 접속 등 비보안 컨텍스트에서 변환 실패하던 문제)
- 제거: `_T`, `_KOR_NUM_MAP`/`_decodeKorNum`, `_groupByVolume`, `toggleTocItem`, `tocTabActive`, `_tocDragSrcI`, `kwSearch`/`selectKwResult`/`debounceKwSearch`/`getManualIllTarget`, `renderBatchFileStatus`, `_validateContentType`, 메인 스레드 `xhtmlPage`, `triggerCoverSearch` 별칭, `_eSmartPatAbort`, `customFontFile`, 미사용 지역변수 다수, 트리거 없는 data-action 등록 8종, 사용처 없는 data-input-action 2종(`saveOptLang`·`saveCssSettings`)
- `edit.js` 목차 재생성 시 항목마다 전체 원문을 filter하던 미사용 계산 제거 (O(항목×줄))

### Phase 7 — 디자인 정리

#### 1) 결함 수정
- `.page-tabs`의 `position:sticky;top:49px` 뒤 `position:relative`가 덮어써 탭이 49px 밀림 → 헤더 아래 빈 띠 + 첫 섹션 제목 가림. sticky + `--hdr-h`(ResizeObserver·transitionend로 실제 헤더 높이 반영)로 해결
- 모바일 가로 넘침: 미니 리더(421px), CSS 설정 그리드(721px), 여백 그리드 잘림 → 1단 반응형 + `minmax(0,1fr)`
- 히스토리·설정 페이지가 `.wrap` 밖 → 카드가 화면 끝까지 붙던 문제
- 컬러 스킨: `setSkin`이 `data-skin`만 바꾸고 CSS가 없어 스와치가 보이지 않고 색도 안 바뀜 → 스와치·스킨 토큰(라이트/다크) 신설
- 표지 초기화가 `className='dz'`로 덮어써 새 클래스가 사라지던 문제 → `classList` 사용, 빈 썸네일 마크업을 상수로 단일화

#### 2) 통일
- UI 산세리프(`--font-ui`), 명조는 로고·리더 전용(`--font-serif`)
- 타입 스케일 고정 6단계, 반경 3단계 — CSS·HTML·JS 인라인의 px 글자 크기 308곳·반경 131곳을 토큰으로 치환 (EPUB 출력용 `epub-gen.js`는 제외, 테스트로 미유출 확인)
- 정적 UI 이모지 113곳 제거, 드롭존 아이콘 SVG 통일, 설정 요약 칩 중립화

#### 3) 덜어내기
- 고급 패턴 도구 `<details id="patAdvanced">` 접기 (감지 실패 시 `previewToc`가 자동 펼침)
- 표지 영역 압축, 하단 바 재구성(`btm-inner`), 파일 없을 때 `.is-idle`로 버튼만 비활성

#### 4) 정리
- 미사용 CSS 규칙 71개(클래스 58종)·키프레임 10개·토큰 4개·고아 주석 제거, 사용처 없던 `.page-tabs-wrap` 규칙 제거
- `convert.js` 항상 정의돼 있는 `_syncSplitBtn`의 폴백 분기, `parser.js`의 덮어써지는 `createVirtualScroll` 사본(53줄) 제거
- 설정 요약 `badge()`의 미사용 아이콘 인자 제거

### Phase 8 — 목차 인식 엔진 (TocEngine)

#### 1) 감지 단일화 · 내용 손실 제거
- `detectToc()` 하나로 미리보기(`previewToc`)·변환(`splitChapters`)·일괄 변환 목차 확인(`showBatchToc`)·EPUB 편집 목차 재생성(`previewEpubToc`)·Worker 통일
- 이전 미리보기는 단일 패턴만 써서 프롤로그·외전·에필로그가 빠지고, 첫 제목 앞 내용이 '서문'으로 묶여 EPUB spine에서 제외 → **프롤로그를 읽을 수 없던 버그** 수정 (서문도 spine·nav 포함, EPUB 분리 시 첫 파트에 보존)
- 본문 없는 제목('1권' 바로 다음 '1화') 보존 — `assembleChapters` 공용
- 일괄 변환 확인 패널이 자동 감지 정규식을 파일별 '지정 패턴'으로 저장해 변환 때 엔진을 우회하던 문제 제거
- TXT 초기화·새 파일 로드 시 이전 목차(`S.tocItems`)가 남아 다른 파일을 이전 목차로 자르던 문제 수정

#### 2) 정확도
- 형식 계열 13종 + 키워드·외전·권 후보 → 제목다움 가중치 → 화 번호 사슬 DP (복합 패턴 동시 탐지, 본문 숫자 줄·'N화' 언급 탈락)
- 파일명 화수 범위(`parseChapterRange`: '1-201 완결', '0-853 @작가' → 854) 보정 + 오차 5% 초과 시 변형 재탐색
- 실전형 샘플 5종: 오차 0~0.6%, 정밀도·재현율 100% (이전 −99%~+369%) · 4만 줄 38ms
- 목차 후보 바: 첫 칩 = 자동 감지 결과, 단일 패턴 후보에 파일명 화수 대비 오차 표시 (잘못된 넓은 패턴에 ⭐가 붙던 문제 해소)

#### 3) 형식 지원
- 두 줄 제목 결합, 반복 머리줄 제거, 장면 구분자 경계 페이지 분할, 여러 TXT 파일 경계(파일명 제목), 같은 화 분할 합치기(설정 `optMergeParts`)
- 전각 숫자 제목은 원문 표기 유지, 같은 번호라도 부제가 다르면 제목으로 인정

#### 4) 정리
- `extractTotalFromFilename`(0-853을 853으로 잘못 계산) → `parseChapterRange`로 대체 후 삭제
- 테스트 155 → 193개 (`tests/gen-realistic.js` 실전형 생성기 추가)

### Phase 9 — 배포 안정성 · 보안 · 단축키 정리

#### 1) Service Worker (`sw.js`, `main.js`)
- `main.js`의 `EXPECTED_CACHE`가 5월 값으로 고정 → 새로고침마다 `CHECK_CACHE`가 캐시 전체를 지우고 업데이트 배너를 띄우던 문제. 하드코딩 비교 경로를 없애고 브라우저 표준 `reg.update()`로 갱신 검사 (버전 문자열은 `sw.js` 한 곳)
- '지금 업데이트' 버튼이 이미 활성인 SW에 `SKIP_WAITING`을 보내 아무 일도 없던 문제 → 대기 중인 새 SW(`reg.waiting`)로 전송
- 첫 방문 시 `clients.claim()`의 controllerchange로 페이지가 한 번 저절로 새로고침되던 문제 제거
- `CORE_ASSETS`에 `main.js` 누락 → 추가
- 모든 외부 GET을 영구 Cache-first → 표지 검색(프록시 경유) 결과가 갱신되지 않고 캐시가 무한 증가. JSZip·웹폰트만 Cache-first, 나머지는 가로채지 않음

#### 2) 보안
- 목차 글자수 차트 툴팁이 챕터 제목을 `innerHTML`로 삽입 → TXT 제목 `<img src=x onerror=…>` 실행. `textContent`로 전환
- Toast·confirm의 HTML 경로가 script/iframe만 제거하고 `on*` 속성을 남김 → `_sanitizeHtml()`(core.js) 공용 정화
- 표지 URL 미리보기·일괄 목차 오류 메시지도 DOM 생성/이스케이프로 변경

#### 3) 단축키 · 재진입
- `main.js` §7과 `ui-state.js`가 같은 `document` keydown을 이중 등록(같은 대상이라 `stopPropagation`으로 못 막음) → Ctrl+Space 변환 2회, Ctrl+/ 도움말 즉시 닫힘. `ui-state.js` 단일 핸들러로 통합하고 Ctrl+Z(목차 Undo)를 이관, 입력란의 기본 Ctrl+Z는 유지
- `startConvert`/`startBatch` 재진입 방지 (변환 중 버튼 `disabled`·`aria-busy`)

#### 4) 글자수 차트 · 색상 토큰
- 막대 1px+간격 1px 고정이라 300px에 868화면 앞 ~150화만 표시 → 연속 화를 구간으로 묶고 소수 간격으로 폭 전체 사용, 구간 툴팁(범위·평균)
- 차트를 다시 그릴 때마다 툴팁 div가 body에 누적 → 전역 1개 재사용
- 하드코딩 색 정리: `--on-accent`, `--overlay(-strong)`, `--red`(정의 없이 쓰이던 변수), `--purple`, 스킨 견본 토큰 추가, 강조·초록·파랑 글로우 38곳을 `color-mix(var(--…))`로 바꿔 스킨 변경에 연동
- 남은 예외: canvas 표지 생성, 색상 입력란 기본값, 콘솔 스타일, 중립 흑백 음영

#### 5) 검증
- 테스트 193 → 200개 (배포·보안 정적 검사 7종 — 수정 전 코드에서는 7개 모두 실패함을 확인)
- 브라우저 E2E: SW 설치·새로고침 2회 캐시 유지·새 버전 배너→업데이트, 검색 응답 비캐시, 단축키 1회 실행, XSS 3경로 차단, 868화 차트, 변환 재진입 차단 후 EPUB 생성

### Phase 10 — 출력 정확성 · 목차 줄 범위 모델 · 알고리즘 최적화

#### 1) EPUB 본문 렌더링 (`parser.js`, `epub-gen.js`)
| 문제 | 수정 |
|------|------|
| Worker용 `renderBodyHtml`이 손으로 복사한 문자열 사본 — `\\u226a` 오타로 `2층 [창고]` 같은 줄이 시스템 메시지, `≪상태창≫`은 미적용 | parser.js 함수·정규식 상수를 `toString()`으로 Worker에 이식 (단일 소스, 테스트로 메인=Worker 보장) |
| 서로게이트 전체 삭제 → 이모지·확장 한자 소실 | 짝 없는 서로게이트만 제거 (lookbehind 없이 콜백 방식) |
| NBSP 삭제 → `단어 단어`가 붙음 | NBSP → 일반 공백 |
| 엔티티가 있으면 줄 전체 이스케이프 생략 → 같은 줄의 `<`가 XHTML을 깨뜨림 | `_decodeHtmlEntities` 후 `escHtml` 1회 |

#### 2) 목차 줄 범위 모델 (`parser.js` TocModel)
- `tocItems`는 본문 문자열 없이 줄 범위만 보관 (`_segs` 세그먼트) — 원문 메모리 1벌
- `assembleTocChapters`: **목차 순서대로 출력** (드래그 순서 변경 반영), 떨어진 항목 병합 = 두 범위만 결합, 비활성 항목 내용은 앞 챕터로, 같은 줄 중복 출력 방지
- `_recalcTocStats`: 줄별 글자수 누적합으로 bodyLen·짧은 챕터 일괄 계산 (권·키워드 제외 규칙 단일화)
- 🔓 분리: 원본 줄 번호(`src.line`)로 원래 위치에 복원 (이전: `item.line+순번`으로 줄을 지어냄)
- 병합 직후 제목 편집 영역 표시 (이전: 표시 코드가 없어 항상 숨김)
- '본문 짧음 전체 제거'가 짧은 항목 **자신**을 제거 (이전: 다음 화를 지움)
- 가상 스크롤 목록: 보이는 행만 DOM 생성, `[style*="display: none"]` 펼치기 제거, `tocScrollToIndex()` 공용 이동

#### 3) 변환 흐름 (`convert.js`, `settings.js`, `epub-gen.js`)
- **중단**: `AbortController` 하나로 파일 읽기·파싱·이미지·EPUB Worker 전 단계 즉시 중단
- **히스토리 저장**: 결과 표시를 막지 않음, `idbSet` `return await` + `onabort` (용량 초과 시 무한 대기·오류 표시 해결), 목록은 `count()`로 존재 확인
- **오류 분류**: EPUB 생성 실패는 오류 박스 (이전: 전부 RecoverableError → '계속 진행합니다' 경고만)
- **문단 정합** 옵션을 조립된 본문에 적용 (이전: 실제 변환에 전달되지 않음)
- **삽화 매핑**: 순번은 '서문' 제외, 화 번호는 감지 번호(`제2부 15화` → 15), 키워드는 원문 기준 — 챕터 3번째 요소 `meta {num, kind, pre}`
- 새 파일 로드 시 이전 EPUB 결과·다운로드 바·간격 분할 상태 해제
- 빈 작가명은 `dc:creator` 생략 (epubcheck RSC-005)

#### 4) 성능
| 항목 | 이전 | 이후 |
|------|------|------|
| 무패턴 30만 줄 감지(`bestPat`) | 8.5~11초 (패턴 79종 × 줄마다 전처리) | 0.9초 (전처리 1회 캐시) |
| EPUB 챕터 렌더링 | 2회 (삽화 키워드 검사용 사전 렌더) | 1회 + 삽화 매핑 Map |
| 이미지 압축 | DEFLATE 재압축 | STORE |
| 파일 디코딩 | 미리보기·재확인·변환마다 반복, 5MB+는 파일 2회 읽기 | LRU 캐시 + 버퍼 전달(1회 읽기) |
| 미리보기 감지(10만 줄+) | 메인 스레드 | 파싱 Worker `DETECT` |
| 목차 목록 | 전체 행 DOM | 보이는 행만 |
| 기타 | — | 후보 가중치 1회 계산, 줄 앞부분 사전 필터, 개수 세기 `indexOf` 루프, 사용자 정규식 150자 상한 |

#### 5) EPUB 편집 (`edit.js`)
- 재생성 EPUB의 `mimetype`을 첫 항목·STORE로 고정 (이전: DEFLATE → epubcheck PKG-007)
- 직접 편집 목차 재생성: spine `idref`를 manifest의 실제 id로 (이전: href로 지어낸 id → OPF-049·본문 미표시), 재감지 항목 → 챕터 파일 매핑을 챕터 시작 줄 표로 정확히

#### 6) 상태·구조·배포
- `StateManager.set`이 교체되는 배열을 비우지 않음 (prev·스냅샷 데이터 소실 방지)
- `window._autoSplitActive` 정의 1곳(parser.js, 값은 `_sStore`) — convert.js·main.js 중복 정의 제거
- JSZip SRI(`integrity`+`crossorigin`), SW는 CDN 자원을 CORS로 프리캐시(opaque 캐시를 CORS 요청에 반환하지 않음), `CACHE_VERSION` 갱신

#### 7) 검증
- 회귀 테스트 200 → 232개, epubcheck 0 오류(테스트 EPUB 6종 + E2E 산출물)
- 정적 연결 검사(ESLint no-undef·data-action/data-input-action 등록·inline 핸들러·getElementById 대상·미사용 최상위 선언): 미정의 참조 0, 등록 누락 0, 죽은 코드 0
- 브라우저 E2E(Chromium): 변환 탭 49 · 편집/일괄/히스토리/설정 19 · Service Worker 오프라인 7 — 전부 통과

### Phase 11 — 회귀 복구 · v3 기능 이식

#### 1) 회귀 원인
- 커밋 `917b27b`(목차 감지 v3 · 일괄 간격 분할)의 `convert.js`·`parser.js`가 **Phase 10 이전 계열**(0617 무렵 기반)에서 작업된 파일이었음
- Phase 8~10의 `detectToc`·`buildTocTree`·`parseChapterRange`·`assembleTocChapters`·`buildParserWorkerSource`·AbortController 중단·차트 툴팁 XSS 수정 등이 소실
- 다른 파일은 그대로 호출 → `epub-gen.js` `buildTocTree` / `edit.js` `detectToc` ReferenceError, `npm test`가 로드 단계에서 중단 (Phase 10 코드는 232/232 통과)

#### 2) 복구 방식
- 두 파일을 `1919194`(Phase 10)로 되돌린 뒤, v3 변경을 기능 단위로 대조해 **Phase 10 엔진 위에 재구현**
- v3의 BOM·조사 차단·키워드 경계·제N회·第N回·Episode·【第N章】·조밀 원고 처리는 TocEngine이 이미 동일하게 처리함을 확인 (탐침 21종)

#### 3) 이식한 기능
| 항목 | 내용 |
|------|------|
| 형식 계열 3종 | `[N] 제목`, `N - 제목`/`N: 제목`(구분 기호 뒤 숫자는 제외), `제N막` — 이전엔 bestPat 폴백이 본문 'N화를 봤다' 등 12줄 오탐 / 빈 줄 없는 원고는 감지 실패 → 30/30·오탐 0 (v3도 오탐 1~2) |
| 제목 표시 | 전각 공백(U+3000) → 일반 공백 (`제　1　화` → `제 1 화`) |
| 간격 분할 엔진 | `computeIntervalSplit`(DOM 비의존)로 분리 — 변환 탭 `autoSplitByInterval`·일괄 변환 공용. 첫 화 1줄 고정, TocEngine 제목 줄 앵커(수가 정확히 맞으면 전부 사용)·스냅 가산점, 단조 증가 보정, 결과는 TocModel 줄 범위 항목 |
| 화수 추정 | `estimateIntervalTotal`: 파일명 범위 → 감지 수(화당 1,500줄 이하) → 빈 줄 군집 → 300줄당 1화 |
| 일괄 간격 분할 | 전역 토글 + 제목 형식, 파일별 화수 지정·해제, 모드 배지, 미리보기(균등도·평균·첫 줄), 변환 분기 (`B.batchSplit`·`B.splitModes`, core.js 초기값) |
| 100% 일치 프리셋 | 자동 감지가 파일명 화수와 5% 넘게 어긋나면 화수가 정확히 같은 프리셋을 `detectToc` 기준으로 찾아 파일 패턴으로 채택, 배지·프리셋 목록 표시 |
| 프리셋 수정 | `[ 파일명.txt ]` 정규식이 `^\.`로 시작해 매칭 0 → `^\[` |
| 배포 | `sw.js` `CACHE_VERSION` 갱신 |

#### 4) 검증
- 테스트 232 → 248개 (v3 이식 16개) 전부 통과
- 정적 검사(ESLint no-undef, 로드 순서 결합): HEAD의 미정의 참조 27종 → 0 (typeof 가드·Worker 전용 심볼 제외)
- 브라우저 E2E(Chromium): `[N] 제목` 30화 변환(nav 30), 변환 탭 간격 분할 25화 EPUB, 일괄 변환 3파일(30·20·간격 12화) ZIP 결과·nav 수 일치, 전역 토글 배지, 100% 일치 프리셋 탐색, 콘솔 오류 0

### Phase 12 — 테스트 밖 경로 버그 수정 (폰트 · AI 패턴 · URL 표지 · 인코딩 · 편집)

#### 1) 커스텀 폰트 (`settings.js`, `ui-state.js`)
| 문제 | 수정 |
|------|------|
| 8192바이트(3의 배수 아님) 청크마다 `btoa` → 청크 끝 `=` 패딩이 중간에 끼어 base64 전체 손상, 8KB 넘는 모든 폰트 로드 실패 | `_bytesToBase64()` — 8190바이트(3의 배수) 청크, 표준 base64와 바이트 단위 일치 테스트 |
| `format("ttf")`·`format("otf")` — 표준 키워드가 아니라 src 전체 무시, MIME도 비표준 `font/truetype` | `_FONT_FORMATS` — `truetype`/`opentype`/`woff`/`woff2`, MIME `font/ttf` 등 RFC 8081 |
| 이전 버전이 IndexedDB에 저장한 손상 폰트가 계속 복원됨 | `_isValidFontFace()`로 복원 시 검사 → 지우고 재업로드 안내 |
| 폰트 파일명에 `"`가 있으면 CSS 깨짐 | `_safeFontName()` |

#### 2) Gemini 스마트 패턴 (`settings.js`)
- `gemini-2.0-flash`(2026-06-01 종료)·`1.5-flash`·`1.5-flash-8b` 전부 404 → 루프 끝에서 `quota_exceeded`를 던져 '할당량 초과'로 잘못 안내. `gemini-3.8-flash`·`gemini-3.5-flash-lite`·`gemini-3.6-flash`로 교체, 모두 404면 `models.list`로 사용 가능한 Flash 모델 탐색, 실패 사유별 메시지(`model_unavailable`)
- API 키를 URL `?key=` 대신 `x-goog-api-key` 헤더로 전송, 잘못된 키의 400 `API_KEY_INVALID`도 키 오류로 분류
- `AbortController`를 만들기만 하고 fetch에 넘기지 않던 문제 → signal 연결, 백오프 대기도 중단 가능, 오래된 응답은 화면에 쓰지 않음, 입력을 지울 때도 취소

#### 3) URL 표지 (`convert.js`, `ui-state.js`)
- `url+'?'+Date.now()` → 기존 쿼리가 있는 CDN 썸네일 URL이 깨짐. 원본 먼저 시도 후 `searchParams`로 캐시 우회
- 투명 PNG → JPEG 변환 시 배경이 검게 됨 → 흰 배경
- canvas가 막히면 바로 CORS 안내 → `_fetchImgBlob` 프록시 체인(weserv → Workers → 직접)을 거친 뒤 안내
- 안내창이 URL을 inline `onclick` 문자열에 이어붙임(따옴표로 스크립트 주입) → 정적 마크업 + `addEventListener`, `_parseHttpUrl()`로 http(s)만 허용, `noopener`
- 암묵 전역 `event.target` 의존 → 이벤트 위임이 버튼 요소를 인자로 전달

#### 4) 인코딩 (`convert.js`, `worker.js`)
- 감지 로직이 `worker.js`와 `convert.js`에 두 벌 → `worker.js` 복사본 제거(메인 스레드가 감지한 인코딩을 항상 전달)
- BOM 없는 UTF-16 미감지 → NUL 바이트 위치 분포(LE 홀수·BE 짝수) + U+FFFD 비율 검증 `_detectUtf16NoBom()`
- 파일 목록이 다시 그려질 때마다 파일 **전체**를 읽어 감지, `.catch` 없음, 캐시 미사용 → 앞 64KB만 읽고 `_encCache` 공유
- `readFileSlice`가 항상 UTF-8 → 5MB 넘는 EUC-KR·UTF-16 파일 샘플이 전부 깨짐. 인코딩별 경계 보정 `_sliceBounds()`(EUC-KR 줄 단위·UTF-16 짝수 오프셋)

#### 5) EPUB 출력·편집 (`epub-gen.js`, `edit.js`)
- 글자색만 지정 시 다크 모드에서 어두운 배경 + 어두운 글자 → 두 색 모두 미지정일 때만 다크 기본색
- OPF 경로를 `container.xml`의 rootfile로 통일(`_epubOpfPath`), container 없음·손상 EPUB은 원인 안내
- 편집 결과의 `dcterms:modified` 갱신(EPUB3만), 직접 편집 결과 Blob `mimeType` 지정
- CSS '덮어쓰기'는 EPUB 안의 모든 CSS를 지우므로 실행 전 확인
- `.EPUB` 대문자 확장자 허용

#### 6) 프록시 Worker (저장소 밖)
- 클라이언트의 `X-NovelEPUB-Token`은 공개 값이라 누구나 열린 프록시로 사용 가능 → Worker에 Origin 허용 목록, HTML은 검색 대상 호스트만, 이미지는 `image/*`·15MB 이하, 내부 주소·IP 리터럴 차단, 선택적 Rate Limiting 적용한 코드 제공 (Cloudflare 대시보드에 배포)

#### 7) 검증
- 테스트 248 → 277개 (Phase 12 29개) 전부 통과, 전 파일 `node --check` 통과
- 브라우저 E2E(Chromium): DejaVu TTF 업로드 → `FontFace.load()` 성공·EPUB `style.css`에 `format("truetype")` 포함, TXT → EPUB 변환, 편집 탭 CSS 추가·덮어쓰기 확인창, UTF-8·EUC-KR·BOM 없는 UTF-16LE 각각 26화 동일 감지, 콘솔 오류 0
- epubcheck 5.1.0: 테스트 EPUB 6종 + 폰트 임베딩 변환 결과 + 편집 결과 모두 0 오류

### Phase 13 — 변환 품질 (본문 정리 · 장면 구분선 · 검수 리포트 · 인코딩 직접 지정)

#### 1) 본문 정리 파이프라인 (`parser.js` `applyTextCleanup`)
| 단계 | 내용 |
|------|------|
| 잡음 줄 제외 | 프리셋 4종(작가의 말·후기 블록 / 선작·추천 부탁 / URL·출처 / 공지·휴재) + 사용자 정규식(150자·30개 상한). 작가의 말은 챕터 **뒤쪽 절반**의 머리줄부터 끝까지만 제거, 120자 넘는 본문 문장은 프리셋에서 제외 |
| 줄바꿈 병합 | `detectHardWrap()` — 95백분위 길이 W 부근에 줄의 35% 이상이 몰리고, 그 줄의 절반 이상이 문장 부호 없이 끝날 때만 고정 폭으로 판단(한 줄 한 문장 웹소설 오탐 방지). 정확히 W자인 줄이 85% 이상이면 글자 단위(공백 없이 결합), 아니면 단어 단위(공백 결합). 말줄임표로 끝나는 줄·문장 부호로 시작하는 줄은 이어 붙임 |
| 문단 정합 | 기존 `_mergeShortLineArray` 그대로 — 이제 일괄 변환에도 적용 (이전: 변환 탭에서만) |
| 기호 정리 | 말줄임표 통일(공백 보존, 숫자 목록·소수점 제외), 따옴표 둥근/곧은 통일, 영어 아포스트로피 유지 |
- 실전형 원고 4종 + 픽스처 15종에서 줄바꿈 오감지 0, 잡음 줄 오삭제 0 확인
- 변환 리포트에 정리 결과를 **정보(ℹ)** 로 표시 (경고 건수와 분리)

#### 2) 장면 구분선 (`parser.js` `renderBodyHtml`, `epub-gen.js`)
- `_RX_SCENE` — 기호만으로 된 줄(`* * *`, `◇◇◇`, `----`, `═══`) → `<hr class="scene"/>`, CSS `hr.scene::after{content:"\2042"}`
- 이전에는 `----`·`───` 줄이 회상 이탤릭 문단으로 렌더링됨. Worker 소스에 상수를 함께 이식 (메인=Worker 테스트)

#### 3) 변환 전 검수 리포트 (`parser.js` `buildTocReview` / `renderTocReview`)
- 누락 화수(비활성 항목은 누락으로 보지 않음), 중복 번호(분할 연재 part는 제외), 빈·짧은(마지막 제외)·5만 자 초과 챕터
- 목차 통계 아래 접이식 패널, 항목 클릭 → '감지된 목차' 탭 + `tocScrollToIndex` 강조

#### 4) 인코딩 직접 지정 (`convert.js`)
- 파일 목록 배지를 선택 상자로 — `자동 (EUC-KR)` / UTF-8 / EUC-KR / UTF-16LE / UTF-16BE
- `_encOverride`가 자동 감지·LRU 캐시보다 우선, 바꾸면 디코딩 캐시 삭제 후 목차 재감지
- 직접 지정한 UTF-8은 'U+FFFD가 많으면 EUC-KR로 재시도' 보정을 건너뜀(메인·Worker 모두 `strict`) — 이전 로직이면 선택이 무시됨

#### 5) 함께 고친 버그
- 변환 탭 파일 목록(`#txtFileList`)이 `hidden` 속성 + `[hidden]{display:none!important}` 때문에 `style.display='block'`이 무시되어 **한 번도 보이지 않음**(0530부터) → `hidden=false`로 해제. 순서 변경·개별 제거·정렬 버튼이 이제 보임

#### 6) 검증
- 테스트 277 → 306개 전부 통과 (`tests/out/13_scene_break.epub` 추가 → CI epubcheck)
- 브라우저 E2E(Chromium): 설정 저장·복원, 잡음 12줄 제외·32자 줄바꿈 55줄 병합·기호 42줄·장면 구분선이 들어간 EPUB(epubcheck 0 오류), 검수 리포트 '5~8화 없음' 클릭 이동, EUC-KR 파일 UTF-8 직접 지정(깨짐 확인) → 자동 복귀(25화), 콘솔 오류 0

### Phase 14 — EPUB 호환 (폰트 파일 · landmarks · 접근성 · 리더기 프로필 · 편집 결과 검증)

#### 1) 커스텀 폰트 파일 분리 (`epub-gen.js`)
- `_extractCustomFont()`가 `customFontFace`(미리보기용 data URI)에서 바이트를 꺼내 `OEBPS/Fonts/custom_font.{ttf,otf,woff,woff2}`로 저장, manifest `font/ttf` 등 등록
- EPUB의 `style.css`는 `buildCss({fontFace})`로 `url("Fonts/…")` 상대 경로만 — 이전에는 모든 챕터가 수 MB짜리 CSS를 파싱
- WOFF/WOFF2는 STORE, TTF/OTF는 DEFLATE

#### 2) landmarks · 접근성 메타 (`epub-gen.js` Worker)
- `nav.xhtml`에 `epub:type="landmarks"` (hidden) — 표지(`cover`), 본문 시작(`bodymatter`, '서문' 제외)
- 목차 landmark는 nav.xhtml이 spine 밖이라 epubcheck RSC-011 → 넣지 않음 (구현 중 epubcheck가 잡아냄)
- OPF에 `schema:accessMode`(textual / 이미지가 있으면 visual), `accessModeSufficient`, `accessibilityFeature`(structuralNavigation·tableOfContents·readingOrder), `accessibilityHazard`, `accessibilitySummary`

#### 3) 리더기 프로필 (`epub-gen.js` `READER_PROFILES`, 설정 탭 '출력 설정')
| 프로필 | 표지 최대 높이 | 다크 모드 기본색 CSS | 삽화 |
|------|------|------|------|
| 기본 | 1200px | 포함 | 설정 따름 |
| 리디북스 | 1600px | 제외 | 설정 따름 |
| Apple Books | 2400px | 제외 | 설정 따름 |
| Kobo | 1600px | 제외 | 항상 JPG |
| Kindle (Send to Kindle) | 2560px | 제외 | 항상 JPG |
| Google Play 북 | 1600px | 제외 | 설정 따름 |
- 표지는 최대 높이보다 클 때만 축소(확대 없음), 선택 즉시 설명 문구 갱신·저장

#### 4) 이미지 형식 (`convert.js` `convertImageFile`)
- 'JPG 변환' OFF여도 EPUB 3 핵심 형식(JPEG·PNG·GIF·WebP·SVG)이 아니면 항상 JPG — 이전엔 BMP·TIFF·AVIF를 그대로 넣어 epubcheck 오류·리더기 표시 실패
- 핵심 형식이 아닌데 변환에 실패하면 원본을 넣지 않고 건너뜀
- 편집 탭 삽화 삽입이 변환 실패(null)에서 구조 분해 TypeError로 **편집 전체가 중단**되던 문제 → 해당 이미지만 건너뜀

#### 5) 편집 결과 검증 (`edit.js` `buildInsertedEpub`)
- `startEditEpub`의 EPUB 생성부를 DOM 비의존 순수 함수로 분리 → 테스트가 직접 실행해 `tests/out/14_edited_insert.epub` 생성 → CI epubcheck
- 기준 챕터가 없으면 nav·ncx에서 맨 끝에 추가 (이전: 빈 파일명 정규식이 첫 navPoint에 매칭돼 앞쪽에 끼어듦)
- 삽입 챕터에도 '본문 정리'·장면 구분선 적용

#### 6) 검증
- 테스트 306 → 323개 전부 통과, epubcheck: 테스트 EPUB 10종 0 오류
- 브라우저 E2E(Chromium): Kindle 프로필 저장·복원, TTF 업로드 → EPUB `Fonts/custom_font.ttf`·manifest·CSS 상대 경로·다크 CSS 제외, BMP 삽화 → JPG(설정 OFF 상태), 그 EPUB에 TXT 8화 삽입(34챕터)·dcterms:modified 갱신 — 두 결과 모두 epubcheck 0 오류, 콘솔 오류 0

### Phase 15 — 성능 · 보안

#### 1) 스트리밍 저장 (`epub-gen.js`, `convert.js`)
- 설정 '저장 위치 먼저 고르기'(Chrome·Edge) — 변환 시작 직후(첫 await 전) `showSaveFilePicker`, Worker가 `generateInternalStream` 조각을 Transferable로 보내면 메인이 `FileSystemWritableFileStream`에 순서대로 기록
- 결과 Blob을 만들지 않음 → 대용량 원고의 메모리 피크 감소. 실패·중단 시 `writable.abort()`로 쓰다 만 파일 폐기, 기록에는 파일 없이 메타만
- 미지원 브라우저는 토글 비활성 + 안내

#### 2) JSZip 로컬 배포 + SW 원자적 캐시 (`lib/jszip.min.js`, `sw.js`, `tests/stamp-sw.js`)
- JSZip을 `lib/`에 함께 배포 (CDN 파일과 바이트 동일 → 기존 SRI 그대로). EPUB Worker도 로컬 URL로 `importScripts`
- `CACHE_VERSION` = 앱 자산 내용 해시 (`npm run stamp`). 회귀 테스트가 계산값과 비교 → 손으로 날짜를 바꾸지 않아도 되고, 잊으면 CI가 막음
- 설치는 `cache.addAll`(HTTP 캐시 우회 `cache:'reload'`) — 하나라도 실패하면 설치 실패, 기존 버전 유지
- 로컬 자원은 현재 버전 캐시에서만 응답 → 이전(파일별 SWR)처럼 새 index.html + 옛 JS가 섞이는 일 없음

#### 3) EPUB Worker 재사용 (`epub-gen.js`)
- 소스 문자열·Blob URL 1회 생성, 정상 완료 Worker는 30초 유휴 보관 후 재사용 (오류·중단은 종료). 일괄 변환에서 Worker·JSZip 파싱 반복 제거

#### 4) API 키 (`index.html`, `settings.js`)
- `type="password"` + 보기/숨기기, '이 기기에 API 키 저장'(기본 켬) — 끄면 `localStorage`에서 즉시 삭제
- 안내 문구 정정: Gemini 키는 '외부로 전송되지 않음'이 아니라 Google API 요청 헤더로만 전송

#### 5) CSP · 인라인 핸들러 (`_headers`, `index.html`, 전 모듈)
- HTML 6곳 + JS가 만드는 HTML 22곳의 `onclick`·`oninput`·`onchange` → `data-action`/`data-input-action` 이벤트 위임 (`ui-state.js`에 핸들러 23개 등록)
- `script-src 'self'`(unsafe-inline·unsafe-eval 없음), `worker-src 'self' blob:`, `object-src 'none'`, `frame-ancestors 'none'` + nosniff·X-Frame-Options·Referrer-Policy·Permissions-Policy
- GitHub Pages·로컬은 `<meta>` CSP로 같은 정책 (테스트가 헤더 = meta 확인)

#### 6) innerHTML 정적 검사 (`tests/run-tests.js`)
- 모든 `innerHTML`/`insertAdjacentHTML`의 동적 값 중 이스케이프되지 않은 것 22곳 → 2곳 실제 수정, 나머지는 검토 후 `// safe-html: 이유`
- 수정: 미니 리더·설정 요약 칩이 **커스텀 폰트 이름(파일명)** 을 그대로 innerHTML에 넣던 문제, 삽화 확장자 배지, 일괄 표지 썸네일(FileReader 결과) → DOM 생성

#### 7) 표지 플랫폼 주간 점검 (`tests/cover-health.js`, `cover-health.yml`)
- 리디·카카오페이지·네이버 시리즈·노벨피아·DuckDuckGo 검색 결과에 어댑터가 쓰는 표식(클래스·JSON 키)이 있는지 주 1회 확인 → 사이트 개편 시 워크플로 실패 알림 (러너 차단 403·429는 경고만)

#### 8) 검증
- 테스트 323 → 343개 전부 통과, 스트리밍 결과 EPUB epubcheck 0 오류
- 브라우저 E2E(Chromium, CSP 적용): SW 설치(자산 해시 캐시), 스킨·API 키 토글·저장 끄기, 스트리밍 저장 145조각 → epubcheck 0 오류, Worker 재사용 확인, 일괄 변환 2권, **오프라인 새로고침 후 JSZip 로드·변환 성공**, CDN 요청 0, CSP 위반 0, 콘솔 오류 0

### Phase 16 — UX · 유지보수

#### 1) 앱 설치 (`manifest.webmanifest`, `icons/`, `ui-state.js`)
- manifest(이름·standalone·테마색·아이콘 192/512/maskable/SVG) + `<link rel="manifest">`·theme-color·apple-touch-icon, SW 프리캐시에 포함
- `file_handlers`(.txt) + `launchQueue.setConsumer` — 설치한 앱으로 .txt를 열면 변환 탭에 바로 로드
- 아이콘은 기존 파비콘 SVG에서 생성 (maskable은 안전 영역 여백)

#### 2) 접근성 (`index.html`, `core.js`, `ui-state.js`)
- 글자 없는 아이콘 버튼 aria-label, 스킨 견본 `role="button"`+`tabindex`+Enter/Space, 진행률 `role="progressbar"`, 토스트 컨테이너 `role="status"`, 미리보기 모달 `role="dialog"`
- 모달 포커스: 열리면 첫 입력란/버튼, Tab 순환(모달 밖으로 안 나감), 닫으면 열기 전 위치로 복귀 — 전역 keydown 핸들러 1개 원칙 유지
- 버그: Esc가 입력란 포커스 상태에서 무시돼 **표지 검색 모달은 Esc로 닫히지 않던 문제**(열리자마자 검색창 포커스) → 입력란 거르기 전에 처리

#### 3) 작업 복원 (`convert.js`, `parser.js`)
- `SettingsDB`(IndexedDB)에 `session_v1` — TXT `File`·편집한 목차(편집했을 때만)·제목/작가/시리즈/패턴·표지, 0.8초 디바운스, 합계 300MB 초과는 건너뜀
- 시작 0.7초 후(launchQueue 우선) '이전 작업을 이어서 할까요? (N개 파일 · 목차 편집 포함 · N분 전)' → 파일 재로드 → 자동 감지 완료 대기 → 편집 목차·메타 덮어쓰기
- 변환 탭 초기화 시 삭제

#### 4) 기기별 미리보기 (`ui-state.js`, `style.css`)
- 미니 리더 위 세그먼트(기본·폰·태블릿·6″ 리더) — 화면 비율 프레임 안에서 줄 수 제한 해제, EPUB 여백 설정 반영, 전자잉크는 흑백. 선택은 브라우저에 기억

#### 5) StateManager 구독 (점진 전환 1단계)
- `S.txtFiles` 변경 → `updateBtmBar` 를 구독에서 호출 (호출 지점마다 직접 부르던 코드 제거)
- 제자리 `splice` 3곳(드래그·터치 이동, 개별 제거)을 새 배열 교체로 → 이전엔 구독이 알 수 없어 순서 변경·개별 제거 후 하단 바 정보가 갱신되지 않음
- 테스트: `S.txtFiles`의 제자리 변경 메서드 사용 금지

#### 6) 인라인 스타일 → 유틸리티 클래스 (점진 1단계)
- `index.html` 반복 패턴 19종 83곳 → `.u-fs-xs`·`.u-mt-8`·`.u-desc`·`.dz-icon` 등 (토큰 그대로). `display:none`(스크립트가 표시 전환)은 유지
- 변경 전후 5개 탭 전체 페이지 스크린샷(설정 탭은 접힌 패널 모두 펼침) **픽셀 차이 0** 확인

#### 7) 검증
- 테스트 343 → 358개 전부 통과
- 브라우저 E2E(Chromium, CSP 적용): manifest 파싱 오류 0(CDP), launchQueue로 .txt 열기 → 25화 감지, 목차 병합 후 새 탭에서 복원 제안 → 24화·제목 복원, 파일 추가·개별 제거 후 하단 바 갱신, 폰 프레임, 표지 검색 모달 포커스 진입·Tab 25회 순환 유지·검색창에서 Esc로 닫힘·여는 버튼으로 포커스 복귀, 스킨 견본 Enter, 콘솔 오류·CSP 위반 0

### Phase 17 — 상태 구독 · 스타일 정리 2단계

#### 1) StateManager 구독 2단계 (`core.js`, `convert.js`, `ui-state.js`)
- `S.converting` 추가 — 변환 중복 실행 방지용 모듈 변수 `_convertRunning`을 대체하는 단일 소스
- 변환 버튼 `disabled`·`aria-busy`는 `S.converting` 구독이 반영 (저장 위치 선택 대기 중에도 잠김)
- 다운로드 바: `S.epubBlob`이 생기면 표시, `null`이 되면 숨김 + 변환 탭이면 변환 바 복귀 — 변환 완료·초기화·새 파일 로드 경로에서 직접 부르던 코드 제거 (`_hideEpubDownloadBar` 신설)
- `S.epubName`을 `S.epubBlob`보다 먼저 설정 → 구독이 바를 띄울 때 새 파일명 사용 (이전 이름이 잠깐 보이는 문제 방지)
- 스트리밍 저장은 결과 Blob이 없으므로 다운로드 바가 뜨지 않음 (기존 동작 그대로)

#### 2) 인라인 스타일 정리 2단계 (`index.html`, `style.css`)
- 반복 패턴 18종 36곳 → 클래스 (`.note-blue`·`.inp-xs`·`.lbl-110`·`.code-accent`·`.hr-fill`·`.sep-top`·`.u-row-6` 등 14개 신설, `txt-meta-sm`·`opt-select`·`u-*` 재사용)
- id가 있는 요소의 1회성 style 27곳 → `style.css`의 `#id` 규칙 (값·토큰 그대로)
- `display:none`(스크립트가 표시 전환) 48곳과 id 없는 1회성 style은 유지 → 183 → 120
- 검증: 데스크톱 라이트·다크·모바일 390px × 5개 탭, 접힌 패널 펼침 + 숨김 패널 강제 표시 상태까지 변경 전후 **픽셀 차이 0** (1회 6px 차이는 재실행 시 사라진 타이밍 노이즈)

#### 3) 검증
- 테스트 358 → 371개 전부 통과 (실제 `StateManager`로 구독 순서 busy → 바 표시(새 이름) → busy 해제 → 숨김 확인 포함)
- 브라우저 E2E(Chromium, CSP 적용): 변환 중 샘플 25회 모두 버튼 disabled·aria-busy, 완료 후 다운로드 바 표시·파일명 `p17.epub`, 결과 초기화 시 바 숨김·변환 바 복귀, 스트리밍 저장 145조각·바 없음, 콘솔 오류·CSP 위반 0

### Phase 18 — 표시 전환 단일 경로 (hidden 속성)

#### 1) `setShown(el, on)` 헬퍼 (`core.js`)
- `el.hidden=!on` + 남아 있는 인라인 `display` 제거, 요소가 없으면 아무 일도 하지 않음 (`?.` 가드 대신 헬퍼가 null 처리)
- 숨김은 기존 `[hidden]{display:none!important}`, 보일 때의 display 값(flex·block·grid)과 나머지 선언은 `style.css` Phase 18 블록의 `#id` 규칙(38개)

#### 2) 전환 대상
- 처음에 숨어 있던 48개 요소(초기화 바·스마트 패턴 결과·목차 탭·분할 섹션·편집 섹션·하단 일괄/편집/다운로드 바·CSS 가져오기 등)의 인라인 `display:none` → `hidden` 속성
- 이 요소들을 `style.display`로 켜고 끄던 코드 약 90곳 → `setShown` (parser·settings·ui-state·convert·edit), 보임 판독(`style.display!=='none'`) → `!el.hidden`
- 같은 함수에서 함께 전환되는 `btmConvert`·`txtFileList`·`tb0`·`eTb0`·`editPanel_toc`도 같은 방식으로 통일
- `#btmDownload:not([style*="none"])` 선택자 → `:not([hidden])`
- 정리: `#txtInfo`는 Phase 13부터 의도적으로 숨김인데 `style.display='block'`을 쓰던 무효 코드 제거 (동작 변화 없음)

#### 3) 검증
- 이전/이후 동등성 (Chromium):
  - 53개 요소를 각각 보이게 했을 때 계산된 display 값 동일 (데스크톱·모바일)
  - 사용 흐름 23단계(TXT 로드·목차 탭·패턴 제안·스마트 패턴·잡음 필터·변환·편집 탭 EPUB 로드·하위 탭·삽입 TXT·초기화·일괄·탭 전환)마다 보임/숨김 상태 동일
  - 기본 상태 15개 화면(라이트·다크·모바일 × 5개 탭) + 모든 숨김 요소를 보이게 한 10개 화면 픽셀 차이 0
- 테스트 371 → 381개 전부 통과, Phase 16·17 E2E 재실행 정상, 콘솔 오류·CSP 위반 0

### Phase 19 — 인라인 style 4단계 (index.html style 속성 0)

#### 1) 변환 방식 (`index.html`, `style.css`)
- 남은 72곳은 모두 id 없는 요소의 1회성 style → 성격에 따라 둘로 나눔
  - 1~3개 선언 조합: 원자 유틸리티 45개 신설 (`u-gap-5/6/8/10`·`u-py-3/4/6/8`·`u-bb`·`u-flex`·`u-wrap`·`u-text2`·`u-fw-600`·`u-row-wrap-8/10` 등) + 기존 `u-*`·`txt-meta-sm` 재사용
  - 역할이 분명한 복합 스타일: 의미 클래스 16개 (`rx-guide`·`rx-guide-table`·`note-yellow`·`sec-caps`·`sub-head`·`sub-head-top`·`mini-head`·`item-title`·`card-flush`·`edit-tabs-bar`·`sec-split`·`btn-block-lg`·`divider-label`·`quick-sel-row` 등)
- 변환 스크립트(`mig4.py`)가 요소마다 클래스 조합의 선언 = 원래 inline 선언(속성·값 완전 일치)인지, 같은 속성을 두 클래스가 지정하지 않는지 확인 — 유틸리티는 class 속성 순서가 아니라 CSS 정의 순서로 이기므로 충돌 자체를 금지
- 값·토큰 그대로 (하드코딩 색상 없음), index.html style 속성 72 → **0**

#### 2) 검증
- 계산된 스타일 비교: 72개 중 런타임에 존재하는 71개 요소(1개는 빠른 선택 칩 영역이 시작 시 다시 그려짐)의 546개 속성 전부 — 데스크톱 라이트·다크·모바일에서 차이 0
- 기본 상태 15개 화면 + 숨김 요소를 모두 보이게 한 10개 화면 픽셀 비교 동일 (일괄 탭 그라데이션의 3픽셀 1단계 차이는 렌더링 노이즈), Phase 18 사용 흐름 23단계 보임 상태 동일
- 테스트 381 → 386개 전부 통과 (유틸리티 속성 충돌 검사 포함), Phase 16·17 E2E 재실행 정상, 콘솔 오류·CSP 위반 0

#### 3) 남은 일
- JS가 innerHTML로 만드는 마크업에 `style="..."`이 약 165곳 남아 있어 CSP `style-src 'unsafe-inline'`은 아직 필요 (스크립트 실행 경로는 아님) → Phase 20에서 해결

### Phase 20 — CSP `style-src 'unsafe-inline'` 제거

#### 1) JS가 만드는 마크업의 style 속성 → 클래스 (`parser.js`·`convert.js`·`edit.js`·`ui-state.js`·`settings.js`·`cover-search.js`)
- 164곳 (정적 146 · 동적 18) — 정적 값은 변환 스크립트(`mig5.py`)가 자동 변환
  - 기존 유틸리티와 선언이 정확히 같으면 그 클래스, 큰 복합 스타일은 의미 클래스(+보충 유틸리티), 나머지는 단일 선언 유틸리티 조합
  - 요소마다 클래스 선언 합 = 원래 선언, 같은 속성을 두 클래스가 지정하지 않음을 검사 / 같은 태그의 기존 class 속성에 병합(문자열 조각이 나뉜 태그 33곳 포함)
- 동적 값: 색은 모두 고정 토큰이라 클래스로 (`u-green`·`u-accent`·`u-red`·`chip-blue/muted/accent`·`fill-yellow/blue/accent`·`preset-opt-good`), 단축키 표 `kbdStyle` → `.kbd-key`
- 템플릿에서 `display:none`으로 만들던 요소(목차 자동 선택·일괄 분할 배지·간격 분할 해제 버튼·편집 삽화 키워드 칸) → `hidden` 속성 + `setShown`
- 새 유틸리티 53개 + 의미 클래스 32개 (`modal-card`·`tip-card`·`info-box-blue`·`tag-xs`·`tone-*`·`stat-chip`·`report-list`·`report-item-info/warn`·`badge-*-line`·`preset-panel`·`preset-opt`·`inp-sm`·`kbd-key`·`spark-bar` 등), 값·토큰 그대로

#### 2) 인라인이 이기던 구체적인 규칙 (검증에서 발견)
- 클래스는 인라인과 달리 더 구체적인 선택자에 질 수 있음 → 문서 전체 계산된 스타일 비교로 3곳 발견, 범위 지정 규칙으로 이전 값 유지
  - `#toc-search{padding:4px 10px}` 위의 인라인 `padding:5px 8px` → `#toc-search.u-p-5-8`
  - `#shortcutHelp kbd{padding:2px 7px}` 위의 인라인 → `#shortcutHelp kbd.kbd-key`
  - `.mill-row input,select{background:var(--panel)}` 위의 인라인 `background:var(--bg)` → `.mill-row .inp-sm`

#### 3) CSP (`_headers`, `index.html` meta)
- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` → `style-src 'self' https://fonts.googleapis.com`
- 동적 크기·위치(진행 막대 폭, 툴팁 위치, 미니 리더 글꼴 등)는 CSSOM `el.style.*`이라 CSP 대상 아님 — 그대로 동작

#### 4) 검증
- 사용 흐름 24단계(TXT 로드·재감지·목차 미리보기·다중 선택 병합·제목 일괄·짧은 챕터 토스트·간격 분할 입력·삽화 파일/수동 행/범위·변환 리포트·EPUB 미리보기·CORS 안내·단축키·분할 변환·일괄 목록/목차/패턴 패널·편집 EPUB/삽입/삽화 행/목차 재확인/직접 편집 삽화·설정 프리셋/기록·패턴 없는 TXT 안내)마다 **문서 전체 요소의 계산된 스타일**을 이전/이후 비교 → 위 3곳 수정 후 차이 0 (진행 시간 스파크라인 막대 높이·토스트 소멸 시점은 실행마다 달라지는 값)
- 엄격 CSP(`'unsafe-inline'` 없음)로 같은 24단계 → `securitypolicyviolation` 0건·페이지 오류 0, Phase 16·17 E2E 재실행 정상
- 테스트 386 → 394개 전부 통과 (이전 Phase 스타일 검사는 자기 블록 범위만 보도록 정리)

### Phase 21 — 사이트 접속 오류(ERR_FAILED) 수정 (`sw.js`, `tests/stamp-sw.js`)

#### 1) 원인
- Cloudflare Pages는 `/index.html` 요청을 `/`로 308 리디렉트 (pretty URL)
- SW 설치 때 `cache.addAll`이 `./index.html`을 리디렉트를 거친 응답(`redirected: true`)으로 저장 → 페이지 이동(navigate, redirect 모드 manual)에 이 응답을 돌려주면 Chrome이 네트워크 오류로 처리
- 결과: 첫 방문은 정상, SW 설치 뒤 두 번째 방문부터 '사이트에 연결할 수 없음 (ERR_FAILED)' — Phase 15 SW 재작성부터 잠재, Phase 20과 무관
- 같은 리디렉트를 하는 로컬 서버(`cfserve.py`)로 재현: 첫 방문 200 → 재방문 `net::ERR_FAILED`

#### 2) 수정
- `_plain(resp)`: 리디렉트를 거친 응답이면 본문·상태·헤더만 담은 새 응답으로 바꿈 — 프리캐시 저장 전, 페이지 이동 응답 직전(이전 버전이 남긴 캐시 대비), 로컬 자원 캐시 저장 전
- 설치: `addAll` 대신 자산마다 `cache:'reload'`로 받아 `_plain` 후 저장, 하나라도 실패하면 새 캐시를 지우고 설치 실패 (원자성 유지)
- 복구: 설치 시점에 열린 화면이 없으면(첫 설치, 또는 이전 SW 오류로 화면이 뜨지 못한 경우) 대기 없이 활성화 — 화면이 열려 있으면 기존처럼 업데이트 배너
- `CACHE_VERSION` 해시에 sw.js 자체 코드(CACHE_VERSION 줄 제외) 포함 → SW 로직만 바뀌어도 새 캐시 이름

#### 3) 검증 (Cloudflare 리디렉트 흉내 서버 + Chromium)
- 새 방문자: 1회차 네트워크 → 2·3회차 SW 응답 200, 오프라인 새로고침 200
- 고장 SW에 갇힌 브라우저: 새 sw.js 배포 후 1회는 이전 SW가 처리해 실패(이때 업데이트 확인), 다음 새로고침부터 정상
- 화면이 열린 상태의 일반 업데이트: 새 SW 대기 + 업데이트 배너 (즉시 교체 안 함)
- 테스트 394 → 398개 전부 통과 (`_plain` 실제 동작 포함)

### Phase 22 — 커스텀 폰트 서브셋 (HarfBuzz WebAssembly)

#### 1) 엔진 (`lib/harfbuzz-subset.wasm`, `lib/harfbuzz-LICENSE.txt`)
- HarfBuzz 공식 `harfbuzzjs` 1.6.3의 서브셋 전용 빌드 (667KB, 압축 전송 약 270KB, import 없음) — 비공식 `hb-subset-wasm` 0.5.0(744KB, 공개 며칠)보다 작고 공식 저장소 관리
- 커스텀 폰트로 변환할 때만 `fetch(..., {integrity: sha384})` → `WebAssembly.compile` (모듈 재사용, 호출마다 새 인스턴스로 메모리 해제), 한 번 받으면 SW 캐시로 오프라인에서도 동작
- CSP `script-src`에 `'wasm-unsafe-eval'` 추가 (WebAssembly 컴파일만 허용, JS `eval`·`new Function`은 계속 차단) — `_headers`·meta 동일

#### 2) 변환 흐름 (`epub-gen.js` `launchEpubWorker`)
- Worker에 폰트를 보내기 직전 `_subsetCustomFont`: 글자 집합 = 제목·작가·시리즈·챕터 제목·본문 + EPUB 템플릿 고정 문구(Worker 소스의 비ASCII 문자) + CSS가 만드는 문자 + ASCII 출력 문자 — 실제 표시 글자의 상위 집합
- 글자 수집은 BMP 비트맵(Uint8Array 64K) + 보조 평면 Set — 8.6MB 원고 14ms
- TTF·OTF만 (WOFF·WOFF2·TTC는 원본 그대로), OS/2 fsType '서브셋 금지(0x0100)'면 원본, '임베딩 제한(0x0002)'이면 경고
- 엔진을 못 받거나·CSP가 막거나·오류가 나면 원본 그대로 넣고 리포트에 이유 — 폰트 때문에 변환이 실패하지 않음
- 서브셋한 폰트는 CSS `@font-face` 앞에 `/* novelepub:font-subset */` 표식
- 변환 리포트(ℹ): '폰트: 책에 쓰인 글자 N자만 남겨 A → B로 줄였어요' 또는 원본 그대로 넣은 이유
- 설정 > 커스텀 폰트 '쓰인 글자만 포함 (서브셋)' 토글 (기본 켜짐, 저장·복원) — 일괄 변환·분할 변환도 같은 경로

#### 3) 편집 탭 (`refreshEpubFontSubset`)
- 표식이 있는 EPUB을 편집(TXT 삽입·목차·삽화·CSS)하면 결과 EPUB의 글자로 다시 서브셋 — 설정에 같은 이름의 원본 폰트가 있을 때
- 원본이 없으면 '편집으로 새로 생긴 글자 중 폰트에 없는 것'의 수를 알림 (편집 전 EPUB과 비교 — 원래부터 없던 이모지·드문 한자는 세지 않음), 표식 없는 폰트(다른 도구가 만든 EPUB)는 건드리지 않음
- 삽입 챕터는 시스템 글꼴을 !important로 강제하므로(기존 동작) 글자 집계에서 제외

#### 4) 검증
- Node: 실제 HarfBuzz로 TTF·OTF 픽스처(Noto Sans CJK KR 일부, OFL — `tests/fixtures/fonts/`) 서브셋 → 쓰인 글자 모두 cmap에 남음·용량 감소, 제외·실패 경로, EPUB `tests/out/22_font_subset.epub`(epubcheck 0 오류) 문서 글자 ⊂ 폰트, 편집 탭 재서브셋·누락 글자 — 테스트 398 → 413개 통과
- Chromium: 원본·서브셋 폰트로 같은 문장을 그린 캔버스 픽셀 차이 0 (글자 픽셀 23,031개), 앱 흐름 184KB → 38KB·리포트·토글 끄면 원본, `'wasm-unsafe-eval'` 없는 CSP에서 원본+안내, 오프라인 재변환 서브셋 동작, 엄격 CSP 24단계 위반 0, Phase 16·17 E2E 정상
- 실측: Noto Sans CJK KR 15.7MB → 359KB (8.6MB 장편, 2,484자, 서브셋 0.17초)

### Phase 23 — 실제 변환 결과에서 발견한 문제 (사용자 EPUB 비교)

#### 1) 비교한 두 EPUB (천하제일인은 스트리머로 전직했다 0-620, 622개 문서)
| | 4,748KB (2026-07-09, 이전 버전) | 5,360KB (Phase 22) |
|---|---|---|
| 폰트 파일 | 없음 | custom_font.ttf 1,481KB (압축 593KB) — 교보손글씨2024박서우 12.5MB 서브셋 |
| body 글꼴 | 'Noto Sans KR' | 'Noto Sans KR' ← 폰트를 넣고도 쓰지 않음 (버그) |
| epubcheck | 오류 2 (dcterms:modified 없음, 표지 형식 불일치) | 오류 1 (표지 형식 불일치) |
- 용량 차이 612KB = 폰트 파일 — '기존 방식(원본 12.5MB 포함)'이었다면 폰트만 압축 후 약 5MB로 추정
- 손글씨 폰트는 글리프 외곽선이 복잡(중앙값 154점, 글자당 약 815바이트) → 1,828자에 1.4MB, 책에 쓰인 2,446자 중 618자는 원래 폰트에 없음(리더기 기본 글꼴로 표시)

#### 2) 수정
- **글꼴 목록 재생성** (`settings.js buildFontDropdown`): `innerHTML` 교체로 `#customFontOpt`가 사라지고 저장 선택이 지워지던 문제 → 커스텀 옵션 다시 추가 + 현재·저장 선택 유지 (일반 글꼴 선택도 새로고침 후 유지)
- **로드 경합** (`ui-state.js`): 커스텀 폰트가 비동기로 복원된 뒤 저장 선택이 커스텀이면 다시 선택
- **미사용 폰트** (`epub-gen.js`): 커스텀 폰트를 쓰는 CSS 규칙(본문 글꼴·추가 CSS)이 없으면 EPUB에 넣지 않고 경고 — '설정 > 글꼴에서 📁 이름을 고르세요'
- **표지 형식** (`convert.js _sniffImageExt`): 이름 대신 바이트 시그니처(PNG·JPEG·WebP·GIF·BMP·TIFF·AVIF·HEIC)로 판별 → 표지 검색의 'cover.jpg'(실제 PNG)도 JPG로 변환

#### 3) 검증
- Chromium: 폰트 업로드 → 선택 = 커스텀, 새로고침 후에도 유지, 변환 시 body = 커스텀 폰트 + 서브셋(184KB → 38KB), 다른 글꼴 선택 시 폰트 미포함 + 경고, 'cover.jpg' 이름의 PNG 표지 → EPUB 표지 JPEG(FF D8 FF), 두 결과 epubcheck 0 오류, 일반 글꼴 선택 새로고침 유지, Phase 16·17 E2E 정상
- 테스트 413 → 419개 통과

### Phase 24 — 표지 온라인 검색 복구 (플랫폼 개편 대응)

#### 1) 진단 (실서비스에서 어댑터별 실측, 검색어 '전지적 독자 시점')
| 어댑터 | 수정 전 | 원인 |
|---|---|---|
| 리디 | 0건 | Next.js 개편 — `.thumbnail_wrapper` 마크업 소멸, 데이터는 `__NEXT_DATA__` JSON |
| 카카오페이지 | 0건 | 검색 페이지가 완전 CSR(빈 HTML) — 결과는 bff 검색 API로만 옴 |
| 네이버 시리즈 | 2건 (79×119) | 썸네일 접미사가 `type=m79`로 바뀌어 고해상도 치환 무효 |
| 노벨피아 | 6건 **전부 가짜** | 결과를 AJAX로 그려 HTML엔 메뉴·배너뿐 → `none_user.png`·메뉴 SVG를 표지로 반환 |
| 웹 폴백 | 실행 안 됨 | 노벨피아 가짜 6건 때문에 '결과 3건 이상'으로 집계 |
- 프록시(Workers)·CSP는 정상 — 모든 플랫폼 HTML이 200으로 도착

#### 2) 수정 (`cover-search.js`)
- **리디**: `__NEXT_DATA__`에서 `{ title, thumbnail: { xxlarge } }` 객체 수집 (경로 변경에 둔감한 트리 탐색), `#1` 해시 제거 → 480×680
- **카카오**: bff 검색 API(`/api/gateway/api/v2/search/series`) JSON 파싱, 웹소설 우선, `filename=o1` 원본(720×970) — ⚠️ Workers 경유 시 bff가 403 → Worker가 `Referer: https://page.kakao.com/`을 보내도록 고치면 동작
- **네이버 시리즈**: `?type=` 제거 → 원본 700×1000, 제목은 img alt
- **노벨피아**: 사이트 검색 모달이 쓰는 `POST /proc/novelsearch/{검색어}` JSON, `/imagebox/cover/` 표지만 채택 (`_proxyPostJson` 헬퍼 추가)
- **병렬 조회**: 4개 플랫폼 `Promise.allSettled` — 한 곳이 느려도 전체가 순차 지연되지 않음, 플랫폼별 건수 콘솔 기록
- `tests/cover-health.js` 표식 갱신 (리디 `__NEXT_DATA__`, 카카오 bff, 노벨피아 POST JSON)

#### 3) 검증
- 실서비스 페이지에서 새 어댑터 실행: '전지적 독자 시점' 리디 6·네이버 2·노벨피아 6, '나 혼자만 레벨업' 6·5·6, '재벌집 막내아들' 6·6·0 (노벨피아에 없는 작품)
- 표지 이미지 weserv 경유 로드 확인 (리디 480×679, 네이버 700×1000, 노벨피아 400×600)
- 테스트 419개 통과, `node --check` 통과

---

## 개선 30개 적용 결과 (Phase 13~16)

| 카테고리 | 적용 | 비고 |
|------|------|------|
| 변환 품질 | 5/5 | Phase 13 |
| EPUB 호환 | 5/5 | Phase 14 + Phase 22(폰트 서브셋 — HarfBuzz WebAssembly 도입으로 원칙 변경) |
| 성능·안정성 | 5/5 | Phase 12(64KB 감지) + Phase 15 |
| UX/UI | 5/5 | Phase 16 + Phase 12(프록시 자동 재시도) |
| 보안·인프라 | 5/5 | Phase 12(Worker 허용 목록) + Phase 15 |
| 유지보수 | 3/5 + 부분 | 인코딩 단일화·테스트 확장 완료, StateManager는 점진 2단계(Phase 17), 인라인 스타일은 Phase 20까지 완료(HTML·JS 마크업 style 속성 0, CSP style-src 'unsafe-inline' 제거), `@ts-check`는 외부 도구 미사용 결정으로 제외 (ESLint는 자체 정적 검사로 대체) |

---

## 파일별 역할 요약

| 파일 | 줄수(Phase 10) | 역할 | Phase 5 변경 |
|------|------|------|--------------|
| `convert.js` | 2,892 | 변환 탭: 파일 I/O, 인코딩 감지, 이미지 처리, 삽화 자동/수동 | 없음 |
| `parser.js` | 3,756 | 챕터 파싱, 목차 렌더링, 가상 스크롤, 통계, 캐시 | 없음 |
| `edit.js` | 1,632 | EPUB 편집 탭: OPF 파싱, 챕터 수정, 재생성, 연속 삽입 | 없음 |
| `style.css` | 1,315 | 테마, 컴포넌트, 애니메이션, 스킨 시스템 | Phase 7: 글꼴·타입·반경 토큰 통일, 스킨 CSS 신설, 미사용 규칙 정리 |
| `index.html` | 1,303 | SPA 마크업, 탭 구조, SVG 드롭존 | **✅ 업데이트** — .page-tabs-wrap 래퍼 추가, Base64 SVG 파비콘 인라인 교체 |
| `settings.js` | 1,373 | CSS 설정, 폰트, 프리셋, 스마트 패턴, 히스토리, Gemini API 교류부 | 없음 |
| `core.js` | 848 | 아키텍처 코어, 상태 프록시, Cloudflare Workers 보안 프록시 인프라 허브 | 없음 |
| `cover-search.js` | 924 | 표지 검색 모달, 플랫폼별 어댑터(Naver, Kakao, Ridi, Novelpia), .file 확장자 필터 우회 가드, 크롭 처리 | 없음 |
| `ui-state.js` | 1,317 | UI 상호작용, 모달 제어, 가시성 레이아웃, 이벤트 버스 핸들러 | **✅ 업데이트** — display 표준 토글 전환, scrollTo 가드, _setupHeaderCompact, MutationObserver 모달 침강, 탭 인디케이터 JS-CSS 브릿지 |
| `epub-gen.js` | 564 | 이펍 빌드, JSZip 브릿징, 워커 격리 쓰레딩 | 없음 |
| `worker.js` | 129 | 5MB+ 파일 인코딩 감지·디코딩 전담 (챕터 파싱은 parser.js 단일 소유) | Phase 6: 미사용 파싱 경로 제거 |
| `sw.js` | 218 | PWA 지원 오프라인 캐싱 매니저 | 없음 |

#### 🧪 크로스 가드 오디팅 결과
- `convert.js` 내의 `applyCoverUrl` 정합성 대조 결과: `.file` 수용 시 추출 확장자가 유효 리스트에 없으면 자동으로 안전값인 `'jpg'` 폴백 가드가 발동함을 확인하여 런타임 무결성 100% 충족 보장.
- Phase 5 `display` 토글 전환 이후 전 탭(변환/일괄변환/편집) 렌더링 격리 정상 동작 확인. 탭 전환 시 하단 밀림 및 화이트아웃 재현 불가 판정.
- `.page-tabs-wrap` 마크업 추가 후 기존 `[data-tab]` EventDelegate 바인딩 및 `switchPage()` 내 querySelector 경로 정상 해석 확인.
- `toastSpringIn` / `toastSpringOut` 키프레임 적용 후 기존 Toast 큐잉 로직(`core.js`) 영향 없음 확인 — 순수 CSS 레이어 변경이므로 JS 로직 비간섭.
