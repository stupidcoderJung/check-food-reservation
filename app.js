// GS Fresh 예약관리 — POC v3 (Google Apps Script 연동)
// 원본 시트는 사장님 워크플로 그대로, 수령 체크는 _AppStatus_YYYY-MM-DD 탭에 기록

const API_URL = "https://script.google.com/macros/s/AKfycbweQ9uT2nk6NpZrExvyHV8z0CmSOPBP08rLjMu4EKc5Ob6qAw_IwpspHEqC6Q0neXF9/exec";
const TODAY_STR = new Date().toISOString().slice(0, 10);
const OPERATOR = "점주";

// ---------- 전역 상태 ----------
let ROWS = [];
let HEADERS = [];
let SNAPSHOTS = [];
let ACTIVE_DATE = null;
let PERIOD_TEXT = "";
let _loaded = false;

// ---------- 공통 유틸 ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

function daysBetween(a, b) {
  const d1 = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const d2 = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((d2 - d1) / 86400000);
}

function pad4(v) {
  return String(v ?? "").replace(/\D/g, "").padStart(4, "0").slice(-4);
}

function money(n) {
  return Number(n || 0).toLocaleString("ko-KR");
}

// 뒷자리 문자열을 해시해서 일관된 파스텔 배경색 생성
function phoneColor(phone) {
  const s = String(phone || "0000");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 65%, 88%)`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function statusOf(r) {
  return r["예약상태"] || (r["수령여부"] === "Y" ? "수령완료" : "예약중");
}

// ---------- 수령기간에서 마감일 추정 ----------
// 예: "4/20~21 월화 수령" → 올해 기준으로 두 번째 날짜(21)를 마감으로 해석
function parsePeriodDueDate(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})\/(\d{1,2})(?:~(\d{1,2}))?/);
  if (!m) return null;
  const mm = Number(m[1]);
  const d1 = Number(m[2]);
  const d2 = m[3] ? Number(m[3]) : d1;
  const year = new Date().getFullYear();
  return new Date(year, mm - 1, d2);
}

// ---------- 토스트 ----------
let _undoTimer = null;
let _undoAction = null;
function toast(msg, { undo } = {}) {
  const t = $("#toast");
  $("#toastMsg").textContent = msg;
  const btn = $("#toastUndo");
  clearTimeout(_undoTimer);
  if (undo) {
    btn.hidden = false;
    _undoAction = undo;
    _undoTimer = setTimeout(() => { t.classList.remove("show"); _undoAction = null; }, 4000);
  } else {
    btn.hidden = true;
    _undoAction = null;
    _undoTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }
  t.classList.add("show");
}
function hideToast() {
  $("#toast").classList.remove("show");
  _undoAction = null;
  clearTimeout(_undoTimer);
}

// ---------- 모달 ----------
function confirmModal({ title, body, confirmText = "확인", danger = false, input }) {
  return new Promise(resolve => {
    $("#modalTitle").textContent = title;
    $("#modalBody").textContent = body;
    const c = $("#modalConfirm");
    c.textContent = confirmText;
    c.className = "btn " + (danger ? "btn-success" : "btn-primary");
    const inputWrap = $("#modalInputWrap");
    const inputEl = $("#modalInput");
    if (input) {
      inputWrap.hidden = false;
      inputEl.value = input.default ?? "";
      inputEl.placeholder = input.placeholder ?? "";
      $("#modalHint").textContent = input.hint ?? "";
      setTimeout(() => inputEl.focus(), 50);
    } else {
      inputWrap.hidden = true;
      inputEl.value = "";
    }
    const m = $("#modal");
    m.hidden = false;
    const close = v => {
      m.hidden = true;
      c.removeEventListener("click", onOk);
      $("#modalCancel").removeEventListener("click", onNo);
      inputEl.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onOk = () => close(input ? { confirmed: true, value: inputEl.value.trim() } : true);
    const onNo = () => close(input ? { confirmed: false } : false);
    const onKey = e => {
      if (e.key === "Enter") { e.preventDefault(); onOk(); }
      else if (e.key === "Escape") { onNo(); }
    };
    c.addEventListener("click", onOk);
    $("#modalCancel").addEventListener("click", onNo);
    if (input) inputEl.addEventListener("keydown", onKey);
  });
}

// ---------- API 호출 ----------
async function api(path, opts = {}) {
  const url = API_URL + path;
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.ok === false) throw new Error(data.error || "API error");
  return data;
}

async function apiGet(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return api("?" + qs);
}

async function apiPost(body) {
  // Apps Script는 표준 CORS가 아니라 text/plain으로 보내야 preflight 안 뜸
  return api("", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
}

// ---------- 로딩 오버레이 ----------
function setBusy(yes, text = "불러오는 중…") {
  let el = $("#busy");
  if (yes) {
    if (!el) {
      el = document.createElement("div");
      el.id = "busy";
      el.className = "busy";
      el.innerHTML = `<div class="busy-card"><div class="spinner"></div><span id="busyText"></span></div>`;
      document.body.appendChild(el);
    }
    $("#busyText", el).textContent = text;
    el.classList.add("show");
  } else if (el) {
    el.classList.remove("show");
  }
}

// ---------- 데이터 로드 ----------
async function loadSnapshots() {
  const r = await apiGet({ action: "snapshots" });
  SNAPSHOTS = r.snapshots || [];
  ACTIVE_DATE = r.active || (SNAPSHOTS.length ? SNAPSHOTS[SNAPSHOTS.length - 1] : null);
  refreshSnapshotPicker();
}

async function loadActive(date) {
  setBusy(true, "데이터 불러오는 중…");
  try {
    if (date === "__ALL__") {
      const r = await apiGet({ action: "globalList" });
      HEADERS = r.headers || [];
      ROWS = (r.rows || []).map(normalize);
      ACTIVE_DATE = "__ALL__";
      PERIOD_TEXT = "";
    } else {
      const r = await apiGet({ action: "list", ...(date ? { date } : {}) });
      HEADERS = r.headers || [];
      ROWS = (r.rows || []).map(normalize);
      ACTIVE_DATE = r.date || ACTIVE_DATE;
      PERIOD_TEXT = ROWS[0]?.["수령기간"] || "";
    }
    updatePeriodBadge();
    _loaded = true;
  } finally {
    setBusy(false);
  }
}

function normalize(r) {
  // 숫자/문자열 컨버전
  const out = { ...r };
  out["뒷자리"] = pad4(r["뒷자리"]);
  out["수량"] = Number(r["수량"] || 0);
  out["단가"] = Number(r["단가"] || 0);
  out["품목금액"] = Number(r["품목금액"] || 0);
  out["원본순번"] = Number(r["원본순번"] || 0);
  out["예약내품목순서"] = Number(r["예약내품목순서"] || 1);
  out["예약상태"] = r["예약상태"] || "예약중";
  out["수령여부"] = r["수령여부"] || "N";
  return out;
}

function updatePeriodBadge() {
  // 수령기간 배지 제거됨 (no-op)
}

function formatSnapshotLabel(id) {
  // "2026-04-19" 또는 "2026-04-19_오전분"
  const parts = id.split("_");
  if (parts.length < 2) return id;
  const date = parts[0];
  const label = parts.slice(1).join("_");
  return `${date} · ${label}`;
}

function refreshSnapshotPicker() {
  const sel = $("#snapshotPicker");
  if (!sel) return;
  const sorted = SNAPSHOTS.slice().sort().reverse();
  const allOpt = `<option value="__ALL__" ${ACTIVE_DATE === "__ALL__" ? "selected" : ""}>🌐 전체 스냅샷</option>`;
  const opts = sorted.map(d =>
    `<option value="${escapeHtml(d)}" ${d === ACTIVE_DATE ? "selected" : ""}>${escapeHtml(formatSnapshotLabel(d))}</option>`
  ).join("");
  sel.innerHTML = allOpt + opts;
  sel.disabled = false;
}

// ---------- 상태 변경 (API 호출) ----------
async function setPickup(id, yes) {
  const prev = ROWS.find(r => r["예약번호"] === id);
  if (!prev) return;

  // 낙관적 업데이트
  const snapshot = { ...prev };
  Object.assign(prev, yes
    ? { "수령여부": "Y", "예약상태": "수령완료", "수령일시": nowStamp(), "처리자": OPERATOR }
    : { "수령여부": "N", "예약상태": "예약중", "수령일시": "", "처리자": "" });
  rerenderAll();

  try {
    const r = await apiPost({ action: "pickup", id, state: yes });
    Object.assign(prev, normalize(r.row));
    rerenderAll();
    toast(yes ? "✓ 수령 처리됨" : "수령 취소됨", {
      undo: async () => {
        hideToast();
        await setPickup(id, !yes);
      },
    });
  } catch (e) {
    Object.assign(prev, snapshot);
    rerenderAll();
    toast("네트워크 오류: " + e.message);
  }
}

async function cancelReservation(id) {
  const row = ROWS.find(r => r["예약번호"] === id);
  if (!row) return;
  const ok = await confirmModal({
    title: "예약 취소",
    body: `${row["품목명"]} 예약을 취소할까요?\n미수령 목록에서 제외됩니다.`,
    confirmText: "취소 처리",
  });
  if (!ok) return;
  const snapshot = { ...row };
  Object.assign(row, { "예약상태": "취소됨", "수령여부": "N" });
  rerenderAll();
  try {
    const r = await apiPost({ action: "cancel", id });
    Object.assign(row, normalize(r.row));
    rerenderAll();
    toast("예약 취소됨", {
      undo: async () => {
        hideToast();
        await restoreReservation(id);
      },
    });
  } catch (e) {
    Object.assign(row, snapshot);
    rerenderAll();
    toast("네트워크 오류: " + e.message);
  }
}

async function restoreReservation(id) {
  const row = ROWS.find(r => r["예약번호"] === id);
  if (!row) return;
  const snapshot = { ...row };
  Object.assign(row, { "예약상태": "예약중", "수령여부": "N" });
  rerenderAll();
  try {
    const r = await apiPost({ action: "restore", id });
    Object.assign(row, normalize(r.row));
    rerenderAll();
    toast("예약 복원됨");
  } catch (e) {
    Object.assign(row, snapshot);
    rerenderAll();
    toast("네트워크 오류: " + e.message);
  }
}

function nowStamp() {
  const d = new Date();
  const z = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

// ---------- 카드 ----------
function itemCard(r) {
  const st = statusOf(r);
  const picked = st === "수령완료";
  const cancelled = st === "취소됨";

  const due = parsePeriodDueDate(r["수령기간"]);
  const diff = due ? daysBetween(today(), due) : null;
  const isOverdue = !picked && !cancelled && diff !== null && diff < 0;
  const isToday = !picked && !cancelled && diff === 0;

  let dueTag = "";
  if (cancelled) dueTag = `<span class="chip-tag cancelled">취소됨</span>`;
  else if (picked) dueTag = `<span class="chip-tag success">✓ 수령완료</span>`;
  else if (diff === null) dueTag = "";
  else if (diff < 0) dueTag = `<span class="chip-tag danger">기한 ${-diff}일 지남</span>`;
  else if (diff === 0) dueTag = `<span class="chip-tag warn">오늘 수령</span>`;
  else dueTag = `<span class="chip-tag">D-${diff}</span>`;

  const memo = r["비고"]
    ? `<div class="item-memo">📝 ${escapeHtml(r["비고"])}</div>` : "";

  const pickedInfo = picked && r["수령일시"]
    ? `<span>수령: ${escapeHtml(r["수령일시"])} · ${escapeHtml(r["처리자"] || "-")}</span>`
    : "";

  let actions;
  if (cancelled) {
    actions = `<button class="btn btn-outline btn-sm" data-action="restore" data-id="${escapeHtml(r["예약번호"])}">복원</button>`;
  } else if (picked) {
    actions = `<button class="btn btn-outline" data-action="toggle" data-id="${escapeHtml(r["예약번호"])}">수령 취소</button>`;
  } else {
    actions = `
      <button class="btn btn-success" data-action="toggle" data-id="${escapeHtml(r["예약번호"])}">✓ 수령 완료</button>
      <button class="btn btn-danger-outline" data-action="cancel" data-id="${escapeHtml(r["예약번호"])}">예약취소</button>
    `;
  }

  const classes = ["item-card"];
  if (picked) classes.push("picked-up");
  if (cancelled) classes.push("cancelled");
  if (isOverdue) classes.push("overdue");

  return `
    <div class="${classes.join(" ")}" data-id="${escapeHtml(r["예약번호"])}">
      <div class="item-tier1">
        <h3 class="item-title">${escapeHtml(r["품목명"])} <span class="item-qty">×${r["수량"]}</span></h3>
        <span class="item-price">${money(r["품목금액"])}<span class="unit">원</span></span>
      </div>
      <div class="item-tier2">
        ${dueTag}
      </div>
      <div class="item-tier3">
        ${r["수령기간"] ? `<span>${escapeHtml(r["수령기간"])}</span>` : ""}
        <span>단가 ${money(r["단가"])}원</span>
        ${pickedInfo}
      </div>
      ${memo}
      <div class="item-actions">${actions}</div>
    </div>
  `;
}

// ---------- 조회 탭 ----------
let _lookupState = { phone: null, selectedOrderSeq: null };

function renderLookup() {
  const { phone, selectedOrderSeq } = _lookupState;
  const container = $("#lookupResult");
  if (!phone) {
    container.innerHTML = `
      <div class="empty">
        <div class="emoji">📱</div>
        <p class="empty-title">뒷자리 4자리를 입력하세요</p>
        <p class="empty-body">입력 후 예약 내역을 확인합니다.</p>
      </div>`;
    return;
  }

  let items = ROWS.filter(r => r["뒷자리"] === phone);
  if (!items.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="emoji">🔍</div>
        <p class="empty-title"><b>${phone}</b>로 예약된 내역이 없습니다</p>
        <p class="empty-body">번호를 다시 확인하거나 '전체 시트'에서 검색해 보세요.</p>
      </div>`;
    return;
  }

  // 전체 스냅샷 모드: 스냅샷별로 섹션 분리 렌더
  if (ACTIVE_DATE === "__ALL__") {
    return renderLookupGlobal(container, phone, items);
  }

  // 중복: 같은 뒷자리인데 원본순번이 다른 경우 → 주문 블록별 선택
  const orderSeqs = [...new Set(items.map(i => i["원본순번"]))];
  if (orderSeqs.length > 1 && selectedOrderSeq == null) {
    const picks = orderSeqs.sort((a, b) => a - b).map(seq => {
      const group = items.filter(i => i["원본순번"] === seq);
      const firstItem = group[0]["품목명"];
      const more = group.length > 1 ? ` 외 ${group.length - 1}품목` : "";
      const totalAmt = group.reduce((s, i) => s + Number(i["품목금액"] || 0), 0);
      return `
        <div class="pick-card" data-pick="${seq}">
          <div>
            <div class="name">주문 #${seq}</div>
            <div class="sub">${escapeHtml(firstItem)}${more} · ${money(totalAmt)}원</div>
          </div>
          <span class="chip-tag">선택 ▸</span>
        </div>
      `;
    }).join("");
    container.innerHTML = `
      <div class="empty" style="padding:20px">
        <p class="empty-title">동일 뒷자리 ${phone}에 주문 ${orderSeqs.length}건</p>
        <p class="empty-body">어떤 주문인지 선택해주세요.</p>
      </div>
      <div class="result" style="margin-top:12px">${picks}</div>
    `;
    $$(".pick-card", container).forEach(c => {
      c.addEventListener("click", () => {
        _lookupState.selectedOrderSeq = Number(c.dataset.pick);
        renderLookup();
      });
    });
    return;
  }

  if (selectedOrderSeq != null) items = items.filter(i => i["원본순번"] === selectedOrderSeq);

  const totalCount = items.length;
  const done = items.filter(i => statusOf(i) === "수령완료").length;
  const cancelled = items.filter(i => statusOf(i) === "취소됨").length;
  const totalAmt = items
    .filter(i => statusOf(i) !== "취소됨")
    .reduce((s, i) => s + Number(i["품목금액"] || 0), 0);
  const seqInfo = selectedOrderSeq != null ? ` · 주문 #${selectedOrderSeq}` : "";

  const headerHtml = `
    <div class="customer-header">
      <div>
        <div class="who">뒷자리 ${escapeHtml(phone)}${seqInfo}</div>
        <div class="meta">품목 ${totalCount}건 · 수령 ${done}/${totalCount - cancelled}${cancelled ? ` · 취소 ${cancelled}` : ""} · ${money(totalAmt)}원</div>
      </div>
      <div class="customer-header-actions">
        <button class="btn btn-outline btn-sm" id="btnPickupAll">전체 수령</button>
      </div>
    </div>
  `;

  container.innerHTML = headerHtml + items.map(itemCard).join("");

  $("#btnPickupAll")?.addEventListener("click", async () => {
    const targets = items.filter(i => statusOf(i) === "예약중");
    if (!targets.length) { toast("이미 처리된 건만 있습니다"); return; }
    const ok = await confirmModal({
      title: "전체 수령 처리",
      body: `${targets.length}건을 모두 수령 완료로 처리합니다.\n진행할까요?`,
      confirmText: "전체 처리",
    });
    if (!ok) return;
    setBusy(true, "처리 중…");
    try {
      for (const it of targets) {
        await apiPost({ action: "pickup", id: it["예약번호"], state: true });
        Object.assign(it, { "수령여부": "Y", "예약상태": "수령완료", "수령일시": nowStamp(), "처리자": OPERATOR });
      }
      rerenderAll();
      toast(`${targets.length}건 수령 완료`);
    } catch (e) {
      toast("일부 실패: " + e.message);
      await loadActive(ACTIVE_DATE);
      rerenderAll();
    } finally {
      setBusy(false);
    }
  });

  bindCardActions(container);
}

function renderLookupGlobal(container, phone, items) {
  // 스냅샷별 섹션
  const bySnap = {};
  items.forEach(r => {
    (bySnap[r["_스냅샷"] || "(미지정)"] ||= []).push(r);
  });
  const snaps = Object.keys(bySnap).sort().reverse();
  const totalCount = items.length;
  const done = items.filter(i => statusOf(i) === "수령완료").length;
  const cancelled = items.filter(i => statusOf(i) === "취소됨").length;
  const totalAmt = items
    .filter(i => statusOf(i) !== "취소됨")
    .reduce((s, i) => s + Number(i["품목금액"] || 0), 0);

  const header = `
    <div class="customer-header">
      <div>
        <div class="who">뒷자리 ${escapeHtml(phone)} · 🌐 전체 스냅샷</div>
        <div class="meta">총 ${totalCount}건 · 수령 ${done}/${totalCount - cancelled}${cancelled ? ` · 취소 ${cancelled}` : ""} · ${money(totalAmt)}원</div>
        <div class="meta">${snaps.length}개 스냅샷에서 발견</div>
      </div>
    </div>
  `;

  const sections = snaps.map(sn => {
    const group = bySnap[sn];
    const gDone = group.filter(i => statusOf(i) === "수령완료").length;
    const gPending = group.filter(i => statusOf(i) === "예약중").length;
    const gAmt = group.filter(i => statusOf(i) !== "취소됨").reduce((s, i) => s + Number(i["품목금액"] || 0), 0);
    return `
      <details class="pending-group" ${gPending > 0 ? "open" : ""}>
        <summary>
          <span class="caret">▸</span>
          <div class="name-block">
            <div class="name">${escapeHtml(formatSnapshotLabel(sn))} <span style="color:var(--muted);font-size:13px;font-weight:600">(${group.length}건)</span></div>
            <div class="sub">수령 ${gDone}/${group.length - group.filter(i => statusOf(i) === "취소됨").length} · ${money(gAmt)}원</div>
          </div>
          ${gPending > 0 ? `<span class="chip-tag warn">미수령 ${gPending}</span>` : `<span class="chip-tag success">완료</span>`}
        </summary>
        <div class="items">
          ${group.map(itemCard).join("")}
        </div>
      </details>
    `;
  }).join("");

  container.innerHTML = header + `<div class="result" style="margin-top:12px">${sections}</div>`;
  bindCardActions(container);
}

function bindCardActions(root) {
  $$("[data-action]", root).forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "toggle") {
        const cur = ROWS.find(r => r["예약번호"] === id);
        setPickup(id, statusOf(cur) !== "수령완료");
      } else if (action === "cancel") {
        cancelReservation(id);
      } else if (action === "restore") {
        restoreReservation(id);
      }
    });
  });
}

// ---------- 미수령 탭 ----------
const PENDING_FILTER = { seg: "all" };

function renderPending() {
  const pendingAll = ROWS.filter(r => statusOf(r) === "예약중");
  const diffOfRow = r => {
    const due = parsePeriodDueDate(r["수령기간"]);
    return due ? daysBetween(today(), due) : null;
  };

  const counts = {
    all: pendingAll.length,
    overdue: pendingAll.filter(r => { const d = diffOfRow(r); return d !== null && d < 0; }).length,
    today: pendingAll.filter(r => diffOfRow(r) === 0).length,
    future: pendingAll.filter(r => { const d = diffOfRow(r); return d !== null && d > 0; }).length,
  };

  const setCount = (id, n) => {
    const el = $("#segCount" + id);
    if (!el) return;
    el.textContent = n;
    el.classList.toggle("zero", n === 0);
  };
  setCount("All", counts.all);
  setCount("Overdue", counts.overdue);
  setCount("Today", counts.today);
  setCount("Future", counts.future);
  $$("#segFilter .seg").forEach(b => {
    b.classList.toggle("active", b.dataset.seg === PENDING_FILTER.seg);
  });

  let pending = pendingAll;
  if (PENDING_FILTER.seg === "overdue") pending = pending.filter(r => { const d = diffOfRow(r); return d !== null && d < 0; });
  else if (PENDING_FILTER.seg === "today") pending = pending.filter(r => diffOfRow(r) === 0);
  else if (PENDING_FILTER.seg === "future") pending = pending.filter(r => { const d = diffOfRow(r); return d !== null && d > 0; });

  const container = $("#pendingResult");
  if (!pending.length) {
    const msg = {
      overdue: { t: "기한 지난 건이 없습니다", b: "다행히 모두 제때 찾아갔어요." },
      today:   { t: "오늘 수령 예정이 없습니다", b: "오늘은 여유로운 하루네요." },
      future:  { t: "예정된 미수령이 없습니다", b: "이번 주 예약이 깔끔합니다." },
      all:     { t: "미수령 예약이 없습니다", b: "오늘도 수고하셨습니다." },
    }[PENDING_FILTER.seg] || { t: "해당 건이 없습니다", b: "" };
    container.innerHTML = `
      <div class="empty">
        <div class="emoji">✅</div>
        <p class="empty-title">${msg.t}</p>
        <p class="empty-body">${msg.b}</p>
      </div>`;
    return;
  }

  // 스냅샷+뒷자리+원본순번 그룹 (전역 모드에서도 동일 뒷자리가 다른 주 스냅샷이면 분리)
  const groups = {};
  pending.forEach(r => {
    const snap = r["_스냅샷"] || ACTIVE_DATE || "";
    const key = `${snap}|${r["뒷자리"]}-${r["원본순번"]}`;
    (groups[key] ||= {
      snap,
      phone: r["뒷자리"],
      seq: r["원본순번"],
      items: [],
    }).items.push(r);
  });

  const keys = Object.keys(groups).sort((a, b) => {
    const ga = groups[a]; const gb = groups[b];
    // 스냅샷 내림차순 우선, 그 안에서 순번 오름차순
    if (ga.snap !== gb.snap) return gb.snap.localeCompare(ga.snap);
    return ga.seq - gb.seq;
  });

  container.innerHTML = keys.map(k => {
    const g = groups[k];
    const firstItem = g.items[0];
    const gDue = parsePeriodDueDate(firstItem["수령기간"]);
    const gd = gDue ? daysBetween(today(), gDue) : null;
    let klass = "pending-group";
    let statusTag;
    if (gd === null) statusTag = `<span class="chip-tag">수령기간 없음</span>`;
    else if (gd < 0) { klass += " overdue"; statusTag = `<span class="chip-tag danger">기한 ${-gd}일 지남</span>`; }
    else if (gd === 0) { klass += " today"; statusTag = `<span class="chip-tag warn">오늘 수령</span>`; }
    else statusTag = `<span class="chip-tag">D-${gd}</span>`;

    const totalAmt = g.items.reduce((s, i) => s + Number(i["품목금액"] || 0), 0);
    const snapBadge = ACTIVE_DATE === "__ALL__"
      ? `<div class="snap-badge">${escapeHtml(formatSnapshotLabel(g.snap))}</div>` : "";

    return `
      <details class="${klass}" ${gd !== null && gd <= 0 ? "open" : ""}>
        <summary>
          <span class="caret">▸</span>
          <div class="name-block">
            ${snapBadge}
            <div class="name"><span class="phone-pill">${escapeHtml(g.phone)}</span> · 주문 #${g.seq} <span style="color:var(--muted);font-size:13px;font-weight:600">(${g.items.length}품목)</span></div>
            <div class="sub">${money(totalAmt)}원</div>
          </div>
          ${statusTag}
        </summary>
        <div class="items">
          ${g.items.map(itemCard).join("")}
        </div>
      </details>
    `;
  }).join("");

  bindCardActions(container);
}

// ---------- 전체 시트 탭 ----------
const SHEET_STATE = { sortKey: null, sortDir: 1, query: "" };
const NUMERIC_COLS = new Set(["수량", "단가", "품목금액", "원본순번", "예약내품목순서", "행합계수량"]);
const SHEET_HIDDEN_COLS = new Set(["예약번호", "예약내품목순서", "원본뒷자리", "원본품목", "행합계수량"]);
const EDITABLE_SHEET_COLS = new Set(["예약상태", "수량", "비고"]);
const STATUS_OPTIONS = ["예약중", "수령완료", "취소됨"];

function renderSheet() {
  const table = $("#sheetTable");
  if (!ROWS.length) {
    table.querySelector("thead").innerHTML = "";
    table.querySelector("tbody").innerHTML = "";
    $("#sheetCount").textContent = "0건";
    return;
  }
  const headers = HEADERS.filter(h => !SHEET_HIDDEN_COLS.has(h));
  const q = SHEET_STATE.query.trim().toLowerCase();

  let rows = ROWS.slice();
  if (q) {
    rows = rows.filter(r =>
      headers.some(h => String(r[h] ?? "").toLowerCase().includes(q))
    );
  }
  if (SHEET_STATE.sortKey) {
    const k = SHEET_STATE.sortKey;
    const dir = SHEET_STATE.sortDir;
    const isNum = NUMERIC_COLS.has(k);
    rows.sort((a, b) => {
      const va = isNum ? Number(a[k] || 0) : String(a[k] ?? "");
      const vb = isNum ? Number(b[k] || 0) : String(b[k] ?? "");
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return 0;
    });
  }

  const thead = "<tr>" + headers.map(h => {
    let cls = "";
    if (SHEET_STATE.sortKey === h) cls = SHEET_STATE.sortDir === 1 ? "sorted-asc" : "sorted-desc";
    return `<th data-key="${escapeHtml(h)}" class="${cls}">${escapeHtml(h)}</th>`;
  }).join("") + "</tr>";

  const tbody = rows.map(r => {
    return "<tr data-id=\"" + escapeHtml(r["예약번호"]) + "\">" + headers.map(h => {
      const v = r[h] ?? "";
      let cls = "";
      if (NUMERIC_COLS.has(h)) cls += " num";
      if (h === "수령여부") cls += v === "Y" ? " pickup-y" : " pickup-n";
      if (h === "예약상태" && v === "취소됨") cls += " status-cancel";
      if (EDITABLE_SHEET_COLS.has(h)) cls += " editable";
      let content;
      if (h === "예약상태") {
        content = STATUS_OPTIONS.map(opt =>
          `<option value="${opt}" ${opt === v ? "selected" : ""}>${opt}</option>`
        ).join("");
        return `<td class="${cls.trim()}"><select class="cell-edit" data-field="예약상태">${content}</select></td>`;
      }
      if (h === "수량") {
        return `<td class="${cls.trim()}"><input type="number" min="0" class="cell-edit num-input" data-field="수량" value="${escapeHtml(v)}" /></td>`;
      }
      if (h === "비고") {
        return `<td class="${cls.trim()}"><input type="text" class="cell-edit" data-field="비고" value="${escapeHtml(v)}" placeholder="—" /></td>`;
      }
      if (h === "뒷자리") {
        return `<td class="${cls.trim()}"><span class="phone-pill" style="background:${phoneColor(v)}">${escapeHtml(v)}</span></td>`;
      }
      return `<td class="${cls.trim()}">${escapeHtml(v)}</td>`;
    }).join("") + "</tr>";
  }).join("");

  table.querySelector("thead").innerHTML = thead;
  table.querySelector("tbody").innerHTML = tbody;
  $("#sheetCount").textContent = `${rows.length}건 / 총 ${ROWS.length}건`;

  $$("#sheetTable thead th").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (SHEET_STATE.sortKey === k) SHEET_STATE.sortDir *= -1;
      else { SHEET_STATE.sortKey = k; SHEET_STATE.sortDir = 1; }
      renderSheet();
    });
  });

  // 인라인 편집
  $$("#sheetTable .cell-edit").forEach(el => {
    const tr = el.closest("tr");
    const id = tr.dataset.id;
    const field = el.dataset.field;

    const commit = async () => {
      const row = ROWS.find(r => r["예약번호"] === id);
      if (!row) return;
      let newVal = el.value;
      const origVal = row[field];
      if (field === "수량") newVal = Number(newVal);
      if (String(newVal) === String(origVal ?? "")) return;

      el.classList.add("saving");
      try {
        const r = await apiPost({ action: "update", id, field, value: newVal });
        Object.assign(row, normalize(r.row));
        el.classList.remove("saving");
        el.classList.add("saved");
        setTimeout(() => el.classList.remove("saved"), 800);
        refreshBadge();
        // 예약상태 변경 시 다른 탭에도 영향
        if (field === "예약상태" || field === "수량") renderSheet();
      } catch (e) {
        el.classList.remove("saving");
        el.classList.add("error");
        toast("저장 실패: " + e.message);
        el.value = origVal;
      }
    };

    if (el.tagName === "SELECT") {
      el.addEventListener("change", commit);
    } else {
      el.addEventListener("blur", commit);
      el.addEventListener("keydown", e => { if (e.key === "Enter") el.blur(); });
    }
  });
}

// ---------- 공통 ----------
function refreshBadge() {
  const count = ROWS.filter(r => statusOf(r) === "예약중").length;
  const badge = $("#pendingBadge");
  badge.textContent = count;
  badge.style.display = count ? "inline-block" : "none";
}

function rerenderAll() {
  refreshBadge();
  if ($("#tab-lookup").classList.contains("active")) renderLookup();
  if ($("#tab-pending").classList.contains("active")) renderPending();
  if ($("#tab-sheet").classList.contains("active")) renderSheet();
}

// ---------- 이벤트 ----------
function bindTabs() {
  $$(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach(t => t.classList.remove("active"));
      $$(".tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      $("#tab-" + tab.dataset.tab).classList.add("active");
      if (!_loaded) return;
      if (tab.dataset.tab === "pending") renderPending();
      if (tab.dataset.tab === "sheet") renderSheet();
      if (tab.dataset.tab === "lookup") renderLookup();
    });
  });
}

function bindSearch() {
  const input = $("#phoneInput");
  const run = () => {
    const v = input.value.trim();
    if (!/^\d{4}$/.test(v)) {
      toast("4자리 숫자를 입력하세요");
      input.focus();
      return;
    }
    _lookupState = { phone: v, selectedOrderSeq: null };
    renderLookup();
  };
  $("#btnSearch").addEventListener("click", run);
  $("#btnClear").addEventListener("click", () => {
    input.value = "";
    _lookupState = { phone: null, selectedOrderSeq: null };
    renderLookup();
    input.focus();
  });
  input.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
  });
}

function bindActions() {
  $("#btnImport").addEventListener("click", async () => {
    const res = await confirmModal({
      title: "원본 시트에서 불러오기",
      body: "스냅샷에 제목을 붙이면 같은 날짜에 여러 배치를 분리 관리할 수 있습니다.\n비워두면 날짜만 사용합니다.",
      confirmText: "불러오기",
      input: {
        placeholder: "예: 오전분, 추가입고, 오후분",
        hint: "최대 30자 · 특수문자(/ \\ : ? * [ ])는 자동으로 '-'로 변환됩니다.",
        default: "",
      },
    });
    if (!res || !res.confirmed) return;
    const label = (res.value || "").trim();
    setBusy(true, "원본 시트 파싱 중…");
    try {
      const r = await apiPost({ action: "import", label });
      await loadSnapshots();
      const target = r.snapshotId || r.date || ACTIVE_DATE;
      await loadActive(target);
      rerenderAll();
      const snapLabel = r.label ? ` (${r.label})` : "";
      toast(`${r.count || 0}건 불러옴${snapLabel} · ${r.restored || 0}건 복원`);
    } catch (e) {
      toast("불러오기 실패: " + e.message);
    } finally {
      setBusy(false);
    }
  });

  $("#btnRefresh").addEventListener("click", async () => {
    setBusy(true);
    try {
      await loadSnapshots();
      await loadActive(ACTIVE_DATE);
      rerenderAll();
      toast("새로고침됨");
    } catch (e) {
      toast("실패: " + e.message);
    } finally {
      setBusy(false);
    }
  });

  $("#snapshotPicker")?.addEventListener("change", async e => {
    const date = e.target.value;
    setBusy(true);
    try {
      await loadActive(date);
      rerenderAll();
    } catch (err) {
      toast("실패: " + err.message);
    } finally {
      setBusy(false);
    }
  });

  $("#toastUndo").addEventListener("click", () => {
    if (_undoAction) _undoAction();
  });

  $$("#segFilter .seg").forEach(b => {
    b.addEventListener("click", () => {
      PENDING_FILTER.seg = b.dataset.seg;
      renderPending();
    });
  });

  $("#sheetSearch").addEventListener("input", e => {
    SHEET_STATE.query = e.target.value;
    renderSheet();
  });
}

// ---------- 초기화 ----------
async function init() {
  setBusy(true, "서버에 연결 중…");
  try {
    await loadSnapshots();
    if (!ACTIVE_DATE) {
      $("#lookupResult").innerHTML = `
        <div class="empty">
          <div class="emoji">📭</div>
          <p class="empty-title">아직 스냅샷이 없습니다</p>
          <p class="empty-body">상단 '📥 불러오기' 버튼을 눌러 원본 시트에서 가져오세요.</p>
        </div>`;
      setBusy(false);
      return;
    }
    await loadActive(ACTIVE_DATE);
    rerenderAll();
  } catch (e) {
    $("#lookupResult").innerHTML = `
      <div class="empty">
        <div class="emoji">⚠️</div>
        <p class="empty-title">서버 연결 실패</p>
        <p class="empty-body">${escapeHtml(e.message)}</p>
      </div>`;
  } finally {
    setBusy(false);
  }
}

bindTabs();
bindSearch();
bindActions();
init();
