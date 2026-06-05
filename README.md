# 건설업 고용·산재보험료 환급 / 경정청구 산출기

코데이타 자료로 **보수적 1차 추정** → 세무조정계산서·결산자료로 **정밀 산출**하는
2단계 웹앱입니다. PDF/이미지 업로드 시 Claude API로 계정을 자동 추출하고,
공종별 노무비율·개별실적요율·승인 하수급 차감을 반영해 환급 가능액을 계산합니다.

> ⚠️ 실무 보조용 **추정 계산기**입니다. 노무비율·요율·개별실적요율은 고용노동부 고시 및
> 근로복지공단 통지로, 환급 가부는 공단 확정정산·노무사/세무사 검토로 반드시 확인하세요.

---

## 구조

```
.
├─ index.html
├─ vite.config.js
├─ netlify.toml
├─ package.json
├─ public/
│  └─ favicon.svg
├─ src/
│  ├─ main.jsx
│  └─ App.jsx              # 앱 본체 (lucide 아이콘)
└─ netlify/functions/
   └─ anthropic.js         # API 키를 서버에 보관하는 프록시 함수
```

API 키는 **브라우저에 노출되지 않습니다.** 프런트엔드는 `/.netlify/functions/anthropic`
를 호출하고, 그 함수가 서버에 저장된 `ANTHROPIC_API_KEY`로 Anthropic API에 중계합니다.

---

## Netlify 배포

### 방법 A — Git 연동 (권장)
1. 이 폴더를 GitHub 저장소에 올립니다.
2. Netlify → **Add new site → Import an existing project** → 저장소 선택.
3. 빌드 설정은 `netlify.toml`이 자동 적용합니다 (build: `npm run build`, publish: `dist`).
4. **Site settings → Environment variables** 에 키 추가:
   - `ANTHROPIC_API_KEY` = `sk-ant-...` (필수)
   - `CLAUDE_MODEL` = `claude-sonnet-4-6` (선택, 기본값 동일)
5. Deploy. 끝.

### 방법 B — Netlify CLI
```bash
npm install -g netlify-cli
netlify login
netlify init          # 또는 netlify link
netlify env:set ANTHROPIC_API_KEY sk-ant-xxxx
netlify deploy --build --prod
```

### 로컬 개발
```bash
npm install
netlify dev           # 프런트 + 함수 동시 실행 (함수 호출 테스트 가능)
# 또는 함수 없이 UI만: npm run dev
```
`netlify dev`로 함수까지 테스트하려면 로컬에도 키가 필요합니다:
`netlify env:set ANTHROPIC_API_KEY sk-ant-xxxx` 또는 `.env`에 `ANTHROPIC_API_KEY=...`.

---

## 알아둘 점
- **요청 용량**: Netlify 함수 요청 본문은 약 6MB 제한입니다. 대용량 PDF는 추출이 실패할 수 있으니,
  실패 시 화면 표의 직접 입력으로 진행하세요(수동 입력만으로도 모든 계산이 동작합니다).
- **함수 타임아웃**: 기본 10초입니다. 페이지가 많은 PDF는 시간이 걸릴 수 있습니다.
- **요율/노무비율**: 화면에서 직접 검증·수정하도록 설계했습니다. 적용 연도 고시값을 확인하세요.
- **개별실적요율**: 공단 통지 증감율(%)을 연도 행의 `개별실적%`에 입력하면 산재율에 반영됩니다.
