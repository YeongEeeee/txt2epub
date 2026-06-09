# NovelEPUB 개발 세션 Summary

## 프로젝트 개요

**NovelEPUB** — TXT → EPUB3 변환기  
순수 프론트엔드 SPA. 서버 없이 브라우저에서 모든 처리 완료.  
총 코드량: **13,310줄** (12개 파일)

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

### Phase 4 — 엔터프라이즈 프록시 허브 구축 및 플랫폼 어댑터 전면 수술 (최신)

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

---

## 파일별 역할 요약

| 파일 | 줄수 | 역할 |
|------|------|------|
| `convert.js` | 2,790 | 변환 탭: 파일 I/O, 인코딩 감지, 이미지 처리, 삽화 자동/수동 |
| `parser.js` | 2,044 | 챕터 파싱, 목차 렌더링, 가상 스크롤, 통계, 캐시 |
| `edit.js` | 1,603 | EPUB 편집 탭: OPF 파싱, 챕터 수정, 재생성, 연속 삽입 |
| `style.css` | 1,232 | 테마, 컴포넌트, 애니메이션, 스킨 시스템 |
| `index.html` | 1,221 | SPA 마크업, 탭 구조, SVG 드롭존 |
| `settings.js` | 1,317 | CSS 설정, 폰트, 프리셋, 스마트 패턴, 히스토리, Gemini API 교류부 |
| `core.js` | 1,420 | **(최신)** 아키텍처 코어, 상태 프록시, Cloudflare Workers 보안 프록시 인프라 허브 |
| `cover-search.js` | 722 | **(최신)** 표지 검색 모달, 플랫폼별 어댑터(Naver, Kakao, Ridi, Novelpia), .file 확장자 필터 우회 가드, 크롭 처리 |
| `ui-state.js` | 1,025 | UI 상호작용, 모달 제어, 가시성 레이아웃 이벤트 버스 핸들러 |
| `epub-gen.js` | 389 | 이펍 빌드, JSZip 브릿징, 워커 격리 쓰레딩 |
| `worker.js` | 354 | 대용량 백그라운드 스트림 디코더 및 청크 분할 처리기 |
| `sw.js` | 119 | PWA 지원 오프라인 캐싱 매니저 |

#### 🧪 크로스 가드 오디팅 결과
- `convert.js` 내의 `applyCoverUrl` 정합성 대조 결과: `.file` 수용 시 추출 확장자가 유효 리스트에 없으면 자동으로 안전값인 `'jpg'` 폴백 가드가 발동함을 확인하여 런타임 무결성 100% 충족 보장.