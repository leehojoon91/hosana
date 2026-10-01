// 온실 공정표 · 구매 발주 자동 알림
//
// GitHub Actions(.github/workflows/purchase-alerts.yml)가 평일 아침에 실행합니다.
// Firestore의 모든 프로젝트를 읽어 공정표 화면과 같은 방식으로 PERT 일정을 계산하고,
// 발주 임박·발주 지연·입고 지연 항목을 담당자에게 보냅니다.
//   - Gmail: GMAIL_USER, GMAIL_APP_PASSWORD 가 있으면 발송
//   - 카카오 알림톡(솔라피): SOLAPI_API_KEY 등 5개 값이 모두 있으면 발송 (없으면 건너뜀)
// DRY_RUN=true 이면 아무것도 보내지 않고 보낼 내용만 로그로 출력합니다.
//
// 아래 일정 계산 함수들은 index.html 의 계산과 같아야 합니다. 한쪽을 고치면 다른 쪽도 함께 고치세요.

/* ---------------- dates ---------------- */
const D = s => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const S = dt => dt.toISOString().slice(0, 10);
const addDays = (dt, n) => new Date(dt.getTime() + n * 864e5);
const shiftDate = (s, n) => S(addDays(D(s), n));
const dayCount = (a, b) => Math.round((D(b) - D(a)) / 864e5);
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const WD = ["일", "월", "화", "수", "목", "금", "토"];
export const fmt = s => { if (!s) return "–"; const d = D(s); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`; };
export const ddayTxt = n => n == null ? "–" : n === 0 ? "D-day" : n > 0 ? `D-${n}` : `D+${-n}`;
export const todayKST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

/* ---------------- PERT schedule (forward pass: start dates) ---------------- */
function buildCal(p) {
  const off = new Set((p.offDays || []).map(o => o.date));
  const days = []; let d = D(p.startDate);
  for (let g = 0; days.length < 1500 && g < 4000; g++) {
    const w = d.getUTCDay(), s = S(d);
    if (w !== 0 && (w !== 6 || p.workSaturday) && !off.has(s)) days.push(s);
    d = addDays(d, 1);
  }
  return days;
}
function idxOf(cal, s) { let lo = 0, hi = cal.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (cal[mid] < s) lo = mid + 1; else hi = mid; } return lo; }
function pert(t) {
  const o = num(t.o), m = num(t.m), p = num(t.p);
  const te = (o + 4 * m + p) / 6;
  return { dur: te > 0 ? Math.max(1, Math.round(te)) : 0 };
}
const DEFAULT_PROJECT = { workSaturday: true, offDays: [], statusDate: "" };

/** Returns Map(taskId → { code, name, startDate }) computed exactly like the web page. */
export function scheduleStarts(project, tasks, statusDate) {
  const p = { ...DEFAULT_PROJECT, ...project };
  const out = new Map();
  if (!isDate(p.startDate)) return out;
  const cal = buildCal(p);
  const list = tasks.map(t => ({ ...t }));
  const ids = new Set(list.map(t => t.id)), by = new Map(list.map(t => [t.id, t]));
  const indeg = new Map(), succ = new Map();
  list.forEach(t => succ.set(t.id, []));
  list.forEach(t => { t._preds = [...new Set((t.preds || []).filter(id => ids.has(id) && id !== t.id))]; indeg.set(t.id, t._preds.length); });
  list.forEach(t => t._preds.forEach(pid => succ.get(pid).push(t.id)));
  const q = [...list].sort((a, b) => num(a.order) - num(b.order)).filter(t => indeg.get(t.id) === 0).map(t => t.id), order = [];
  while (q.length) { const id = q.shift(); order.push(id); for (const s of succ.get(id)) { indeg.set(s, indeg.get(s) - 1); if (indeg.get(s) === 0) q.push(s); } }
  const sIdx = statusDate > p.startDate ? idxOf(cal, statusDate) : 0;
  const dateAt = i => cal[Math.max(0, Math.min(cal.length - 1, i))];
  for (const id of order) {
    const t = by.get(id); const { dur } = pert(t);
    const prog = t.actualEnd ? 100 : Math.min(100, Math.max(0, num(t.progress)));
    const status = t.actualEnd ? "done" : (t.actualStart ? "prog" : "wait");
    let es = 0; for (const pid of t._preds) es = Math.max(es, by.get(pid).ef);
    if (isDate(t.notBefore)) es = Math.max(es, idxOf(cal, t.notBefore));
    if (isDate(t.actualStart)) es = idxOf(cal, t.actualStart);
    else if (es < sIdx) es = sIdx;
    let ef;
    if (isDate(t.actualEnd)) ef = Math.max(es + (dur ? 1 : 0), idxOf(cal, t.actualEnd) + 1);
    else if (status === "prog") ef = Math.max(es + dur, sIdx + Math.ceil(dur * (1 - prog / 100)));
    else ef = es + dur;
    t.es = es; t.ef = ef;
    out.set(id, { code: t.code, name: t.name, startDate: dateAt(es) });
  }
  return out;
}

/* ---------------- purchase status (same rules as the 구매 일정 tab) ---------------- */
export const BUY_LABEL = { late: "발주 지연", soon: "발주 임박", plan: "발주 예정", etaLate: "입고 늦음 예상", overdue: "입고 지연", ordered: "발주 완료", recv: "입고 완료", nolink: "공정 미연결" };
export const ALERT_STATES = new Set(["late", "soon", "overdue", "etaLate"]);

const toNum = v => { if (typeof v === "number") return v; const n = Number(String(v ?? "").replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const ORDER = { late: 0, overdue: 1, etaLate: 2, soon: 3, plan: 4, nolink: 5, ordered: 6, recv: 7 };
/* 분할 납품 (index.html 의 splitPurchase 와 같은 규칙) */
function splitPurchase(p, t, starts, statusDate, alertDays) {
  const lead = num(p.lead);
  const list = p.deliveries.map((d, i) => {
    const dt = d.mode === "task" ? starts.get(d.taskId) : null;
    const buf = d.buffer === "" || d.buffer == null ? num(p.buffer) : num(d.buffer);
    const needBy = d.mode === "task" ? (dt && dt.startDate ? shiftDate(dt.startDate, -buf) : "") : (isDate(d.date) ? d.date : "");
    const ordered = isDate(d.orderedDate) ? d.orderedDate : isDate(p.orderedDate) ? p.orderedDate : "";
    const orderBy = needBy ? shiftDate(needBy, -lead) : "";
    const eta = ordered && (i === 0 || isDate(d.orderedDate)) ? shiftDate(ordered, lead) : "";
    const due = needBy && eta ? (eta > needBy ? eta : needBy) : (needBy || eta);
    let st;
    if (isDate(d.receivedDate)) st = "recv";
    else if (ordered) st = due && statusDate > due ? "overdue" : (eta && needBy && eta > needBy) ? "etaLate" : "ordered";
    else if (!orderBy) st = "nolink";
    else if (statusDate > orderBy) st = "late";
    else if (dayCount(statusDate, orderBy) <= alertDays) st = "soon";
    else st = "plan";
    return { ...d, n: i + 1, task: dt || t, needBy, orderBy, ordered, eta, due, st };
  });
  const open = list.filter(x => x.st !== "recv");
  const worst = open.length ? open.reduce((a, b) => ORDER[b.st] < ORDER[a.st] ? b : a) : null;
  const next = open.slice().sort((a, b) => String(a.due || "9").localeCompare(String(b.due || "9")))[0] || null;
  const pending = list.filter(x => !x.ordered && x.orderBy).map(x => x.orderBy).sort()[0] || "";
  const first = list.map(x => x.orderBy).filter(Boolean).sort()[0] || "";
  const st = worst ? worst.st : "recv";
  const dleft = ["late", "soon", "plan"].includes(st) ? (pending ? dayCount(statusDate, pending) : null) : (next && next.due ? dayCount(statusDate, next.due) : null);
  return { ...p, task: (worst && worst.task) || t, needBy: worst ? worst.needBy : "", orderBy: pending || first, eta: worst ? worst.due : "", st, dleft,
    split: { list, worst, next, total: list.length, recv: list.length - open.length } };
}

export function computePurchases(data, statusDate) {
  const starts = scheduleStarts(data.project || {}, data.tasks || [], statusDate);
  return (data.purchases || []).map(p => {
    const t = p.taskId ? starts.get(p.taskId) : null;
    if (Array.isArray(p.deliveries) && p.deliveries.length) return splitPurchase(p, t, starts, statusDate, p.alertDays === "" || p.alertDays == null ? 7 : num(p.alertDays));
    const needBy = t && t.startDate ? shiftDate(t.startDate, -num(p.buffer)) : "";
    const orderBy = needBy ? shiftDate(needBy, -num(p.lead)) : "";
    const eta = isDate(p.orderedDate) ? shiftDate(p.orderedDate, num(p.lead)) : "";
    const alertDays = p.alertDays === "" || p.alertDays == null ? 7 : num(p.alertDays);
    let st;
    if (isDate(p.receivedDate)) st = "recv";
    else if (eta) st = statusDate > eta ? "overdue" : (needBy && eta > needBy) ? "etaLate" : "ordered";
    else if (!orderBy) st = "nolink";
    else if (statusDate > orderBy) st = "late";
    else if (dayCount(statusDate, orderBy) <= alertDays) st = "soon";
    else st = "plan";
    return { ...p, task: t, needBy, orderBy, eta, st, dleft: orderBy ? dayCount(statusDate, orderBy) : null };
  });
}

/** All alertable purchase items across every project. `docs` = [{ id, data }] */
export function collectAlerts(docs, today = todayKST()) {
  const items = [];
  for (const { id, data } of docs) {
    const project = data.project || {};
    const statusDate = isDate(project.statusDate) ? project.statusDate : today;
    for (const x of computePurchases(data, statusDate)) {
      if (ALERT_STATES.has(x.st)) items.push({ ...x, projectId: id, projectName: project.name || id, statusDate });
    }
  }
  const rank = { late: 0, overdue: 1, etaLate: 2, soon: 3 };
  return items.sort((a, b) => (rank[a.st] - rank[b.st]) || String(a.orderBy).localeCompare(String(b.orderBy)));
}

/* ---------------- e-mail ---------------- */
const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COLOR = { late: "#B3261E", overdue: "#B3261E", etaLate: "#B3261E", soon: "#8A5A00" };
const whenTxt = x => {
  const w = x.split && x.split.worst, part = w ? `${w.n}차 ${w.qty} ${x.unit || ""}`.trim() : "";
  if (x.st === "overdue") return w ? `${part} 납품 예정 ${fmt(w.due)} 지남` : `입고 예정 ${fmt(x.eta)} 지남`;
  if (x.st === "etaLate") return w ? `${part} 도착 ${fmt(w.eta)} > 필요일 ${fmt(w.needBy)}` : `입고 예정 ${fmt(x.eta)} > 필요일 ${fmt(x.needBy)}`;
  return `${fmt(x.orderBy)} (${ddayTxt(x.dleft)})` + (x.split ? ` · 분할 ${x.split.total}회 납품` : "");
};

export function buildEmail(items, { siteUrl, date, recipientLabel = "" }) {
  const late = items.filter(x => x.st === "late").length, soon = items.filter(x => x.st === "soon").length;
  const recv = items.filter(x => x.st === "overdue" || x.st === "etaLate").length;
  const parts = [late && `발주 지연 ${late}`, soon && `발주 임박 ${soon}`, recv && `입고 주의 ${recv}`].filter(Boolean);
  const subject = `[온실 공정표] 자재 발주 알림 ${fmt(date)} · ${parts.join(" · ")}`;
  const td = "padding:8px 10px;border-bottom:1px solid #D3DBD5;font-size:13px;vertical-align:top";
  const rows = items.map(x => `<tr>
    <td style="${td};color:${COLOR[x.st]};font-weight:700;white-space:nowrap">${escHtml(BUY_LABEL[x.st])}</td>
    <td style="${td}"><b>${escHtml(x.name)}</b>${x.spec ? `<br><span style="color:#7A8881">${escHtml(x.spec)}</span>` : ""}${x.qty ? `<br><span style="color:#48564F">${escHtml(x.qty)} ${escHtml(x.unit || "")}</span>` : ""}</td>
    <td style="${td};white-space:nowrap">${escHtml(whenTxt(x))}</td>
    <td style="${td}">${escHtml(x.projectName)}<br><span style="color:#7A8881">${x.task ? escHtml(`${x.task.code} ${x.task.name} · 시작 ${fmt(x.task.startDate)}`) : ""}</span></td>
    <td style="${td};white-space:nowrap">${escHtml(fmt(x.needBy))}</td>
    <td style="${td}">${escHtml(x.vendor || "")}${x.owner ? `<br><span style="color:#7A8881">${escHtml(x.owner)}</span>` : ""}</td></tr>`).join("");
  const th = "padding:8px 10px;border-bottom:2px solid #1D6A51;font-size:12px;color:#48564F;text-align:left;white-space:nowrap";
  const html = `<div style="font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#17201C;max-width:860px">
    <p style="font-size:15px;margin:0 0 4px"><b>자재 발주 확인이 필요합니다${recipientLabel ? ` · ${escHtml(recipientLabel)}` : ""}</b></p>
    <p style="font-size:13px;color:#48564F;margin:0 0 14px">${escHtml(fmt(date))} 기준 공정표로 계산한 결과입니다. 발주하셨다면 공정표 구매 일정 탭에서 발주일을 입력해 주세요.</p>
    <table style="border-collapse:collapse;width:100%"><thead><tr>
      <th style="${th}">상태</th><th style="${th}">자재</th><th style="${th}">발주 기한</th><th style="${th}">프로젝트 · 사용 공정</th><th style="${th}">현장 필요일</th><th style="${th}">업체 · 담당</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p style="margin:18px 0 0"><a href="${escHtml(siteUrl)}" style="background:#1D6A51;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-size:13px">공정표 열기</a></p>
    <p style="font-size:11px;color:#7A8881;margin-top:18px">이 메일은 온실 공정표가 평일 아침 자동으로 보냅니다. 발주 기한 = 사용 공정 시작일 − 현장 여유일 − 조달기간.</p></div>`;
  const text = items.map(x => `- [${BUY_LABEL[x.st]}] ${x.projectName} / ${x.name} / ${whenTxt(x)}`).join("\n") + `\n\n공정표: ${siteUrl}`;
  return { subject, html, text };
}

/** Group items by recipient. Items without an owner e-mail go to the admin; the admin can also get everything. */
export function planEmails(items, { adminEmail, adminDigest = true }) {
  const byTo = new Map();
  const add = (to, x) => { const k = to.toLowerCase(); if (!byTo.has(k)) byTo.set(k, []); if (!byTo.get(k).includes(x)) byTo.get(k).push(x); };
  for (const x of items) {
    const mail = String(x.ownerEmail || "").trim();
    if (mail) add(mail, x);
    if (adminEmail && (!mail || adminDigest)) add(adminEmail, x);
  }
  return byTo;
}

/* ---------------- 카카오 알림톡 (솔라피) — 설정이 모두 있을 때만 동작 ---------------- */
// 알림톡 템플릿(카카오 검수 필요)은 아래 문구로 등록하세요. #{…} 는 변수입니다.
//   [#{프로젝트}] 자재 발주 알림
//   자재: #{자재}
//   상태: #{상태}
//   발주 기한: #{발주기한} (#{남은날})
//   사용 공정: #{공정}
//   공정표에서 확인해 주세요: #{링크}
export function buildKakaoMessages(items, { pfId, templateId, from, siteUrl }) {
  const digits = s => String(s || "").replace(/\D/g, "");
  return items.filter(x => digits(x.ownerPhone).length >= 10).map(x => ({
    to: digits(x.ownerPhone), from: digits(from),
    kakaoOptions: { pfId, templateId, variables: {
      "#{프로젝트}": x.projectName, "#{자재}": x.name, "#{상태}": BUY_LABEL[x.st],
      "#{발주기한}": fmt(x.orderBy), "#{남은날}": ddayTxt(x.dleft),
      "#{공정}": x.task ? `${x.task.code} ${x.task.name}` : "-", "#{링크}": siteUrl } }
  }));
}
async function sendSolapi(messages, { apiKey, apiSecret }) {
  const crypto = await import("node:crypto");
  const date = new Date().toISOString(), salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  const res = await fetch("https://api.solapi.com/messages/v4/send-many/detail", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}` },
    body: JSON.stringify({ messages })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`솔라피 발송 실패 ${res.status}: ${body.slice(0, 300)}`);
  return body;
}

/* ---------------- main ---------------- */
async function main() {
  const env = process.env;
  const DRY = env.DRY_RUN === "true";
  const siteUrl = env.SITE_URL || "https://leehojoon91.github.io/hosana/";
  const adminEmail = (env.ALERT_ADMIN_EMAIL || env.GMAIL_USER || "").trim();
  const today = todayKST();
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT 시크릿이 없습니다. 설치안내의 자동 알림 단계를 확인해 주세요.");

  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
  const snap = await getFirestore().collection("schedules").get();
  const docs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
  const items = collectAlerts(docs, today);
  console.log(`${today} · 프로젝트 ${docs.length}개 · 알림 대상 ${items.length}건${DRY ? " · 시험 실행(발송 안 함)" : ""}`);
  items.forEach(x => console.log(`  [${BUY_LABEL[x.st]}] ${x.projectName} / ${x.name} / ${whenTxt(x)} → ${x.ownerEmail || adminEmail || "(받는 사람 없음)"}`));
  if (!items.length) return;

  // Gmail
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    const plan = planEmails(items, { adminEmail, adminDigest: env.ALERT_ADMIN_DIGEST !== "false" });
    const nodemailer = (await import("nodemailer")).default;
    const tx = nodemailer.createTransport({ service: "gmail", auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD } });
    for (const [to, list] of plan) {
      const mail = buildEmail(list, { siteUrl, date: today, recipientLabel: to === adminEmail.toLowerCase() ? "전체 요약" : "" });
      if (DRY) { console.log(`  (시험) 메일 → ${to}: ${mail.subject}`); continue; }
      await tx.sendMail({ from: `온실 공정표 <${env.GMAIL_USER}>`, to, subject: mail.subject, html: mail.html, text: mail.text });
      console.log(`  메일 보냄 → ${to} (${list.length}건)`);
    }
  } else console.log("  Gmail 설정(GMAIL_USER, GMAIL_APP_PASSWORD)이 없어 메일은 건너뜁니다.");

  // 카카오 알림톡 (선택)
  const k = { apiKey: env.SOLAPI_API_KEY, apiSecret: env.SOLAPI_API_SECRET, pfId: env.KAKAO_PFID, templateId: env.KAKAO_TEMPLATE_ID, from: env.KAKAO_SENDER };
  if (Object.values(k).every(Boolean)) {
    const messages = buildKakaoMessages(items, { ...k, siteUrl });
    if (!messages.length) console.log("  담당자 휴대폰 번호가 있는 항목이 없어 알림톡은 건너뜁니다.");
    else if (DRY) console.log(`  (시험) 알림톡 ${messages.length}건 → ${messages.map(m => m.to.slice(0, 3) + "****" + m.to.slice(-4)).join(", ")}`);
    else { await sendSolapi(messages, k); console.log(`  알림톡 보냄 ${messages.length}건`); }
  } else console.log("  카카오 알림톡 설정이 없어 건너뜁니다.");
}

if (typeof process !== "undefined" && process.argv && /purchase-alerts\.mjs$/.test(process.argv[1] || "")) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
