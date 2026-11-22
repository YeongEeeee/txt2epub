# 📏 NovelEPUB 기준선 (Phase 0)

> 이후 모든 Phase는 이 문서의 숫자와 비교해 보고한다. 감으로 "개선됨"이라고 쓰지 않는다.

| 항목 | 값 |
|---|---|
| 측정일 | 2026-11-22 |
| 기준 커밋 | `dfd847b` — feat: Phase 29 — 선택 정규식 3단계 목차 파이프라인 |
| 측정 환경 | Linux 헤드리스 Chrome · Node 22 · 로컬 정적 서버 |
| 외부 네트워크 | 구글 폰트·표지 검색 요청은 **차단한 상태로 측정** (환경마다 결과가 흔들리지 않게) |

---

## 🔁 재현 명령 (PowerShell)

```powershell
# 1) 회귀 테스트 + 챕터 감지 정확도
npm test

# 2) 정적 디자인 지표 (의존성 없음)
node tests/measure-design.js

# 3) 런타임 지표 — 측정 도구는 앱 의존성이 아니므로 --no-save로 임시 설치
npm install --no-save playwright-core axe-core
node tests/measure-runtime.js --runs 5   # INP는 1회 값이 크게 흔들려 5회 중앙값으로 비교

# 4) Lighthouse — 배포 사이트 기준 (실제 사용자 조건, 구글 폰트 포함)
npx lighthouse https://novel2epub.pages.dev/ --only-categories=performance,accessibility,best-practices --view
npx lighthouse https://novel2epub.pages.dev/ --preset=desktop --only-categories=performance,accessibility,best-practices --view

# 5) EPUBCheck — npm test가 만든 tests\out\*.epub 검사 (Java 17 필요)
Invoke-WebRequest https://github.com/w3c/epubcheck/releases/download/v5.1.0/epubcheck-5.1.0.zip -OutFile epubcheck.zip
Expand-Archive epubcheck.zip -DestinationPath . -Force
Get-ChildItem tests\out\*.epub | ForEach-Object { java -jar epubcheck-5.1.0\epubcheck.jar $_.FullName }
```

---

## ✅ 1. 회귀 테스트 · 챕터 감지 정확도

`npm test` → **통과 479 / 실패 0** (실행 약 2.7초)

| 실전형 샘플 (생성기 `tests/gen-realistic.js`) | 본편 감지 / 정답 | 정밀도 | 재현율 | 시간 |
|---|---|---|---|---|
| 재활만 했는데 드래곤의 힘… (1–201, 3종 혼합) | 201 / 201 | 100.0% | 100.0% | 12ms |
| 퇴사 후 미국 여행… (1–325, 2종 혼합·화 누락 2개) | 323 / 325 | 100.0% | 100.0% | 11ms |
| 청년 가장이 재물을… (1–200, 빈 줄 없는 압축형) | 200 / 200 | 100.0% | 100.0% | 5ms |
| 최강 신이라 불리는 사나이 (1–868, 3종 혼합·권 구분) | 868 / 868 | 100.0% | 100.0% | 30ms |
| 작은 시골 마을에는… (0–853, 숫자만·EP.N) | 854 / 854 | 100.0% | 100.0% | 29ms |

- 골든 고정 샘플 15종(`tests/fixtures`) 전부 일치
- 대용량: 401,700줄 / 20,281챕터 메인 스레드 파싱 353ms · 패턴 없는 20만 줄 감지 약 540ms
- 퇴사 후 샘플의 323/325는 생성기가 47·210화를 일부러 삭제한 결과이며, 정답 제목 줄 기준 정밀도·재현율은 100%
- ⚠️ 한계: 실전형 샘플도 생성기로 만든 합성 데이터다. 실제 연재 TXT로 검증한 수치는 아니다

**EPUBCheck**: CI(`.github/workflows/test.yml`)가 `tests/out/*.epub` 12개를 W3C EPUBCheck 5.1.0으로 검사한다. 이 측정 세션에서는 직접 실행하지 못했으므로 **수치 미기록** — 위 5번 명령 또는 GitHub Actions 결과로 채운다.

| EPUBCheck | 오류 | 경고 |
|---|---|---|
| tests/out 12개 | (미측정) | (미측정) |

---

## ⚡ 2. Lighthouse (로컬 서버 · 구글 폰트 차단 상태)

| 조건 | 성능 | 접근성 | 권장사항 | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| 모바일 (기본: 느린 4G·CPU 4배 시뮬레이션) | **59** | 95 | 100 | 7.2s | 7.2s | 30ms | 0 |
| 데스크톱 | 93 | 95 | 100 | 1.3s | 1.3s | 0ms | 0 |

- 접근성 감점: `color-contrast`(모바일 14·데스크톱 16노드), `label-content-name-mismatch`(1), `landmark-one-main`(1 — `<main>` 없음)
- 모바일 성능 감점의 주원인: 렌더 차단 리소스 예상 절감 6,120ms. 비압축 JS 약 1MB(parser.js 221KB · convert.js 173KB 등 12개 파일)와 style.css 105KB가 첫 화면 전에 모두 로드됨
- 이 표는 로컬 측정이다. 배포 사이트 수치는 위 4번 명령으로 따로 기록한다

---

## 🖱 3. 상호작용 지연 · 레이아웃 이동 (`tests/measure-runtime.js`)

흐름: 탭 5개 전환 → 테마 2회 전환 → **2,000화 TXT 투입** → 목차 확인 → 제목 입력 → 변환 → 결과 카드 표시 확인

| 조건 | INP 근사 (최악 상호작용) | 최악 단계 | 탭 전환 최대 | 변환 클릭 최대 | CLS | 앱 콘솔 오류 |
|---|---|---|---|---|---|---|
| CPU 1배 | **192ms** | 목차 확인 | 56ms | 72ms | 0 | 0 |
| CPU 4배 (중급 모바일 근사) | **560ms** ❌ | 목차 확인 | 112ms | 176ms | 0 | 0 |

- ⚠️ 정정 (Phase 30): 처음 2회 실행이 우연히 비슷했을 뿐, 같은 코드를 다시 재면 1회 값이 CPU 1배 192~360ms로 크게 흔들렸다. 이후 비교는 `--runs 5` 중앙값·범위로 한다
- 같은 코드 5회 재측정(Phase 30 세션): CPU 1배 중앙값 200ms (200~208) · CPU 4배 584ms (544~656)
- 목표 INP 200ms 미만 → CPU 4배 조건에서 **미달**. 원인 단계는 2,000화 목차 확인 클릭
- 두 조건 모두 흐름 끝까지 완료 (결과 카드 표시, "2000개 장 감지됨")

---

## ♿ 4. axe-core 접근성 위반 (WCAG 2.2 AA 규칙, 탭별)

| 탭 | 라이트 | 다크 | 위반 규칙 (노드 수, 라이트 기준) |
|---|---|---|---|
| 변환 | 4종 / 22노드 | 4종 / 24노드 | color-contrast(19) · image-alt(1) · label-content-name-mismatch(1) · scrollable-region-focusable(1) |
| EPUB 편집 | 1종 / 1노드 | 1종 / 1노드 | color-contrast(1) |
| 일괄 변환 | 1종 / 11노드 | 1종 / 2노드 | color-contrast(11) |
| 히스토리 | 2종 / 3노드 | 2종 / 3노드 | color-contrast(2) · select-name(1) |
| 설정 | 5종 / 27노드 | 5종 / 26노드 | label(12) · color-contrast(7) · target-size(4) · select-name(3) · aria-required-children(1) |
| **합계** | **64노드** | **56노드** | 목표: 0 |

---

## 🎨 5. 정적 디자인 지표 (`tests/measure-design.js`)

| 지표 | 값 | 비고 |
|---|---|---|
| font-size 선언 | 227개 | 토큰 외 리터럴 5개 (고유 3종: `1.1em` `28px` `36px`) |
| 글자 크기 토큰 | 6단계 (11·12·14·15·17·21px) | Phase 7에서 이미 고정 스케일 적용 |
| 규칙 안 색상 리터럴 | 고유 36종 / 48회 | 토큰 블록 포함 전체 고유 122종 |
| box-shadow 고유 리터럴 | 37종 | 목표: 토큰 3단계 |
| border-radius 고유 리터럴 | 7종 | 토큰 3종(`--radius` `-sm` `-xs`) 외 |
| @keyframes | 24개 | animation 선언 35개 |
| **무한 반복 animation 선언** | **11개** | 이름별: liquidFlow 4 · floatBob 3 · btmShimmer 2 · progPulse 2(liquidFlow와 같은 선언) · neonBorderPulse 1 · stepBlink 1 (목표: 진행 표시 1개) |
| backdrop-filter 규칙 | 6개 | |
| index.html 인라인 style / on* 핸들러 | 0 / 0 | Phase 19·20에서 이미 0 |
| index.html 이모지 | 31자 | JS 마크업 문자열 포함 시 총 302자 (convert.js 83 · parser.js 71 · ui-state.js 32 · edit.js 31 · settings.js 24 · core.js 17 · cover-search.js 7 · main.js 5 · epub-gen.js 1) |
| JS `.style.*` 직접 대입 | 315곳 | parser.js 90 · convert.js 71 · ui-state.js 48 · core.js 36 · edit.js 32 · settings.js 16 · cover-search.js 14 · main.js 8 |
| style.css에 정의 없는 클래스 | **12종** | `cell-code` `cell-key` `cell-val` `danger` `error-boundary-detail` `progress-sparkline` `radio-lbl` `sec-divider` `sw-thumb` `sw-track` `txt-hint-sm` `txt-label-bold` |

### 명도 대비 (토큰 조합, WCAG 기준 4.5:1)

| 조합 | 라이트 | 다크 |
|---|---|---|
| `--text3` 힌트 / 페이지 배경 | 2.07 ❌ | 2.49 ❌ |
| `--text3` 힌트 / 카드 | 2.52 ❌ | 2.28 ❌ |
| `--text3` 플레이스홀더 / 입력칸 | 1.96 ❌ | 2.38 ❌ |
| `--text2` 보조 / 페이지 배경 | 4.25 ❌ | 5.92 |
| `--accent` 강조 / 강조 배경 | 4.04 ❌ | 3.79 ❌ |
| `--accent` 강조 / 카드 | 4.50 | 4.12 ❌ |
| `--on-accent` 버튼 글자 / 강조 버튼 | 4.50 | 4.44 ❌ |
| `--on-accent` 헤더 글자 / 헤더 그라디언트 끝 | 3.17 ❌ | 3.66 ❌ |
| `--green` / `--green-bg` | 5.13 | 4.34 ❌ |
| `--blue` / `--blue-bg` | 4.65 | 4.27 ❌ |
| `--text` 본문 / 페이지 배경 | 15.18 | 14.48 |
| `--yellow` / `--yellow-bg` | 6.28 | 6.59 |

---

## 🔍 6. 계획 재검증 — 이전 지적 사항의 현재 상태

계획은 6월 프로젝트 사본을 보고 세웠다. 최신 코드(Phase 29)로 다시 확인한 결과:

| 이전 지적 | 현재 상태 | 근거 |
|---|---|---|
| 히스토리·설정 페이지가 `.wrap` 밖 | ✅ 해결됨 | index.html 1260행 `</div><!-- /wrap -->` |
| 인라인 style 수백 곳 | ✅ 해결됨 (HTML 0) | 측정값 0. 단 JS `.style` 대입 315곳은 남음 |
| 모바일 브레이크포인트 누락 | ✅ 해결됨 | 360·390·768px 전 탭 가로 넘침 0 |
| UI 명조 폰트 / 9px 글자 | ✅ 해결됨 | `--font-ui` 산세리프, 6단계 고정 스케일 |
| 미정의 클래스 | ❌ 남음 (12종) | §5 |
| 단축키 표기 불일치 | ❌ 남음 | 실제 바인딩 `Ctrl+Space`(변환)·`Ctrl+S`(다운로드). 목차 힌트 title은 `Ctrl+Enter`·`Ctrl+D`, 다운로드 버튼 aria-label은 `Ctrl+D` |
| 명도 대비 미달 | ❌ 남음 | §4 axe 64노드, §5 표 |
| 무한 애니메이션 과다 | ❌ 남음 (11개) | §5 |
| 이모지 아이콘 | ❌ 남음 (302자) | §5 |

Phase 4 기능 중 이미 있는 것:

| 계획 항목 | 현재 상태 |
|---|---|
| 챕터 번호 누락·중복 감지 | ✅ 있음 — 변환 전 검수 리포트 (`buildTocReview`, Phase 13) |
| 한국어 기호·따옴표 정리 | ✅ 있음 — `optNormalizeSymbols`, `optQuoteStyle` (Phase 13) |
| 작업 자동 저장·복구 | ✅ 있음 — `optSessionRestore` (Phase 16) |
| 기기 크기 미리보기 | 🔶 일부 — 미니 리더 기기 프리셋(폰·태블릿·6″)은 있음. 생성된 XHTML+EPUB CSS를 iframe으로 그리는 방식은 아님 |
| 변환 직후 EPUB 구조 검증 리포트 | ❌ 없음 — CI EPUBCheck에만 있고 앱 안에는 없음 |
| 정리 전/후 diff | ❌ 없음 |

---

## 🎯 7. Phase 1 대상 (측정으로 확정된 것만)

1. 미정의 클래스 12종 정의 또는 기존 클래스로 교체
2. 단축키 표기 3곳을 실제 바인딩(`Ctrl+Space`·`Ctrl+S`)에 맞추고 한 곳에서 생성
3. 대비 미달 토큰 조정 → axe color-contrast 0, §5 표 전부 4.5 이상
4. axe 나머지 규칙: `label`(12) · `select-name`(4) · `target-size`(4) · `image-alt`(1) · `label-content-name-mismatch`(1) · `scrollable-region-focusable`(1) · `aria-required-children`(1) · `<main>` 랜드마크
5. (판단 필요) CPU 4배 INP 560ms — 2,000화 목차 확인 클릭. 계획 Phase에 없던 항목
6. (판단 필요) 모바일 Lighthouse 성능 59 — 렌더 차단 JS 약 1MB. 계획 Phase에 없던 항목

---

## 📈 8. Phase 30 (UI 정제 1단계) 결과 — 같은 세션에서 기준 커밋과 나란히 측정

| 지표 | 기준선 `dfd847b` | Phase 30 | 목표 |
|---|---|---|---|
| axe 위반 노드 — 테라코타 라이트 / 다크 | 64 / 56 | 0 / 0 | 0 ✅ |
| axe 위반 노드 — 인디고 · 포레스트 (라이트 / 다크) | 53 / 45 · 53 / 45 | 0 / 0 · 0 / 0 | 0 ✅ |
| 토큰 대비 4.5:1 미달 조합 (기본 스킨) | 라이트 6 · 다크 9 | 0 · 0 (스킨 3종 모두 0) | 0 ✅ |
| style.css 미정의 클래스 | 12 | 0 | 0 ✅ |
| 단축키 표기 불일치 | 3곳 + README 4개 | 0 (표 하나에서 생성) | 0 ✅ |
| Lighthouse 접근성 모바일 / 데스크톱 | 95 / 95 | 100 / 100 | — |
| INP 근사 CPU 1배 (5회 중앙값, 범위) | 200ms (200~208) | 176ms (168~208) | 변화 없음 (범위 겹침) |
| INP 근사 CPU 4배 (5회 중앙값, 범위) | 584ms (544~656) | 568ms (520~568) | 200ms 미만 → Phase 2 |
| CLS | 0 | 0 | < 0.1 ✅ |
| Lighthouse 모바일 성능 (반복 범위) | 60~69 | 59~68 | 80 이상 → Phase 2 |
| 회귀 테스트 | 479 | 498 | 전부 통과 ✅ |

- Phase 30 테스트 19개는 기준 커밋 코드에 그대로 돌리면 19개 모두 실패 — 수정이 없으면 잡히는 검사임을 확인
- Lighthouse 모바일 성능은 같은 코드에서도 59~69로 흔들려 단일 값 비교는 의미 없음 → Phase 2에서 3회 이상 중앙값 사용
- 디자인 지표(무한 애니메이션 11 · 그림자 37종 · 색상 리터럴 36종 · 이모지)는 Phase 3 대상이라 변화 없음

---

## ⚡ 9. Phase 31 (UI 정제 2단계 — 성능) 결과

### 원인 (프로파일, 2,000화 · CPU 4배)
| 구간 | 시간 | 내용 |
|---|---|---|
| 클릭 → 다음 화면 | 약 680ms | 처리 566ms + 화면 94ms |
| 그 566ms 안 | `detectToc` 약 190ms · 유사 후보 `rankTocCandidates` 전처리 약 200ms · 목차 렌더링·통계 약 150ms | 모두 클릭과 같은 작업에서 연속 실행 |
| 첫 화면 | 렌더 차단: parser.js 221KB · style.css 108KB · settings.js 76KB · epub-gen.js 57KB · core.js 47KB · jszip.min.js 96KB · cover-search.js 40KB + 구글 폰트 CSS | Lighthouse render-blocking |

### 전후 (같은 세션, Phase 30 코드와 나란히)
| 지표 | Phase 30 | Phase 31 | 목표 |
|---|---|---|---|
| INP 근사 CPU 4배 (5회 중앙값, 범위) | 568ms (520~568) | 152ms (128~168) | 200ms 미만 ✅ |
| INP 근사 CPU 1배 (5회 중앙값, 범위) | 176ms (168~208) | 104ms (80~136) | — |
| 클릭 뒤 최장 작업 (LoAF, CPU 4배) | 612ms | 227ms | — |
| Lighthouse 모바일 성능 (3회) | 63 · 63 · 68 | 96 · 95 · 96 | 80 이상 ✅ |
| 모바일 FCP (3회) | 6.0 · 6.0 · 5.1s | 2.25 · 2.25 · 2.26s | 3.0s 미만 ✅ |
| 모바일 TBT (3회) | 32 · 42 · 31ms | 53 · 111 · 52ms | — (증가, 아래 참고) |
| 데스크톱 성능 / FCP | 92 / 1.32s | 100 / 0.52s | — |
| 접근성 · 권장사항 · axe | 100 · 100 · 0 | 100 · 100 · 0 | 유지 ✅ |
| CLS (5회 최대) | 0 | 0.001 | < 0.1 ✅ |
| 회귀 테스트 | 498 | 510 | 전부 통과 ✅ |

- 남은 확인: **배포 사이트 Lighthouse** — 이 환경은 구글 폰트를 차단하므로 폰트 CSS 왕복이 빠져 있음 (재현 명령 §🔁 4번)
- TBT 증가는 스크립트 실행이 첫 화면 이후로 옮겨져 측정 구간에 포함된 것으로 추정 (실행 코드는 바꾸지 않음 — 원인 미검증)
- CLS 0.001: 결과 카드 숫자 카운트업(`.result-stat-card`) — Phase 30 코드에서도 같은 이동이 측정됨, 이번 변경과 무관
- 구글 폰트 CSS(렌더 차단 추정 780ms)는 변경하지 않음 — 효과를 이 환경에서 측정할 수 없어서
