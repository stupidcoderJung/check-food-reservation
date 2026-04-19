/**
 * GS Fresh 예약관리 — Apps Script Web App
 *
 * 역할:
 *  - 원본 탭(의왕고천점 매트릭스)을 읽어서 "한 예약 = 한 줄"로 정규화
 *  - 날짜별 스냅샷 탭(_AppStatus_YYYY-MM-DD)에 저장
 *  - 우리 앱의 fetch 요청을 받아 읽기/쓰기 처리
 *
 * 엔드포인트 (웹앱 URL):
 *   GET  ?action=snapshots              → 스냅샷 목록 + 활성 날짜
 *   GET  ?action=list&date=YYYY-MM-DD   → 해당 날짜 스냅샷 데이터 (없으면 최신)
 *   POST {action:"import"}              → 원본을 오늘 날짜 스냅샷으로 정규화
 *   POST {action:"pickup", id, state}   → 수령 상태 토글 (Y/N)
 *   POST {action:"cancel", id}          → 예약 취소
 *   POST {action:"restore", id}         → 예약 복원
 */

// ──────────────── 설정 ────────────────
const SOURCE_SHEET_TAB = null; // null = 첫 번째 탭 사용. 원본 탭 이름을 정확히 알면 여기에 지정.
const APP_STATUS_PREFIX = '_AppStatus_';
const CONFIG_SHEET_NAME = '_AppConfig';

// 정규화된 스냅샷 탭의 컬럼 스키마
const SCHEMA = [
  '예약번호',      // R{순번}
  '순번',
  '뒷자리',
  '품목명',
  '단가',
  '수량',
  '합계금액',
  '수령기간',      // 원본 A10셀의 텍스트 (예: "4/20~21 월화 수령")
  '예약상태',      // 예약중 | 수령완료 | 취소됨
  '수령여부',      // Y / N
  '수령일시',
  '처리자',
  '비고',
  '원본순번',      // 다음 import 시 매칭용
  '원본뒷자리',
  '원본품목',
];

// ──────────────── HTTP 핸들러 ────────────────
function doGet(e) {
  try {
    const action = (e.parameter.action || 'list');
    if (action === 'snapshots') return json({ ok: true, snapshots: listSnapshots() });
    if (action === 'list') {
      const date = e.parameter.date || getActiveSnapshotDate();
      if (!date) return json({ ok: true, date: null, headers: SCHEMA, rows: [] });
      const data = readSnapshot(date);
      return json({ ok: true, date, headers: SCHEMA, rows: data });
    }
    return json({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err), stack: err.stack });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;
    if (action === 'import') {
      const result = importFromSource();
      return json({ ok: true, ...result });
    }
    if (action === 'pickup') return json({ ok: true, row: setPickup(body.id, body.state === true || body.state === 'Y') });
    if (action === 'cancel') return json({ ok: true, row: setStatus(body.id, '취소됨', 'N') });
    if (action === 'restore') return json({ ok: true, row: setStatus(body.id, '예약중', 'N') });
    return json({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err), stack: err.stack });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ──────────────── 설정 / 설치 ────────────────
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG_SHEET_NAME)) {
    const sh = ss.insertSheet(CONFIG_SHEET_NAME);
    sh.getRange('A1').setValue('활성스냅샷날짜');
    sh.getRange('B1').setValue('');
    sh.hideSheet();
  }
  SpreadsheetApp.getUi().alert('설정 완료 — 웹앱으로 배포하세요.');
}

function setActiveSnapshotDate(date) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let cfg = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!cfg) {
    cfg = ss.insertSheet(CONFIG_SHEET_NAME);
    cfg.getRange('A1').setValue('활성스냅샷날짜');
    cfg.hideSheet();
  }
  cfg.getRange('B1').setValue(date);
}

function getActiveSnapshotDate() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (cfg) {
    const v = cfg.getRange('B1').getValue();
    if (v) return String(v);
  }
  // 설정 없으면 최신 스냅샷 반환
  const snaps = listSnapshots();
  return snaps.length ? snaps[snaps.length - 1] : null;
}

function listSnapshots() {
  return SpreadsheetApp.getActiveSpreadsheet()
    .getSheets()
    .map(s => s.getName())
    .filter(n => n.startsWith(APP_STATUS_PREFIX))
    .map(n => n.substring(APP_STATUS_PREFIX.length))
    .sort();
}

// ──────────────── 원본 파싱 ────────────────
/**
 * 원본 매트릭스 구조:
 *  - row 10 : C열 = 수령기간 텍스트, D열부터 품목명 (줄바꿈 포함)
 *  - row 21 : D열부터 단가 (해당 품목)
 *  - row 22~: B=순번, C=뒷자리4, D~ = 품목별 수량
 *
 * 반환: [ { 순번, 뒷자리, 품목명, 단가, 수량, 합계금액, 수령기간 }, ... ]
 */
function parseSource() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SOURCE_SHEET_TAB
    ? ss.getSheetByName(SOURCE_SHEET_TAB)
    : ss.getSheets().find(s => !s.getName().startsWith('_') && !s.isSheetHidden());
  if (!sheet) throw new Error('원본 탭을 찾을 수 없습니다');

  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), 25);
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  // 품목 헤더 (10행, D열=인덱스3 ~ )
  const itemHeaderRow = values[9];  // 0-indexed → 10행
  const priceRow = values[20];      // 21행
  const periodText = String(itemHeaderRow[2] || '').trim(); // C10

  const items = []; // { colIdx, name, price }
  for (let c = 3; c < lastCol; c++) {
    const name = String(itemHeaderRow[c] || '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const priceRaw = priceRow[c];
    const price = Number(String(priceRaw).replace(/[^\d.-]/g, '')) || 0;
    items.push({ colIdx: c, name, price });
  }

  // 데이터 행 (22행 = 인덱스21 부터)
  const orders = [];
  for (let r = 21; r < lastRow; r++) {
    const row = values[r];
    const seq = row[1];                              // B열: 순번
    const phoneRaw = row[2];                         // C열: 뒷자리
    if (!seq || phoneRaw === '' || phoneRaw == null) continue;
    const phone4 = String(phoneRaw).padStart(4, '0');
    if (!/^\d{1,4}$/.test(String(phoneRaw).trim()) && !/^\d+$/.test(String(phoneRaw))) continue;

    items.forEach(it => {
      const qty = Number(row[it.colIdx] || 0);
      if (!qty || qty <= 0) return;
      orders.push({
        순번: Number(seq),
        뒷자리: phone4.slice(-4),
        품목명: it.name,
        단가: it.price,
        수량: qty,
        합계금액: qty * it.price,
        수령기간: periodText,
      });
    });
  }
  return orders;
}

// ──────────────── Import (스냅샷 생성) ────────────────
function importFromSource() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orders = parseSource();
  const today = formatDate(new Date());
  const tabName = APP_STATUS_PREFIX + today;

  // 수령 상태 복원용: 기존 탭에서 매칭 키 로드
  const prevStatus = {}; // key = `${뒷자리}|${품목명}|${원본순번}` → {예약상태, 수령여부, 수령일시, 처리자, 비고}
  const existing = ss.getSheetByName(tabName);
  if (existing) {
    const prev = readSnapshot(today);
    prev.forEach(r => {
      const k = `${r['뒷자리']}|${r['품목명']}|${r['원본순번']}`;
      prevStatus[k] = {
        예약상태: r['예약상태'],
        수령여부: r['수령여부'],
        수령일시: r['수령일시'],
        처리자: r['처리자'],
        비고: r['비고'],
      };
    });
    existing.clearContents();
  }

  const sheet = existing || ss.insertSheet(tabName);
  sheet.getRange(1, 1, 1, SCHEMA.length).setValues([SCHEMA]);
  sheet.setFrozenRows(1);

  const rows = orders.map((o, i) => {
    const key = `${o.뒷자리}|${o.품목명}|${o.순번}`;
    const restored = prevStatus[key] || {};
    return [
      'R' + String(o.순번).padStart(4, '0') + '_' + (i + 1),
      o.순번,
      o.뒷자리,
      o.품목명,
      o.단가,
      o.수량,
      o.합계금액,
      o.수령기간,
      restored.예약상태 || '예약중',
      restored.수령여부 || 'N',
      restored.수령일시 || '',
      restored.처리자 || '',
      restored.비고 || '',
      o.순번,
      o.뒷자리,
      o.품목명,
    ];
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, SCHEMA.length).setValues(rows);
  }

  // 컬럼 폭 조정
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(4, 180);

  setActiveSnapshotDate(today);

  return { date: today, count: rows.length, restored: Object.keys(prevStatus).length };
}

function readSnapshot(date) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(APP_STATUS_PREFIX + date);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(1, 1, lastRow, SCHEMA.length).getValues();
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    // Date 객체는 문자열로 변환
    Object.keys(obj).forEach(k => {
      if (obj[k] instanceof Date) obj[k] = formatDateTime(obj[k]);
    });
    return obj;
  });
}

// ──────────────── 상태 업데이트 ────────────────
function setPickup(id, yes) {
  const { sheet, rowIdx, rowData } = findRowById(id);
  const headerIdx = Object.fromEntries(SCHEMA.map((h, i) => [h, i + 1]));
  if (yes) {
    sheet.getRange(rowIdx, headerIdx['수령여부']).setValue('Y');
    sheet.getRange(rowIdx, headerIdx['예약상태']).setValue('수령완료');
    sheet.getRange(rowIdx, headerIdx['수령일시']).setValue(formatDateTime(new Date()));
    sheet.getRange(rowIdx, headerIdx['처리자']).setValue('점주');
  } else {
    sheet.getRange(rowIdx, headerIdx['수령여부']).setValue('N');
    sheet.getRange(rowIdx, headerIdx['예약상태']).setValue('예약중');
    sheet.getRange(rowIdx, headerIdx['수령일시']).setValue('');
    sheet.getRange(rowIdx, headerIdx['처리자']).setValue('');
  }
  return getRow(sheet, rowIdx);
}

function setStatus(id, status, y) {
  const { sheet, rowIdx } = findRowById(id);
  const headerIdx = Object.fromEntries(SCHEMA.map((h, i) => [h, i + 1]));
  sheet.getRange(rowIdx, headerIdx['예약상태']).setValue(status);
  sheet.getRange(rowIdx, headerIdx['수령여부']).setValue(y);
  if (status !== '수령완료') {
    sheet.getRange(rowIdx, headerIdx['수령일시']).setValue('');
    sheet.getRange(rowIdx, headerIdx['처리자']).setValue('');
  }
  return getRow(sheet, rowIdx);
}

function findRowById(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 활성 스냅샷에서 먼저 탐색
  const active = getActiveSnapshotDate();
  if (active) {
    const r = findInSheet(ss.getSheetByName(APP_STATUS_PREFIX + active), id);
    if (r) return r;
  }
  // 폴백: 모든 스냅샷 탭 탐색
  const snaps = listSnapshots();
  for (const d of snaps) {
    const r = findInSheet(ss.getSheetByName(APP_STATUS_PREFIX + d), id);
    if (r) return r;
  }
  throw new Error('예약번호를 찾을 수 없습니다: ' + id);
}

function findInSheet(sheet, id) {
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      const rowIdx = i + 2;
      return { sheet, rowIdx, rowData: null };
    }
  }
  return null;
}

function getRow(sheet, rowIdx) {
  const values = sheet.getRange(rowIdx, 1, 1, SCHEMA.length).getValues()[0];
  const obj = {};
  SCHEMA.forEach((h, i) => {
    let v = values[i];
    if (v instanceof Date) v = formatDateTime(v);
    obj[h] = v;
  });
  return obj;
}

// ──────────────── 헬퍼 ────────────────
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateTime(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

// ──────────────── 디버그용 ────────────────
function debugParse() {
  const orders = parseSource();
  Logger.log('총 ' + orders.length + '건');
  Logger.log(JSON.stringify(orders.slice(0, 5), null, 2));
}

function debugImport() {
  const r = importFromSource();
  Logger.log(JSON.stringify(r));
}
