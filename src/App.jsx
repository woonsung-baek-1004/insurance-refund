import React, { useState, useMemo, useRef } from "react";
import {
  Building2,
  FileSearch,
  Calculator,
  ArrowRight,
  Upload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  X,
  Plus,
  Printer,
  Coins,
  ShieldAlert,
  ChevronRight,
  ChevronDown,
  Receipt,
} from "lucide-react";

/*
  건설업 고용·산재보험료 환급 / 경정청구 산출기 (Netlify 배포판)
  - 1차: 코데이타 PDF → 보수적 추정 / 2차: 세무조정·결산 → 정밀 산출
  - 공종별 노무비율 / 개별실적요율 / 승인 하수급 차감 반영
  - AI 추출은 /.netlify/functions/anthropic (서버 보관 키) 경유
  ⚠️ 실무 보조용 추정기. 요율·노무비율은 고시로, 환급 가부는 공단 확정정산·전문가 검토로 확정.
*/

const won = (n) =>
  n == null || isNaN(n) ? "—" : "₩" + Math.round(n).toLocaleString("ko-KR");
const wonShort = (n) =>
  n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("ko-KR") + "원";
const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? 0 : Number(v));
const CY = new Date().getFullYear();

const DEF_RATES = {
  sanjae: 3.5,
  commute: 0.06,
  eiUnemploy: 0.9,
  eiStability: 0.25,
  haircut: 70,
  prescription: 3,
};
const DEF_PRESETS = [
  { key: "원도급", label: "일반 건설공사(원도급)", ratio: 27, base: "총공사금액" },
  { key: "하도급", label: "하도급 공사", ratio: 30, base: "하도급공사금액" },
  { key: "정보통신", label: "정보통신공사", ratio: 27, base: "총공사금액" },
];

const emptyYear = (y) => ({
  id: Math.random().toString(36).slice(2),
  year: y,
  type: "원도급",
  grossAmount: "",
  approvedSub: "",
  ratioOverride: "",
  expAdj: "",
  actualWages: "",
  reportedPremium: "",
  raw: null,
});

function App() {
  const [stage, setStage] = useState(1);
  const [rates, setRates] = useState(DEF_RATES);
  const [presets, setPresets] = useState(DEF_PRESETS);
  const [company, setCompany] = useState({ name: "", bizno: "" });
  const [years, setYears] = useState([emptyYear(CY - 3), emptyYear(CY - 2), emptyYear(CY - 1)]);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const s1 = useRef(null);
  const s2 = useRef(null);

  const ratioOf = (y) => {
    if (y.ratioOverride !== "") return num(y.ratioOverride);
    const p = presets.find((p) => p.key === y.type);
    return p ? num(p.ratio) : 27;
  };

  const rows = useMemo(() => {
    return years.map((y) => {
      const effSanjae = num(rates.sanjae) * (1 + num(y.expAdj) / 100);
      const combined =
        (effSanjae + num(rates.commute) + num(rates.eiUnemploy) + num(rates.eiStability)) / 100;
      const netGross = Math.max(0, num(y.grossAmount) - num(y.approvedSub));
      const ratio = ratioOf(y);
      const estBase = netGross * (ratio / 100);
      const imposed =
        y.reportedPremium !== "" && !isNaN(Number(y.reportedPremium))
          ? num(y.reportedPremium)
          : estBase * combined;
      const justPremium = num(y.actualWages) * combined;
      const rawRefund = Math.max(0, imposed - justPremium);
      const conservative = rawRefund * (num(rates.haircut) / 100);
      const eligible = num(y.year) >= CY - num(rates.prescription);
      return { ...y, effSanjae, combined, netGross, ratio, estBase, imposed, justPremium, rawRefund, conservative, eligible };
    });
  }, [years, rates, presets]);

  const totals = useMemo(() => {
    const w = rows.filter((r) => r.eligible);
    return {
      precise: w.reduce((s, r) => s + r.rawRefund, 0),
      conservative: w.reduce((s, r) => s + r.conservative, 0),
    };
  }, [rows]);

  const setY = (id, f, v) => setYears((ys) => ys.map((y) => (y.id === id ? { ...y, [f]: v } : y)));
  const addY = () => setYears((ys) => [...ys, emptyYear((num(ys[ys.length - 1]?.year) || CY) - 1)]);
  const rmY = (id) => setYears((ys) => ys.filter((y) => y.id !== id));
  const setPreset = (i, f, v) => setPresets((ps) => ps.map((p, j) => (j === i ? { ...p, [f]: v } : p)));

  async function fileToB64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = () => rej(new Error("read"));
      r.readAsDataURL(file);
    });
  }

  async function extract(file, kind) {
    setErrorMsg("");
    setBusy(true);
    setStatusMsg(kind === "s1" ? "코데이타 자료 분석 중…" : "세무·결산 자료 정밀 분석 중…");
    try {
      const b64 = await fileToB64(file);
      const isPdf = file.type === "application/pdf";
      const instruction =
        kind === "s1"
          ? `한국 건설회사의 기업정보(코데이타류) 또는 재무요약 PDF입니다.
연도별로 KRW 정수 추출(모르면 null):
- grossAmount: 총공사금액 또는 매출액(공사수익)
- subcontract: 외주공사비/하도급금액(있으면)
- laborInCost: 매출원가 내 노무비(직접노무비)
- salaries: 판관비 급여/임금
- outsourcedFee: 외주비/지급수수료(노무성)
- reportedPremium: 보험료 납부액
또한 회사명/사업자번호도.`
          : `세무조정계산서/재무제표/원가명세서/결산자료입니다.
연도별로 KRW 정수 정밀 추출(모르면 null):
- grossAmount: 총공사금액(공사수익/매출)
- subcontract: 승인 하수급/외주공사 금액
- laborInCost: 직접노무비(공사원가명세서)
- salaries: 급여·임금(판관비)
- outsourcedFee: 외주공사 중 노무비 추정분
- reportedPremium: 고용·산재 보험료 납부액`;
      const sys = `당신은 한국 건설업 고용·산재보험 환급 실무 보조 AI입니다. 아래 JSON만 출력(설명·코드펜스 금지):
{"company":{"name":string|null,"bizno":string|null},"years":[{"year":number,"grossAmount":number|null,"subcontract":number|null,"laborInCost":number|null,"salaries":number|null,"outsourcedFee":number|null,"reportedPremium":number|null}],"notes":string}`;
      const content = [];
      content.push(
        isPdf
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
          : { type: "image", source: { type: "base64", media_type: file.type || "image/png", data: b64 } }
      );
      content.push({ type: "text", text: instruction });

      const resp = await fetch("/.netlify/functions/anthropic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system: sys, max_tokens: 1024, messages: [{ role: "user", content }] }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
      const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .replace(/```json|```/g, "")
        .trim();
      const parsed = JSON.parse(text);
      if (parsed.company)
        setCompany((c) => ({ name: parsed.company.name || c.name, bizno: parsed.company.bizno || c.bizno }));
      if (Array.isArray(parsed.years) && parsed.years.length) {
        setYears((prev) => {
          const map = new Map(prev.map((y) => [num(y.year), y]));
          parsed.years.forEach((py) => {
            const yr = num(py.year);
            if (!yr) return;
            const ex = map.get(yr) || emptyYear(yr);
            const wageSum = (py.laborInCost || 0) + (py.salaries || 0) + (py.outsourcedFee || 0);
            map.set(yr, {
              ...ex,
              year: yr,
              grossAmount: py.grossAmount != null ? py.grossAmount : ex.grossAmount,
              approvedSub: py.subcontract != null ? py.subcontract : ex.approvedSub,
              actualWages: wageSum > 0 ? wageSum : ex.actualWages,
              reportedPremium: py.reportedPremium != null ? py.reportedPremium : ex.reportedPremium,
              raw: {
                grossAmount: py.grossAmount,
                subcontract: py.subcontract,
                laborInCost: py.laborInCost,
                salaries: py.salaries,
                outsourcedFee: py.outsourcedFee,
                reportedPremium: py.reportedPremium,
              },
            });
          });
          return [...map.values()].sort((a, b) => num(b.year) - num(a.year));
        });
      }
      setStatusMsg(`추출 완료${parsed.notes ? " · " + parsed.notes : ""}. 값을 검토·보정하세요.`);
      setShowRaw(true);
    } catch (e) {
      setErrorMsg("자동 추출 실패: " + (e.message || "대용량·복잡 양식일 수 있음") + " — 아래 표에 직접 입력하세요.");
      setStatusMsg("");
    } finally {
      setBusy(false);
    }
  }
  const onPick = (e, kind) => {
    const f = e.target.files?.[0];
    if (f) extract(f, kind);
    e.target.value = "";
  };

  return (
    <div className="app">
      <style>{CSS}</style>
      <header className="hd">
        <div className="hd-mark"><Building2 size={14} strokeWidth={2.2} /> 건설 · 보험료 환급</div>
        <h1>고용·산재보험료 <span className="ser">환급 / 경정청구</span> 산출기</h1>
        <p className="sub">
          코데이타로 보수적 1차 추정 → 세무조정·결산으로 정밀 산출. 공종별 노무비율·개별실적요율·
          승인 하수급 차감을 반영해 추정 부과액과 실보수 기준 정당 보험료의 차액을 환급액으로 계산합니다.
        </p>
      </header>

      <div className="stages">
        <button className={"stage-tab" + (stage === 1 ? " on" : "")} onClick={() => setStage(1)}>
          <span className="ic"><FileSearch size={20} strokeWidth={1.8} /></span>
          <span><b>1차 · 보수적 추정</b><em>코데이타 PDF</em></span>
        </button>
        <ArrowRight className="stage-arrow" size={20} />
        <button className={"stage-tab" + (stage === 2 ? " on" : "")} onClick={() => setStage(2)}>
          <span className="ic"><Calculator size={20} strokeWidth={1.8} /></span>
          <span><b>2차 · 정밀 산출</b><em>세무조정·결산</em></span>
        </button>
      </div>

      <div className="grid">
        <section className="panel">
          {stage === 1 ? (
            <>
              <h2 className="ph"><FileSearch size={18} /> 코데이타 기업자료 업로드</h2>
              <p className="phelp">기업정보·재무요약 PDF에서 매출/총공사금액·외주비·노무비 계정을 추출해 <b>보수적 하한 환급</b>을 만듭니다.</p>
              <input ref={s1} type="file" accept="application/pdf,image/*" style={{ display: "none" }} onChange={(e) => onPick(e, "s1")} />
              <button className="drop" disabled={busy} onClick={() => s1.current?.click()}><Upload size={20} /> 코데이타 PDF 선택</button>
            </>
          ) : (
            <>
              <h2 className="ph"><Receipt size={18} /> 세무조정계산서 · 결산자료 업로드</h2>
              <p className="phelp">세무조정계산서·원가명세서·재무제표에서 직접노무비·급여·외주노무비를 정밀 추출해 <b>실보수총액</b>을 다시 계산합니다.</p>
              <input ref={s2} type="file" accept="application/pdf,image/*" style={{ display: "none" }} onChange={(e) => onPick(e, "s2")} />
              <button className="drop" disabled={busy} onClick={() => s2.current?.click()}><Upload size={20} /> 세무·결산 자료 선택</button>
            </>
          )}
          {busy && <div className="note busy"><Loader2 size={15} className="spin" /> {statusMsg}</div>}
          {!busy && statusMsg && <div className="note ok"><CheckCircle2 size={15} /> {statusMsg}</div>}
          {errorMsg && <div className="note err"><AlertTriangle size={15} /> {errorMsg}</div>}

          <div className="company">
            <label>회사명<input value={company.name} placeholder="(주)○○건설" onChange={(e) => setCompany({ ...company, name: e.target.value })} /></label>
            <label>사업자등록번호<input value={company.bizno} placeholder="000-00-00000" onChange={(e) => setCompany({ ...company, bizno: e.target.value })} /></label>
          </div>

          {rows.some((r) => r.raw) && (
            <div className="raw">
              <div className="raw-hd" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 추출 원자료 (계정 매핑)
              </div>
              {showRaw && (
                <div className="tbl-wrap">
                  <table className="tbl mini">
                    <thead><tr><th>연도</th><th>총공사</th><th>외주</th><th>직접노무</th><th>급여</th><th>외주노무</th></tr></thead>
                    <tbody>
                      {rows.filter((r) => r.raw).map((r) => (
                        <tr key={r.id}>
                          <td>{r.year}</td><td>{wonShort(r.raw.grossAmount)}</td><td>{wonShort(r.raw.subcontract)}</td>
                          <td>{wonShort(r.raw.laborInCost)}</td><td>{wonShort(r.raw.salaries)}</td><td>{wonShort(r.raw.outsourcedFee)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <h3 className="ph3">연도별 입력 · 검증</h3>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>연도</th><th>공종</th><th>총공사금액</th><th>승인하수급</th><th>실보수총액</th><th>개별실적%</th><th></th></tr></thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.id}>
                    <td><input className="ci yr" value={y.year} onChange={(e) => setY(y.id, "year", e.target.value)} /></td>
                    <td>
                      <select className="ci sel" value={y.type} onChange={(e) => setY(y.id, "type", e.target.value)}>
                        {presets.map((p) => <option key={p.key} value={p.key}>{p.key} {p.ratio}%</option>)}
                      </select>
                    </td>
                    <td><input className="ci" inputMode="numeric" value={y.grossAmount} placeholder="0" onChange={(e) => setY(y.id, "grossAmount", e.target.value.replace(/[^\d.]/g, ""))} /></td>
                    <td><input className="ci" inputMode="numeric" value={y.approvedSub} placeholder="0" onChange={(e) => setY(y.id, "approvedSub", e.target.value.replace(/[^\d.]/g, ""))} /></td>
                    <td><input className="ci" inputMode="numeric" value={y.actualWages} placeholder="0" onChange={(e) => setY(y.id, "actualWages", e.target.value.replace(/[^\d.]/g, ""))} /></td>
                    <td><input className="ci sm" inputMode="decimal" value={y.expAdj} placeholder="0" onChange={(e) => setY(y.id, "expAdj", e.target.value.replace(/[^\d.\-]/g, ""))} /></td>
                    <td><button className="x" onClick={() => rmY(y.id)} aria-label="삭제"><X size={16} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="add" onClick={addY}><Plus size={14} /> 연도 추가</button>

          <h3 className="ph3">노무비율 공종표 <span className="verify">(2025 고시 · 동결 27/30 · 검증 필요)</span></h3>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>공종</th><th>노무비율 %</th><th>적용기준</th></tr></thead>
              <tbody>
                {presets.map((p, i) => (
                  <tr key={p.key}>
                    <td style={{ textAlign: "left" }}>{p.label}</td>
                    <td><input className="ci sm" value={p.ratio} onChange={(e) => setPreset(i, "ratio", e.target.value.replace(/[^\d.]/g, ""))} /></td>
                    <td style={{ textAlign: "left", color: "#8a8475", fontSize: 12 }}>{p.base}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="ph3">요율 <span className="verify">(2025 기준 · 검증 필요)</span></h3>
          <div className="rates">
            {[["sanjae", "산재 기본 %"], ["commute", "출퇴근재해 %"], ["eiUnemploy", "고용(실업) %"], ["eiStability", "고용안정·직능 %"], ["haircut", "1차 보수계수 %"], ["prescription", "경정시효(년)"]].map(([k, l]) => (
              <label key={k}>{l}<input className="ci" inputMode="decimal" value={rates[k]} onChange={(e) => setRates({ ...rates, [k]: e.target.value.replace(/[^\d.]/g, "") })} /></label>
            ))}
          </div>
        </section>

        <section className="panel result">
          <div className="result-top">
            <div className="result-label"><Coins size={13} /> {stage === 1 ? "1차 · 보수적 환급 추정(하한)" : "2차 · 정밀 환급 산출"}</div>
            <div className="result-big">{won(stage === 1 ? totals.conservative : totals.precise)}</div>
            <div className="result-sub">경정청구 시효 {rates.prescription}년 이내 합계 · 정밀 {won(totals.precise)} / 보수적 {won(totals.conservative)}</div>
          </div>
          <div className="tbl-wrap">
            <table className="tbl res-tbl">
              <thead><tr><th>연도</th><th>적용요율</th><th>추정보수</th><th>부과(추정)</th><th>정당</th><th>환급(정밀)</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.eligible ? "" : "expired"}>
                    <td>{r.year}{!r.eligible && <span className="tag">시효</span>}</td>
                    <td>{(r.combined * 100).toFixed(2)}%</td>
                    <td>{wonShort(r.estBase)}</td>
                    <td>{wonShort(r.imposed)}</td>
                    <td>{wonShort(r.justPremium)}</td>
                    <td className="hi">{wonShort(r.rawRefund)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="formula">
            <h4>계산 근거</h4>
            <p>순공사금액 = 총공사금액 − 승인 하수급</p>
            <p>추정 보수총액 = 순공사금액 × 노무비율(공종별)</p>
            <p>적용 산재율 = 산재 기본 × (1 + 개별실적요율 증감율)</p>
            <p>부과(추정) = 추정보수 × 합산요율 · 신고보험료 입력 시 그 값</p>
            <p>환급 = 부과 − (실보수 × 합산요율), 1차는 보수계수 {rates.haircut}%</p>
          </div>
          <div className="actions">
            {stage === 1
              ? <button className="next" onClick={() => setStage(2)}>2차 정밀 산출로 <ArrowRight size={17} /></button>
              : <button className="next" onClick={() => setShowReport(true)}><Printer size={16} /> 요약 리포트 보기</button>}
          </div>
        </section>
      </div>

      <footer className="ft">
        <span className="ft-ic"><ShieldAlert size={16} /></span>
        <span><strong>안내</strong> 실무 보조용 추정 계산기입니다. 노무비율·요율·개별실적요율은 고용노동부 고시 및
        근로복지공단 통지로, 보수총액·승인 하수급·환급 가부는 공단 확정정산 및 노무사/세무사 검토로 반드시
        확인하세요. 본 도구는 법률·세무 자문이 아니며 결과는 참고 정보입니다. 업로드 자료는 PDF 추출을 위해 처리됩니다.</span>
      </footer>

      {showReport && <ReportModal company={company} rows={rows} totals={totals} rates={rates} onClose={() => setShowReport(false)} />}
    </div>
  );
}

function ReportModal({ company, rows, totals, rates, onClose }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <h3>환급 산출 요약 리포트</h3>
          <div>
            <button onClick={() => window.print()}><Printer size={14} /> 인쇄/PDF</button>
            <button onClick={onClose}><X size={14} /> 닫기</button>
          </div>
        </div>
        <div className="report">
          <p className="r-co"><b>{company.name || "(회사명)"}</b> · 사업자 {company.bizno || "—"}</p>
          <table className="tbl">
            <thead><tr><th>연도</th><th>공종</th><th>순공사</th><th>실보수</th><th>부과(추정)</th><th>정당</th><th>환급</th><th>경정</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.year}</td><td>{r.type}</td><td>{wonShort(r.netGross)}</td><td>{wonShort(num(r.actualWages))}</td>
                  <td>{wonShort(r.imposed)}</td><td>{wonShort(r.justPremium)}</td><td>{wonShort(r.rawRefund)}</td>
                  <td>{r.eligible ? "가능" : "시효경과"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="r-sum">경정청구 가능(시효 {rates.prescription}년) — 정밀 <b>{won(totals.precise)}</b> / 보수적 <b>{won(totals.conservative)}</b></p>
          <p className="r-note">추정치이며 공단 확정정산·전문가 검토로 확정해야 합니다.</p>
        </div>
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,800&family=IBM+Plex+Sans+KR:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap');
*{box-sizing:border-box}
html,body,#root{margin:0;min-height:100%}
.app{--ink:#1c1a17;--paper:#f6f2e9;--paper2:#efe9db;--line:#d8cfba;--teal:#0f5d52;--teal2:#0b463e;--amber:#b8742a;--red:#a23b2c;
  font-family:'IBM Plex Sans KR',sans-serif;color:var(--ink);
  background:radial-gradient(120% 80% at 100% 0%,#fbf8f0 0%,var(--paper) 45%,var(--paper2) 100%);
  min-height:100vh;padding:28px clamp(14px,4vw,46px);line-height:1.5}
.ser{font-family:'Fraunces',serif;font-style:italic;font-weight:600}
.hd{max-width:1180px;margin:0 auto 22px}
.hd-mark{display:inline-flex;align-items:center;gap:6px;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--teal);border:1px solid var(--teal);padding:4px 10px;border-radius:2px;margin-bottom:14px}
.hd h1{font-family:'Fraunces',serif;font-weight:800;font-size:clamp(28px,4.6vw,46px);line-height:1.05;margin:0 0 10px;letter-spacing:-.01em}
.sub{max-width:780px;color:#5c574d;font-size:14.5px;margin:0}
.stages{max-width:1180px;margin:0 auto 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.stage-tab{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--line);border-radius:4px;padding:12px 18px;cursor:pointer;font-family:inherit;text-align:left;transition:.18s;color:var(--ink)}
.stage-tab .ic{width:38px;height:38px;display:grid;place-items:center;border-radius:50%;background:var(--paper2);color:#8a8475}
.stage-tab b{display:block;font-size:14px}
.stage-tab em{font-style:normal;font-size:11.5px;color:#8a8475;font-family:'IBM Plex Mono',monospace}
.stage-tab.on{background:var(--ink);color:#f6f2e9;border-color:var(--ink)}
.stage-tab.on .ic{background:var(--teal);color:#fff}.stage-tab.on em{color:#cfc9b8}
.stage-arrow{color:#b3aa93}
.grid{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:1.1fr .9fr;gap:20px}
@media(max-width:880px){.grid{grid-template-columns:1fr}}
.panel{background:#fffdf7;border:1px solid var(--line);border-radius:6px;padding:22px;box-shadow:0 1px 0 #fff inset,0 10px 30px -22px rgba(40,30,10,.5)}
.ph{display:flex;align-items:center;gap:8px;font-family:'Fraunces',serif;font-size:19px;font-weight:700;margin:0 0 6px}
.phelp{font-size:13px;color:#6a6457;margin:0 0 14px}.phelp b{color:var(--teal)}
.drop{width:100%;border:1.5px dashed var(--teal);background:#f3f8f5;color:var(--teal2);border-radius:5px;padding:18px;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;transition:.15s}
.drop:hover{background:#e9f2ee}.drop:disabled{opacity:.5;cursor:wait}
.note{display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 12px;border-radius:4px;font-size:13px}
.note.busy{background:#fdf6e7;border:1px solid #e7d6a8}
.note.ok{background:#eef6f1;border:1px solid #bfe0cf;color:var(--teal2)}
.note.err{background:#fbeeea;border:1px solid #e6bcb0;color:var(--red)}
.spin{animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
.company{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}
.company label,.rates label{display:flex;flex-direction:column;font-size:11.5px;color:#7a7466;gap:5px;font-family:'IBM Plex Mono',monospace}
.company input,.rates input{font-family:'IBM Plex Sans KR';font-size:14px;padding:9px 10px;border:1px solid var(--line);border-radius:4px;background:#fff;color:var(--ink)}
.raw{margin:14px 0;border:1px solid var(--line);border-radius:5px;background:var(--paper)}
.raw-hd{display:flex;align-items:center;gap:6px;padding:9px 12px;font-size:12px;font-family:'IBM Plex Mono',monospace;color:var(--teal2);cursor:pointer}
.ph3{font-size:13px;font-family:'IBM Plex Mono',monospace;letter-spacing:.05em;text-transform:uppercase;color:#8a8475;margin:20px 0 10px;border-top:1px solid var(--line);padding-top:14px}
.verify{color:var(--amber);text-transform:none;letter-spacing:0;font-size:11px}
.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl.mini{font-size:11.5px}
.tbl th{text-align:right;font-weight:500;color:#8a8475;font-size:11px;padding:8px 6px;border-bottom:1px solid var(--line);font-family:'IBM Plex Mono',monospace;white-space:nowrap}
.tbl th:first-child{text-align:left}
.tbl td{padding:6px 6px;border-bottom:1px solid #ece5d4;text-align:right;white-space:nowrap}
.tbl td:first-child{text-align:left}
.ci{width:100%;min-width:92px;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:13px;padding:7px 8px;border:1px solid var(--line);border-radius:4px;background:#fff;color:var(--ink)}
.ci.yr{min-width:58px;width:62px}.ci.sm{min-width:54px;width:62px}
.ci.sel{min-width:104px;text-align:left;font-family:'IBM Plex Sans KR'}
.x{display:grid;place-items:center;border:none;background:none;color:#bbae93;cursor:pointer}.x:hover{color:var(--red)}
.add{display:inline-flex;align-items:center;gap:5px;margin-top:10px;background:none;border:1px dashed var(--line);color:#7a7466;border-radius:4px;padding:8px 14px;font-family:inherit;font-size:13px;cursor:pointer}
.add:hover{border-color:var(--teal);color:var(--teal)}
.rates{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:520px){.rates{grid-template-columns:repeat(2,1fr)}.company{grid-template-columns:1fr}}
.result{background:var(--ink);color:#efe9db;border-color:var(--ink)}
.result .ph,.result .ph3,.result h4{color:#efe9db}
.result-top{border-bottom:1px solid #3a352c;padding-bottom:18px;margin-bottom:16px}
.result-label{display:flex;align-items:center;gap:6px;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#c2b89f}
.result-big{font-family:'Fraunces',serif;font-weight:800;font-size:clamp(32px,5.2vw,50px);color:#fff;line-height:1.05;margin:8px 0 6px}
.result-sub{font-size:12.5px;color:#a9a08a}
.res-tbl th{color:#a9a08a;border-bottom-color:#3a352c}
.res-tbl td{border-bottom-color:#2b271f;color:#e3dccb}
.res-tbl td.hi{color:#7fd6b8;font-weight:600;font-family:'IBM Plex Mono',monospace}
.res-tbl tr.expired{opacity:.42}
.tag{font-size:9px;background:#4a2018;color:#e9a48f;padding:2px 5px;border-radius:3px;margin-left:5px;font-family:'IBM Plex Mono',monospace}
.formula{margin-top:18px;background:#26221b;border-radius:5px;padding:14px 16px}
.formula h4{margin:0 0 8px;font-size:11px;font-family:'IBM Plex Mono',monospace;letter-spacing:.15em;text-transform:uppercase;color:#c2b89f}
.formula p{margin:0 0 6px;font-size:12.5px;color:#cfc6b2;font-family:'IBM Plex Mono',monospace}
.actions{margin-top:18px}
.next{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:var(--teal);color:#fff;border:none;border-radius:5px;padding:14px;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:.15s}
.next:hover{background:#0c4f46}
.ft{display:flex;gap:10px;max-width:1180px;margin:24px auto 0;font-size:12px;color:#7a7466;background:var(--paper);border:1px solid var(--line);border-radius:5px;padding:14px 16px;line-height:1.6}
.ft-ic{color:var(--amber);flex:0 0 auto;margin-top:1px}
.ft strong{color:var(--amber)}
.modal-bg{position:fixed;inset:0;background:rgba(20,16,8,.5);display:grid;place-items:center;padding:20px;z-index:50}
.modal{background:#fffdf7;border-radius:8px;max-width:820px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)}
.modal-hd{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:#fffdf7}
.modal-hd h3{font-family:'Fraunces',serif;margin:0;font-size:20px}
.modal-hd button{display:inline-flex;align-items:center;gap:5px;margin-left:8px;border:1px solid var(--line);background:#fff;border-radius:4px;padding:7px 12px;cursor:pointer;font-family:inherit;font-size:13px}
.report{padding:20px}.r-co{font-size:15px;margin:0 0 14px}
.r-sum{margin-top:14px;font-size:14px}.r-sum b{font-family:'Fraunces',serif;color:var(--teal2)}
.r-note{font-size:12px;color:#7a7466;margin-top:8px}
@media print{.app>*:not(.modal-bg){display:none}.modal-bg{position:static;background:none}.modal{box-shadow:none;max-height:none}.modal-hd button{display:none}}
`;

export default App;
