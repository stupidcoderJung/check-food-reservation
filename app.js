// 동네슈퍼 예약관리 — 간단 POC
// CSV를 로드하여 localStorage에 상태 오버레이를 저장하고
// 전화번호 뒷자리 4자리로 예약 내역을 조회 / 수령 체크 / 미수령 현황을 제공

const CSV_URL = "reservations.csv";
const STORAGE_KEY = "pickup-overlay-v1";
const TODAY = new Date("2026-04-19"); // POC: 데모 기준일 (실배포 시 new Date() 로 교체)

let RESERVATIONS = []; // 원본 + 오버레이 병합된 현재 상태

// ---------- 유틸 ----------
function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function parseCsv(text) {
  // 간단 CSV 파서 (따옴표 없는 값 기준 — 현재 데이터 형식에 맞춤)
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map(h => r[h] ?? "").join(","));
  }
  return lines.join("\n") + "\n";
}

function loadOverlay() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}

function saveOverlay(overlay) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overlay));
}

function applyOverlay(rows, overlay) {
  return rows.map(r => {
    const o = overlay[r["예약번호"]];
    if (o) return { ...r, ...o };
    return { ...r };
  });
}

function daysBetween(d1, d2) {
  const ms = d2.setHours(0,0,0,0) - d1.setHours(0,0,0,0);
  return Math.round(ms / 86400000);
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

function money(n) {
  return Number(n || 0).toLocaleString("ko-KR") + "원";
}

// ---------- 렌더링 ----------
function renderLookup(phone) {
  const container = $("#lookupResult");
  const items = RESERVATIONS.filter(r => r["전화번호뒷자리"] === phone);

  if (!items.length) {
    container.innerHTML = `
      <div class="empty">
        <p style="font-size:40px;margin:0 0 8px">🔍</p>
        <p><b>${phone}</b>로 예약된 내역이 없습니다.</p>
      </div>`;
    return;
  }

  // 고객 요약
  const name = items[0]["고객성"];
  const total = items.length;
  const done = items.filter(i => i["수령여부"] === "Y").length;
  const amount = items.reduce((s, i) => s + Number(i["총금액(원)"] || 0), 0);

  const headerHtml = `
    <div class="customer-header">
      <div>
        <div class="who">${name}○○ 고객 · ${phone}</div>
        <div class="meta">예약 ${total}건 · 수령 ${done}/${total} · 총 ${money(amount)}</div>
      </div>
      <button class="btn btn-outline btn-sm" id="btnPickupAll">전체 수령 처리</button>
    </div>
  `;

  const itemsHtml = items.map(renderItemCard).join("");
  container.innerHTML = headerHtml + itemsHtml;

  $("#btnPickupAll").addEventListener("click", () => {
    items.forEach(i => setPickup(i["예약번호"], true));
    renderLookup(phone);
    refreshPendingBadge();
    toast(`${items.length}건 수령 처리 완료`);
  });

  $$("[data-action='toggle']", container).forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const cur = RESERVATIONS.find(r => r["예약번호"] === id);
      const next = cur["수령여부"] !== "Y";
      setPickup(id, next);
      renderLookup(phone);
      refreshPendingBadge();
      if ($("#tab-sheet").classList.contains("active")) renderSheet();
      toast(next ? "수령 처리됨" : "수령 취소됨");
    });
  });
}

function renderItemCard(r) {
  const picked = r["수령여부"] === "Y";
  const due = new Date(r["수령예정일"]);
  const diff = daysBetween(new Date(TODAY), due);
  let dueTag = "";
  if (!picked) {
    if (diff < 0) dueTag = `<span class="chip-tag danger">기한 ${-diff}일 지남</span>`;
    else if (diff === 0) dueTag = `<span class="chip-tag warn">오늘 수령</span>`;
    else dueTag = `<span class="chip-tag">D-${diff}</span>`;
  } else {
    dueTag = `<span class="chip-tag success">수령완료</span>`;
  }

  const payTag = r["결제상태"] === "미결제"
    ? `<span class="chip-tag warn">미결제</span>` : "";

  const memo = r["비고"] ? `<span>📝 ${r["비고"]}</span>` : "";

  return `
    <div class="item-card ${picked ? "picked-up" : ""}">
      <div>
        <p class="title">${r["물품명"]} <small style="color:var(--muted);font-weight:500">×${r["수량"]}</small></p>
        <div class="sub">
          ${dueTag}
          ${payTag}
          <span class="chip-tag">${r["카테고리"]}</span>
          <span>수령예정: ${r["수령예정일"]}</span>
          <span>${money(r["총금액(원)"])}</span>
          <span>${r["수령방법"]} · ${r["결제방식"]}</span>
          ${memo}
        </div>
      </div>
      <button
        class="btn ${picked ? "btn-outline" : "btn-success"} btn-sm"
        data-action="toggle"
        data-id="${r["예약번호"]}"
      >${picked ? "취소" : "수령"}</button>
    </div>
  `;
}

function setPickup(id, yes) {
  const overlay = loadOverlay();
  overlay[id] = { "수령여부": yes ? "Y" : "N" };
  saveOverlay(overlay);
  const row = RESERVATIONS.find(r => r["예약번호"] === id);
  if (row) row["수령여부"] = yes ? "Y" : "N";
}

function renderPending() {
  const onlyOverdue = $("#filterOverdue").checked;
  const pending = RESERVATIONS.filter(r => r["수령여부"] !== "Y").filter(r => {
    if (!onlyOverdue) return true;
    const diff = daysBetween(new Date(TODAY), new Date(r["수령예정일"]));
    return diff < 0;
  });

  const container = $("#pendingResult");
  if (!pending.length) {
    container.innerHTML = `
      <div class="empty">
        <p style="font-size:40px;margin:0 0 8px">✅</p>
        <p>미수령 예약이 없습니다.</p>
      </div>`;
    return;
  }

  // 고객(전화번호)별로 그룹핑
  const groups = {};
  pending.forEach(r => {
    const key = r["전화번호뒷자리"];
    (groups[key] ||= { name: r["고객성"], phone: key, items: [] }).items.push(r);
  });

  // 기한 지남 > 오늘 > 미래 순
  const keys = Object.keys(groups).sort((a, b) => {
    const ma = Math.min(...groups[a].items.map(i => daysBetween(new Date(TODAY), new Date(i["수령예정일"]))));
    const mb = Math.min(...groups[b].items.map(i => daysBetween(new Date(TODAY), new Date(i["수령예정일"]))));
    return ma - mb;
  });

  container.innerHTML = keys.map(k => {
    const g = groups[k];
    const minDiff = Math.min(...g.items.map(i => daysBetween(new Date(TODAY), new Date(i["수령예정일"]))));
    let status = "";
    if (minDiff < 0) status = `<span class="chip-tag danger">기한 ${-minDiff}일 지남</span>`;
    else if (minDiff === 0) status = `<span class="chip-tag warn">오늘 수령</span>`;
    else status = `<span class="chip-tag">D-${minDiff}</span>`;

    return `
      <details class="pending-group" ${minDiff <= 0 ? "open" : ""}>
        <summary>
          <span>${g.name}○○ · ${g.phone} <small style="color:var(--muted);font-weight:500"> (${g.items.length}건)</small></span>
          ${status}
        </summary>
        <div class="items">
          ${g.items.map(renderItemCard).join("")}
        </div>
      </details>
    `;
  }).join("");

  $$("[data-action='toggle']", container).forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const cur = RESERVATIONS.find(r => r["예약번호"] === id);
      const next = cur["수령여부"] !== "Y";
      setPickup(id, next);
      renderPending();
      refreshPendingBadge();
      if ($("#tab-sheet").classList.contains("active")) renderSheet();
      toast(next ? "수령 처리됨" : "수령 취소됨");
    });
  });
}

function refreshPendingBadge() {
  const count = RESERVATIONS.filter(r => r["수령여부"] !== "Y").length;
  const badge = $("#pendingBadge");
  badge.textContent = count;
  badge.style.display = count ? "inline-block" : "none";
}

// ---------- 이벤트 바인딩 ----------
function bindTabs() {
  $$(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach(t => t.classList.remove("active"));
      $$(".tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      $("#tab-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "pending") renderPending();
      if (tab.dataset.tab === "sheet") renderSheet();
    });
  });
}

// ---------- 전체 시트 ----------
const SHEET_STATE = { sortKey: null, sortDir: 1, query: "" };
const NUMERIC_COLS = new Set(["수량", "단가(원)", "할인율(%)", "총금액(원)"]);

function renderSheet() {
  const table = $("#sheetTable");
  if (!RESERVATIONS.length) return;
  const headers = Object.keys(RESERVATIONS[0]);
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

  const thead = headers.map(h => {
    let cls = "";
    if (SHEET_STATE.sortKey === h) cls = SHEET_STATE.sortDir === 1 ? "sorted-asc" : "sorted-desc";
    return `<th data-key="${h}" class="${cls}">${h}</th>`;
  }).join("");

  const tbody = rows.map(r => {
    const today = new Date(TODAY);
    const due = new Date(r["수령예정일"]);
    const overdue = r["수령여부"] !== "Y" && daysBetween(new Date(today), due) < 0;
    return "<tr>" + headers.map(h => {
      const v = r[h] ?? "";
      let cls = "";
      if (NUMERIC_COLS.has(h)) cls += " num";
      if (h === "수령여부") cls += v === "Y" ? " pickup-y" : " pickup-n";
      if (h === "수령예정일" && overdue) cls += " overdue";
      return `<td class="${cls.trim()}">${escapeHtml(v)}</td>`;
    }).join("") + "</tr>";
  }).join("");

  table.querySelector("thead").innerHTML = "<tr>" + thead + "</tr>";
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
    renderLookup(v);
  };
  $("#btnSearch").addEventListener("click", run);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") run();
  });
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
    if (input.value.length === 4) run();
  });
}

function bindActions() {
  $("#btnExport").addEventListener("click", () => {
    const csv = toCsv(RESERVATIONS);
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reservations-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("CSV 저장됨");
  });

  $("#btnReset").addEventListener("click", () => {
    if (!confirm("로컬에 저장된 수령 체크를 초기화할까요?")) return;
    localStorage.removeItem(STORAGE_KEY);
    init(); // 재로딩
  });

  $("#filterOverdue").addEventListener("change", renderPending);

  const search = $("#sheetSearch");
  search.addEventListener("input", () => {
    SHEET_STATE.query = search.value;
    renderSheet();
  });
}

// ---------- 초기화 ----------
async function init() {
  try {
    const res = await fetch(CSV_URL + "?v=" + Date.now());
    const text = await res.text();
    const rows = parseCsv(text);
    const overlay = loadOverlay();
    RESERVATIONS = applyOverlay(rows, overlay);
    refreshPendingBadge();
    // 첫 로드 시 조회탭이 활성이므로 결과는 빈 상태 유지
    $("#lookupResult").innerHTML = `
      <div class="empty">
        <p style="font-size:40px;margin:0 0 8px">📱</p>
        <p>전화번호 뒷 4자리를 입력해 예약을 조회하세요.</p>
      </div>`;
  } catch (e) {
    $("#lookupResult").innerHTML = `
      <div class="empty">
        <p>데이터 로드 실패: ${e.message}</p>
      </div>`;
  }
}

bindTabs();
bindSearch();
bindActions();
init();
