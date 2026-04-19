// 동네슈퍼 예약관리 — POC v2
// - 뒷자리 중복 처리, 예약 취소, 수령 Undo, tel 링크, 배달 구분, CSV 업로드, 하단 탭바, UX 폴리시

const DEFAULT_CSV_URL = "reservations.csv";
const STORAGE_KEY = "pickup-overlay-v2";
const CSV_CACHE_KEY = "csv-cache-v1";
const TODAY_STR = "2026-04-19"; // 데모 기준일 (실배포 시 제거)
const OPERATOR = "점주"; // 처리자 기본값

let RESERVATIONS = [];
let HEADERS = [];
let _loaded = false;

// ---------- 공통 유틸 ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const today = () => new Date(TODAY_STR);

function parseCsv(text) {
  // 따옴표 미사용 CSV 단순 파서. 이번 스키마에 포함된 쉼표/줄바꿈 값 없음.
  const lines = text.replace(/\uFEFF/g, "").trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map(line => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function toCsv(rows, headers) {
  if (!rows.length) return "";
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => r[h] ?? "").join(","));
  return lines.join("\n") + "\n";
}

function loadOverlay() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}
function saveOverlay(o) { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); }

function applyOverlay(rows, overlay) {
  return rows.map(r => {
    const o = overlay[r["예약번호"]];
    return o ? { ...r, ...o } : { ...r };
  });
}

function daysBetween(a, b) {
  const d1 = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const d2 = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((d2 - d1) / 86400000);
}

function fmtDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const diff = daysBetween(today(), d);
  const wd = ["일","월","화","수","목","금","토"][d.getDay()];
  const short = `${d.getMonth()+1}/${d.getDate()}(${wd})`;
  if (diff === 0) return `오늘 ${short}`;
  if (diff === 1) return `내일 ${short}`;
  if (diff === -1) return `어제 ${short}`;
  return short;
}

function money(n) {
  return Number(n || 0).toLocaleString("ko-KR");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function nowStamp() {
  const d = new Date();
  const z = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

function statusOf(r) {
  if (r["예약상태"]) return r["예약상태"];
  return r["수령여부"] === "Y" ? "수령완료" : "예약중";
}

// ---------- 토스트 (Undo 지원) ----------
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

// ---------- 상태 변경 ----------
function mutate(id, patch) {
  const overlay = loadOverlay();
  overlay[id] = { ...(overlay[id] || {}), ...patch };
  saveOverlay(overlay);
  const row = RESERVATIONS.find(r => r["예약번호"] === id);
  if (row) Object.assign(row, patch);
}

async function setPickup(id, yes) {
  const row = RESERVATIONS.find(r => r["예약번호"] === id);
  if (!row) return;

  if (yes && row["수령방법"] === "배달") {
    const ok = await confirmModal({
      title: "배달 건입니다",
      body: `${row["물품명"]}은(는) 배달로 예약된 상품입니다.\n매장에서 전달하시겠습니까?`,
      confirmText: "매장 전달",
    });
    if (!ok) return;
  }

  const prev = {
    "수령여부": row["수령여부"],
    "예약상태": row["예약상태"],
    "수령일시": row["수령일시"] || "",
    "처리자": row["처리자"] || "",
  };

  if (yes) {
    mutate(id, {
      "수령여부": "Y",
      "예약상태": "수령완료",
      "수령일시": nowStamp(),
      "처리자": OPERATOR,
      "결제상태": row["결제상태"] === "미결제" ? "완료" : row["결제상태"],
    });
  } else {
    mutate(id, {
      "수령여부": "N",
      "예약상태": "예약중",
      "수령일시": "",
      "처리자": "",
    });
  }
  rerenderAll();

  toast(yes ? "✓ 수령 처리됨" : "수령 취소됨", {
    undo: () => {
      mutate(id, prev);
      rerenderAll();
      hideToast();
      toast("되돌림");
    },
  });
}

async function cancelReservation(id) {
  const row = RESERVATIONS.find(r => r["예약번호"] === id);
  if (!row) return;
  const ok = await confirmModal({
    title: "예약 취소",
    body: `${row["물품명"]} 예약을 취소할까요?\n미수령 목록에서 제외됩니다.`,
    confirmText: "취소 처리",
  });
  if (!ok) return;
  const prev = {
    "예약상태": row["예약상태"],
    "수령여부": row["수령여부"],
  };
  mutate(id, { "예약상태": "취소됨", "수령여부": "N" });
  rerenderAll();
  toast("예약 취소됨", {
    undo: () => {
      mutate(id, prev);
      rerenderAll();
      hideToast();
      toast("되돌림");
    },
  });
}

async function restoreReservation(id) {
  mutate(id, { "예약상태": "예약중", "수령여부": "N" });
  rerenderAll();
  toast("예약 복원됨");
}

// ---------- 렌더: 카드 ----------
function itemCard(r) {
  const st = statusOf(r);
  const picked = st === "수령완료";
  const cancelled = st === "취소됨";
  const due = new Date(r["수령예정일"]);
  const diff = daysBetween(today(), due);
  const isDelivery = r["수령방법"] === "배달";
  const isOverdue = !picked && !cancelled && diff < 0;

  let dueTag = "";
  if (cancelled) dueTag = `<span class="chip-tag cancelled">취소됨</span>`;
  else if (picked) dueTag = `<span class="chip-tag success">✓ 수령완료</span>`;
  else if (diff < 0) dueTag = `<span class="chip-tag danger">기한 ${-diff}일 지남</span>`;
  else if (diff === 0) dueTag = `<span class="chip-tag warn">오늘 수령</span>`;
  else dueTag = `<span class="chip-tag">D-${diff}</span>`;

  const deliveryTag = isDelivery ? `<span class="chip-tag delivery">🚚 배달</span>` : "";
  const unpaidTag = r["결제상태"] === "미결제"
    ? `<span class="chip-tag warn">미결제</span>` : "";
  const categoryTag = `<span class="chip-tag">${escapeHtml(r["카테고리"])}</span>`;

  const memo = r["비고"]
    ? `<div class="item-memo">📝 ${escapeHtml(r["비고"])}</div>` : "";

  const pickedInfo = picked && r["수령일시"]
    ? `<span>수령: ${escapeHtml(r["수령일시"])} · ${escapeHtml(r["처리자"] || "-")}</span>`
    : "";

  let actions = "";
  if (cancelled) {
    actions = `<button class="btn btn-outline btn-sm" data-action="restore" data-id="${r["예약번호"]}">복원</button>`;
  } else if (picked) {
    actions = `<button class="btn btn-outline" data-action="toggle" data-id="${r["예약번호"]}">수령 취소</button>`;
  } else {
    actions = `
      <button class="btn btn-success" data-action="toggle" data-id="${r["예약번호"]}">✓ 수령 완료</button>
      <button class="btn btn-danger-outline" data-action="cancel" data-id="${r["예약번호"]}">예약취소</button>
    `;
  }

  const classes = ["item-card"];
  if (picked) classes.push("picked-up");
  if (cancelled) classes.push("cancelled");
  if (isDelivery && !picked && !cancelled) classes.push("delivery");
  if (isOverdue) classes.push("overdue");

  return `
    <div class="${classes.join(" ")}" data-id="${r["예약번호"]}">
      <div class="item-tier1">
        <h3 class="item-title">${escapeHtml(r["물품명"])} <span class="item-qty">×${escapeHtml(r["수량"])}</span></h3>
        <span class="item-price">${money(r["총금액(원)"])}<span class="unit">원</span></span>
      </div>
      <div class="item-tier2">
        ${dueTag}
        ${deliveryTag}
        ${unpaidTag}
        ${categoryTag}
      </div>
      <div class="item-tier3">
        <span>수령예정 ${fmtDate(r["수령예정일"])}</span>
        <span>${escapeHtml(r["수령방법"])} · ${escapeHtml(r["결제방식"])}</span>
        <span>담당 ${escapeHtml(r["담당직원"])}</span>
        ${pickedInfo}
      </div>
      ${memo}
      <div class="item-actions">${actions}</div>
    </div>
  `;
}

// ---------- 조회 탭 ----------
let _lookupState = { phone: null, selectedGroup: null };

function renderLookup() {
  const { phone, selectedGroup } = _lookupState;
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

  let items = RESERVATIONS.filter(r => r["전화번호뒷자리"] === phone);
  if (!items.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="emoji">🔍</div>
        <p class="empty-title"><b>${phone}</b>로 예약된 내역이 없습니다</p>
        <p class="empty-body">번호를 다시 확인하거나 '전체 시트'에서 검색해 보세요.</p>
      </div>`;
    return;
  }

  // 중복 — 같은 뒷자리에 예약일자가 다른 묶음이 2개 이상이면 선택
  const groupsByDate = {};
  items.forEach(r => { (groupsByDate[r["예약일자"]] ||= []).push(r); });
  const dateKeys = Object.keys(groupsByDate);
  if (dateKeys.length > 1 && !selectedGroup) {
    const picks = dateKeys.sort().reverse().map(d => {
      const g = groupsByDate[d];
      const firstItem = g[0]["물품명"];
      const more = g.length > 1 ? ` 외 ${g.length - 1}건` : "";
      return `
        <div class="pick-card" data-pick="${escapeHtml(d)}">
          <div>
            <div class="name">${fmtDate(d)} 예약</div>
            <div class="sub">${escapeHtml(firstItem)}${more} · 총 ${g.length}건</div>
          </div>
          <span class="chip-tag">선택 ▸</span>
        </div>
      `;
    }).join("");
    container.innerHTML = `
      <div class="empty" style="padding:20px">
        <p class="empty-title">동일 뒷자리에 예약이 ${dateKeys.length}건 있습니다</p>
        <p class="empty-body">예약일로 구분해주세요.</p>
      </div>
      <div class="result" style="margin-top:12px">${picks}</div>
    `;
    $$(".pick-card", container).forEach(c => {
      c.addEventListener("click", () => {
        _lookupState.selectedGroup = c.dataset.pick;
        renderLookup();
      });
    });
    return;
  }

  if (selectedGroup) items = items.filter(i => i["예약일자"] === selectedGroup);

  const totalCount = items.length;
  const done = items.filter(i => statusOf(i) === "수령완료").length;
  const cancelled = items.filter(i => statusOf(i) === "취소됨").length;
  const unpaidAmt = items
    .filter(i => i["결제상태"] === "미결제" && statusOf(i) === "예약중")
    .reduce((s, i) => s + Number(i["총금액(원)"] || 0), 0);

  const unpaidLine = unpaidAmt > 0
    ? `<div class="unpaid">받을 금액 ${money(unpaidAmt)}원</div>` : "";

  const headerHtml = `
    <div class="customer-header">
      <div>
        <div class="who">뒷자리 ${escapeHtml(phone)}</div>
        <div class="meta">예약 ${totalCount}건 · 수령 ${done}/${totalCount - cancelled}${cancelled ? ` · 취소 ${cancelled}` : ""}</div>
        ${unpaidLine}
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
    for (const it of targets) {
      mutate(it["예약번호"], {
        "수령여부": "Y",
        "예약상태": "수령완료",
        "수령일시": nowStamp(),
        "처리자": OPERATOR,
        "결제상태": it["결제상태"] === "미결제" ? "완료" : it["결제상태"],
      });
    }
    rerenderAll();
    toast(`${targets.length}건 수령 완료`);
  });

  bindCardActions(container);
}

function bindCardActions(root) {
  $$("[data-action]", root).forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "toggle") {
        const cur = RESERVATIONS.find(r => r["예약번호"] === id);
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
function renderPending() {
  const onlyOverdue = $("#filterOverdue").checked;
  const onlyStore = $("#filterStoreOnly").checked;

  const pendingAll = RESERVATIONS.filter(r => statusOf(r) === "예약중");
  const overdue = pendingAll.filter(r => daysBetween(today(), new Date(r["수령예정일"])) < 0);
  const todayCnt = pendingAll.filter(r => daysBetween(today(), new Date(r["수령예정일"])) === 0).length;
  const future = pendingAll.length - overdue.length - todayCnt;

  $("#summaryBar").innerHTML = `
    <button class="${overdue.length ? "danger" : ""}" data-filter="overdue">
      <span class="num">${overdue.length}</span><span>기한지남</span>
    </button>
    <button class="${todayCnt ? "warn" : ""}" data-filter="today">
      <span class="num">${todayCnt}</span><span>오늘 수령</span>
    </button>
    <button data-filter="future">
      <span class="num">${future}</span><span>예정</span>
    </button>
  `;
  $$("[data-filter]", $("#summaryBar")).forEach(b => {
    b.addEventListener("click", () => {
      $("#filterOverdue").checked = b.dataset.filter === "overdue";
      renderPending();
    });
  });

  let pending = pendingAll;
  if (onlyOverdue) pending = pending.filter(r => daysBetween(today(), new Date(r["수령예정일"])) < 0);
  if (onlyStore) pending = pending.filter(r => r["수령방법"] !== "배달");

  const container = $("#pendingResult");
  if (!pending.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="emoji">✅</div>
        <p class="empty-title">미수령 예약이 없습니다</p>
        <p class="empty-body">오늘도 수고하셨습니다.</p>
      </div>`;
    return;
  }

  // 뒷자리+예약일자 기준 그룹핑
  const groups = {};
  pending.forEach(r => {
    const key = `${r["전화번호뒷자리"]}|${r["예약일자"]}`;
    (groups[key] ||= { phone: r["전화번호뒷자리"], reservedAt: r["예약일자"], items: [] }).items.push(r);
  });

  const keys = Object.keys(groups).sort((a, b) => {
    const ma = Math.min(...groups[a].items.map(i => daysBetween(today(), new Date(i["수령예정일"]))));
    const mb = Math.min(...groups[b].items.map(i => daysBetween(today(), new Date(i["수령예정일"]))));
    return ma - mb;
  });

  container.innerHTML = keys.map(k => {
    const g = groups[k];
    const minDiff = Math.min(...g.items.map(i => daysBetween(today(), new Date(i["수령예정일"]))));
    let klass = "pending-group";
    let statusTag;
    if (minDiff < 0) { klass += " overdue"; statusTag = `<span class="chip-tag danger">기한 ${-minDiff}일 지남</span>`; }
    else if (minDiff === 0) { klass += " today"; statusTag = `<span class="chip-tag warn">오늘 수령</span>`; }
    else statusTag = `<span class="chip-tag">D-${minDiff}</span>`;

    return `
      <details class="${klass}" ${minDiff <= 0 ? "open" : ""}>
        <summary>
          <span class="caret">▸</span>
          <div class="name-block">
            <div class="name">뒷자리 ${escapeHtml(g.phone)} <span style="color:var(--muted);font-size:13px;font-weight:600">(${g.items.length}건)</span></div>
            <div class="sub">예약일 ${fmtDate(g.reservedAt)}</div>
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

// ---------- 전체 시트 ----------
const SHEET_STATE = { sortKey: null, sortDir: 1, query: "" };
const NUMERIC_COLS = new Set(["수량", "단가(원)", "할인율(%)", "총금액(원)"]);
const SHEET_HIDDEN_COLS = new Set(["예약번호", "물품ID"]);

function renderSheet() {
  const table = $("#sheetTable");
  if (!RESERVATIONS.length) {
    table.querySelector("thead").innerHTML = "";
    table.querySelector("tbody").innerHTML = "";
    $("#sheetCount").textContent = "0건";
    return;
  }
  const headers = HEADERS.filter(h => !SHEET_HIDDEN_COLS.has(h));
  const q = SHEET_STATE.query.trim().toLowerCase();

  let rows = RESERVATIONS.slice();
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
    const due = new Date(r["수령예정일"]);
    const overdueCell = st === "예약중" && daysBetween(today(), due) < 0;
    return "<tr>" + headers.map(h => {
      const v = r[h] ?? "";
      let cls = "";
      if (NUMERIC_COLS.has(h)) cls += " num";
      if (h === "수령여부") cls += v === "Y" ? " pickup-y" : " pickup-n";
      if (h === "예약상태" && v === "취소됨") cls += " status-cancel";
      if (h === "수령예정일" && overdueCell) cls += " overdue-cell";
      return `<td class="${cls.trim()}">${escapeHtml(v)}</td>`;
    }).join("") + "</tr>";
  }).join("");

  table.querySelector("thead").innerHTML = thead;
  table.querySelector("tbody").innerHTML = tbody;
  $("#sheetCount").textContent = `${rows.length}건 / 총 ${RESERVATIONS.length}건`;

  $$("#sheetTable thead th").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (SHEET_STATE.sortKey === k) SHEET_STATE.sortDir *= -1;
      else { SHEET_STATE.sortKey = k; SHEET_STATE.sortDir = 1; }
      renderSheet();
    });
  });
}

// ---------- 공통 재렌더 ----------
function refreshBadge() {
  const count = RESERVATIONS.filter(r => statusOf(r) === "예약중").length;
  const badge = $("#pendingBadge");
  badge.textContent = count;
  badge.style.display = count ? "inline-block" : "none";
}

function rerenderAll() {
  refreshBadge();
  if ($("#tab-lookup").classList.contains("active")) renderLookup();
  if ($("#tab-pending").classList.contains("active")) renderPending();
  if ($("#tab-sheet").classList.contains("active")) renderSheet();
  // 숨겨진 탭은 다음 진입 시 자동 렌더
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
    _lookupState = { phone: v, selectedSurname: null };
    renderLookup();
  };
  $("#btnSearch").addEventListener("click", run);
  $("#btnClear").addEventListener("click", () => {
    input.value = "";
    _lookupState = { phone: null, selectedSurname: null };
    renderLookup();
    input.focus();
  });
  input.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
    // 자동조회 제거 — 명시적 조회 버튼 사용
  });
}

function bindActions() {
  $("#btnExport").addEventListener("click", () => {
    const csv = toCsv(RESERVATIONS, HEADERS);
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `reservations-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast("CSV 저장됨");
  });

  $("#btnReset").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "로컬 변경 초기화",
      body: "이 기기에서 체크한 수령/취소 기록을 지우고 원본 CSV 상태로 되돌립니다.",
      confirmText: "초기화",
    });
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    init();
  });

  $("#fileUpload").addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const keep = await confirmModal({
      title: "CSV 업로드",
      body: `${file.name} 파일을 불러옵니다.\n이 기기의 수령 기록(오버레이)은 유지됩니다.`,
      confirmText: "불러오기",
    });
    if (!keep) { e.target.value = ""; return; }
    localStorage.setItem(CSV_CACHE_KEY, text);
    loadFromText(text);
    rerenderAll();
    toast("CSV 로드됨");
    e.target.value = "";
  });

  $("#toastUndo").addEventListener("click", () => {
    if (_undoAction) _undoAction();
  });

  $("#filterOverdue").addEventListener("change", renderPending);
  $("#filterStoreOnly").addEventListener("change", renderPending);

  $("#sheetSearch").addEventListener("input", e => {
    SHEET_STATE.query = e.target.value;
    renderSheet();
  });
}

// ---------- 초기화 ----------
function loadFromText(text) {
  const { headers, rows } = parseCsv(text);
  HEADERS = headers;
  const overlay = loadOverlay();
  RESERVATIONS = applyOverlay(rows, overlay);
  _loaded = true;
}

async function init() {
  try {
    const res = await fetch(DEFAULT_CSV_URL + "?v=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    localStorage.setItem(CSV_CACHE_KEY, text);
    loadFromText(text);
  } catch (e) {
    const cached = localStorage.getItem(CSV_CACHE_KEY);
    if (cached) {
      loadFromText(cached);
      toast("오프라인 — 캐시 데이터 사용");
    } else {
      $("#lookupResult").innerHTML = `
        <div class="empty">
          <div class="emoji">⚠️</div>
          <p class="empty-title">데이터 로드 실패</p>
          <p class="empty-body">${escapeHtml(e.message)} — 상단 '⬆ 업로드'로 CSV를 직접 올려주세요.</p>
        </div>`;
      return;
    }
  }
  rerenderAll();
  if (!_lookupState.phone) renderLookup();
}

bindTabs();
bindSearch();
bindActions();
init();
