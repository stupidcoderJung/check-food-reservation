// GS Fresh 예약관리 — POC v3 (Google Apps Script 연동)
// 원본 시트는 사장님 워크플로 그대로, 수령 체크는 _AppStatus_YYYY-MM-DD 탭에 기록

const API_URL = "https://script.google.com/macros/s/AKfycbz8T14pnyzE7XMg5L4SUP4B3hSASh2WPyVWffhGIVtHUOBjAWsGgU7UIgs8qtyq2Sc/exec";
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
function confirmModal({ title, body, confirmText = "확인", danger = false }) {
  return new Promise(resolve => {
    $("#modalTitle").textContent = title;
    $("#modalBody").textContent = body;
    const c = $("#modalConfirm");
    c.textContent = confirmText;
    c.className = "btn " + (danger ? "btn-success" : "btn-primary");
    const m = $("#modal");
    m.hidden = false;
    const close = v => {
      m.hidden = true;
      c.removeEventListener("click", onOk);
      $("#modalCancel").removeEventListener("click", onNo);
      resolve(v);
    };
    const onOk = () => close(true);
    const onNo = () => close(false);
    c.addEventListener("click", onOk);
    $("#modalCancel").addEventListener("click", onNo);
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
    const r = await apiGet({ action: "list", ...(date ? { date } : {}) });
    HEADERS = r.headers || [];
    ROWS = (r.rows || []).map(normalize);
    ACTIVE_DATE = r.date || ACTIVE_DATE;
    PERIOD_TEXT = ROWS[0]?.["수령기간"] || "";
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
  const el = $("#periodBadge");
  if (PERIOD_TEXT) {
    el.textContent = "📅 " + PERIOD_TEXT;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function refreshSnapshotPicker() {
  const sel = $("#snapshotPicker");
  if (!sel) return;
  sel.innerHTML = SNAPSHOTS.map(d =>
    `<option value="${d}" ${d === ACTIVE_DATE ? "selected" : ""}>${d}</option>`
  ).join("");
  sel.disabled = SNAPSHOTS.length <= 1;
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
  const due = parsePeriodDueDate(PERIOD_TEXT);
  const diffOf = () => due ? daysBetween(today(), due) : null;
  const d = diffOf();

  // 수령기간 1개만 존재하므로 한 주 안에선 모든 건이 같은 D-day
  // 세그먼트 분류는 해당 주의 수령 마지막일 기준
  const counts = {
    all: pendingAll.length,
    overdue: d !== null && d < 0 ? pendingAll.length : 0,
    today: d === 0 ? pendingAll.length : 0,
    future: d !== null && d > 0 ? pendingAll.length : 0,
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
  if (PENDING_FILTER.seg === "overdue" && !(d !== null && d < 0)) pending = [];
  else if (PENDING_FILTER.seg === "today" && d !== 0) pending = [];
  else if (PENDING_FILTER.seg === "future" && !(d !== null && d > 0)) pending = [];

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

  // 뒷자리+원본순번 그룹
  const groups = {};
  pending.forEach(r => {
    const key = `${r["뒷자리"]}-${r["원본순번"]}`;
    (groups[key] ||= {
      phone: r["뒷자리"],
      seq: r["원본순번"],
      items: [],
    }).items.push(r);
  });

  const keys = Object.keys(groups).sort((a, b) => {
    const ga = groups[a]; const gb = groups[b];
    return ga.seq - gb.seq;
  });

  container.innerHTML = keys.map(k => {
    const g = groups[k];
    const gd = due ? daysBetween(today(), due) : null;
    let klass = "pending-group";
    let statusTag;
    if (gd === null) statusTag = `<span class="chip-tag">수령기간 없음</span>`;
    else if (gd < 0) { klass += " overdue"; statusTag = `<span class="chip-tag danger">기한 ${-gd}일 지남</span>`; }
    else if (gd === 0) { klass += " today"; statusTag = `<span class="chip-tag warn">오늘 수령</span>`; }
    else statusTag = `<span class="chip-tag">D-${gd}</span>`;

    const totalAmt = g.items.reduce((s, i) => s + Number(i["품목금액"] || 0), 0);

    return `
      <details class="${klass}" ${gd !== null && gd <= 0 ? "open" : ""}>
        <summary>
          <span class="caret">▸</span>
          <div class="name-block">
            <div class="name">뒷자리 ${escapeHtml(g.phone)} · 주문 #${g.seq} <span style="color:var(--muted);font-size:13px;font-weight:600">(${g.items.length}품목)</span></div>
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
const SHEET_HIDDEN_COLS = new Set(["예약번호", "원본순번", "예약내품목순서", "원본뒷자리", "원본품목", "행합계수량"]);

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
    const st = statusOf(r);
    return "<tr>" + headers.map(h => {
      const v = r[h] ?? "";
      let cls = "";
      if (NUMERIC_COLS.has(h)) cls += " num";
      if (h === "수령여부") cls += v === "Y" ? " pickup-y" : " pickup-n";
      if (h === "예약상태" && v === "취소됨") cls += " status-cancel";
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
    const ok = await confirmModal({
      title: "원본 시트에서 불러오기",
      body: "사장님 시트의 최신 상태로 다시 파싱합니다.\n이미 수령 체크한 건은 자동 복원됩니다.",
      confirmText: "불러오기",
    });
    if (!ok) return;
    setBusy(true, "원본 시트 파싱 중…");
    try {
      const r = await apiPost({ action: "import" });
      await loadSnapshots();
      await loadActive(r.date || ACTIVE_DATE);
      rerenderAll();
      toast(`${r.count || r.orders || 0}건 불러옴 · ${r.restored || 0}건 복원`);
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
