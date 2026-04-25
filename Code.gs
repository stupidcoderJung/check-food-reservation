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
 *
 * 원본 시트 구조 관찰 (2026-04-19 시점):
 *   row 1  : 공백
 *   row 2  : "입고"
 *   row 3  : "▣ 의왕고천점" ...
 *   row 4  : "잔여" | 재고 수치들
 *   row 5  : "구분"
 *   row 6  : "예약수량" | 품목별 합계
 *   row 7  : "예약금액" | 품목별 금액
 *   row 8  : "필요수량" ... "총합계" | 총액
 *   row 9  : "발주수량"
 *   row 10 : C=수령기간 텍스트("4/20~21 월화 수령"), D~K=품목명
 *   row 11 : C="번호4자리", D~K=단가  ← 앵커 행
 *   row 12~: B=순번, C=뒷자리, D~K=품목별 수량, Z=행 합계 수량
 *
 *   이 구조는 **사장님이 매주 바꾸실 수 있으므로 위치 고정 금지**.
 *   "번호4자리" 라는 문자열을 앵커로 삼아 상대 위치로 파싱한다.
 */

// ──────────────── 설정 ────────────────
const SOURCE_SHEET_TAB = null; // null = 첫 번째 비(非)시스템 탭 사용. 원본 탭 이름 확정되면 여기에 지정.
const APP_STATUS_PREFIX = '_AppStatus_';
const CONFIG_SHEET_NAME = '_AppConfig';

// "번호4자리" 행을 찾기 위한 앵커 키워드 (사장님이 바꾸시면 여기 추가)
const ANCHOR_KEYWORDS = ['번호4자리', '번호 4자리', '뒷자리4', '번호4', '4자리번호'];

// 품목 영역으로 간주할 컬럼 범위 (최소/최대). 대부분 D~T 사이.
const ITEM_COL_MIN = 4;   // D
const ITEM_COL_MAX = 24;  // X  (Y/Z는 합계류이므로 기본 제외)

// 스냅샷 탭 스키마 — 순서가 곧 컬럼 순서
const SCHEMA = [
  '예약번호',      // R{원본순번}_{품목순서}
  '순번',          // 스냅샷 내 1-based 일련번호 (표시용)
  '원본순번',      // 원본 시트의 B열 순번 (다음 import 매칭용)
  '뒷자리',        // 4자리 0-padded
  '품목명',
  '단가',
  '수량',
  '품목금액',      // 단가 × 수량
  '예약내품목순서', // 한 예약(한 행) 안에서 몇 번째 품목인지 (1-based)
  '행합계수량',    // 원본 Z열: 해당 예약 행의 총 수량 (검증용)
  '수령기간',      // "4/20~21 월화 수령"
  '예약상태',      // 예약중 | 수령완료 | 취소됨
  '수령여부',      // Y / N
  '수령일시',
  '처리자',
  '비고',
  '원본뒷자리',    // raw (padding 전)
  '원본품목',      // 정규화 전 원시 문자열
];

// ──────────────── HTTP 핸들러 ────────────────
function doGet(e) {
  try {
    const action = (e.parameter.action || 'list');
    if (action === 'snapshots') return json({ ok: true, snapshots: listSnapshots(), active: getActiveSnapshotDate() });
    if (action === 'list') {
      const date = e.parameter.date || getActiveSnapshotDate();
      if (!date) return json({ ok: true, date: null, headers: SCHEMA, rows: [] });
      const data = readSnapshot(date);
      return json({ ok: true, date, headers: SCHEMA, rows: data });
    }
    if (action === 'globalList') {
      // 모든 스냅샷 병합. 각 행에 _스냅샷 필드 추가
      const snaps = listSnapshots();
      const all = [];
      snaps.forEach(d => {
        readSnapshot(d).forEach(r => {
          r['_스냅샷'] = d;
          all.push(r);
        });
      });
      return json({ ok: true, headers: SCHEMA.concat(['_스냅샷']), rows: all, snapshots: snaps, active: getActiveSnapshotDate() });
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
      const result = importFromSource(body.label);
      return json({ ok: true, ...result });
    }
    if (action === 'pickup') return json({ ok: true, row: setPickup(body.id, body.state === true || body.state === 'Y', body.date) });
    if (action === 'cancel') return json({ ok: true, row: setStatus(body.id, '취소됨', 'N', body.date) });
    if (action === 'restore') return json({ ok: true, row: setStatus(body.id, '예약중', 'N', body.date) });
    if (action === 'update') return json({ ok: true, row: updateCell(body.id, body.field, body.value, body.date) });
    if (action === 'seedHistorical') return json({ ok: true, ...seedHistorical() });
    if (action === 'clearSeeded') return json({ ok: true, ...clearSeeded() });
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
  // Sheets가 YYYY-MM-DD 문자열을 자동으로 Date로 파싱하지 않도록 plain text로 저장
  cfg.getRange('B1').setNumberFormat('@').setValue(String(date));
}

function getActiveSnapshotDate() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (cfg) {
    const v = cfg.getRange('B1').getValue();
    if (v instanceof Date) return formatDate(v);
    if (v) return String(v);
  }
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

// ═══════════════════════════════════════════════════════════════════════
//                          원본 파싱  (재설계)
// ═══════════════════════════════════════════════════════════════════════
//
// 전략:
//   1. 원본 탭 전체를 읽어서 2D 배열(values)로 확보
//   2. detectAnchorRows(values) 가 "번호4자리" 를 포함한 행(headerRow)을 찾고,
//      그 바로 위 행을 itemNameRow 로 확정한다. (관찰 결과 단가는 headerRow 와
//      같은 행에, 품목명은 그 위 행에 위치)
//   3. extractItemColumns() 가 itemNameRow/headerRow 비교하여 품목이 들어간
//      컬럼의 인덱스, 이름, 단가를 [{colIdx, name, price}] 로 반환
//   4. extractPeriodText() 는 itemNameRow/headerRow/위쪽 몇 행에서 "M/D~D"
//      패턴을 찾아 수령기간 문자열을 뽑는다.
//   5. extractDataRows() 는 headerRow+1 부터 끝까지 훑으며
//      B열(순번이 숫자)·C열(뒷자리가 숫자) 조건을 만족하는 행을
//      "한 예약" 단위로 확정하고, 품목별 수량>0 셀을 주문 레코드로 변환
//
// 모든 단계는 Logger.log 로 흔적을 남긴다.
// ═══════════════════════════════════════════════════════════════════════

function parseSource() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SOURCE_SHEET_TAB
    ? ss.getSheetByName(SOURCE_SHEET_TAB)
    : ss.getSheets().find(s => !s.getName().startsWith('_') && !s.isSheetHidden());
  if (!sheet) throw new Error('원본 탭을 찾을 수 없습니다. SOURCE_SHEET_TAB 설정을 확인하세요.');

  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), 30);
  if (lastRow < 3) throw new Error('원본 탭이 비어있거나 너무 짧습니다 (rows=' + lastRow + ')');

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  Logger.log('[parseSource] sheet=%s rows=%s cols=%s', sheet.getName(), lastRow, lastCol);

  const anchors = detectAnchorRows(values);
  const items   = extractItemColumns(values, anchors);
  const period  = extractPeriodText(values, anchors);
  const orders  = extractDataRows(values, anchors, items, period);

  Logger.log('[parseSource] done. items=%s, orders=%s, period=%s',
             items.length, orders.length, period);
  return { orders, items, anchors, period };
}

/**
 * 앵커 탐지:
 *   - "번호4자리" 또는 유사 키워드를 포함한 행을 headerRowIdx 로 확정
 *   - 그 바로 위 행을 itemNameRowIdx 로 사용 (관찰상 품목명 = 단가 바로 윗 행)
 *   - 단가가 headerRow 에 있는 점을 활용 (headerRow C열은 "번호4자리",
 *     D~ 는 단가 숫자)
 *   반환: { headerRowIdx, itemNameRowIdx, dataStartRowIdx }  (0-based)
 */
function detectAnchorRows(values) {
  const nRows = values.length;
  let headerRowIdx = -1;
  let headerColIdx = -1;

  // 시트 어디에 있든 상관없이 모든 셀에서 키워드 탐색 (최대 상위 40행 정도면 충분)
  const scanLimit = Math.min(nRows, 40);
  outer: for (let r = 0; r < scanLimit; r++) {
    const row = values[r];
    for (let c = 0; c < row.length; c++) {
      const raw = String(row[c] == null ? '' : row[c]).replace(/\s+/g, '');
      if (!raw) continue;
      if (ANCHOR_KEYWORDS.some(k => raw.indexOf(k.replace(/\s+/g, '')) !== -1)) {
        headerRowIdx = r;
        headerColIdx = c;
        break outer;
      }
    }
  }

  if (headerRowIdx < 0) {
    throw new Error(
      '앵커 "번호4자리" 를 찾을 수 없습니다. 원본 탭 상단 40행 내에 해당 키워드가 있어야 합니다.\n' +
      '허용 키워드: ' + ANCHOR_KEYWORDS.join(', ')
    );
  }

  const itemNameRowIdx   = headerRowIdx - 1 >= 0 ? headerRowIdx - 1 : headerRowIdx;
  const dataStartRowIdx  = headerRowIdx + 1;

  Logger.log('[detectAnchorRows] headerRow=%s (sheet row %s), itemNameRow=%s (sheet row %s), dataStart=%s (sheet row %s), anchorCol=%s',
             headerRowIdx, headerRowIdx + 1, itemNameRowIdx, itemNameRowIdx + 1, dataStartRowIdx, dataStartRowIdx + 1, headerColIdx + 1);
  return { headerRowIdx, itemNameRowIdx, dataStartRowIdx, headerColIdx };
}

/**
 * 품목 컬럼 추출:
 *   - itemNameRow 에서 이름(문자열)이 있는 컬럼을 모은다
 *   - 이름이 없지만 단가가 있는 컬럼도 "무명 품목" 으로 수용 (단, 경고 로그)
 *   - 이름 공백은 단일 스페이스로 정리 (셀 내 \n → ' ')
 *   - 컬럼 범위는 ITEM_COL_MIN..ITEM_COL_MAX 이나, 그 안쪽에서 값이 있는
 *     최우측 컬럼까지만 탐색해 빈 꼬리는 버린다
 */
function extractItemColumns(values, anchors) {
  const nameRow  = values[anchors.itemNameRowIdx] || [];
  const priceRow = values[anchors.headerRowIdx]   || [];
  const maxCol   = Math.min(nameRow.length, priceRow.length, ITEM_COL_MAX);

  const items = [];
  for (let c = ITEM_COL_MIN - 1; c < maxCol; c++) {   // 0-based 변환
    const rawName  = nameRow[c]  == null ? '' : String(nameRow[c]);
    const rawPrice = priceRow[c] == null ? '' : String(priceRow[c]);
    const name  = rawName.replace(/\s+/g, ' ').trim();
    const price = parsePrice(rawPrice);

    if (!name && !price) continue; // 둘 다 비면 품목 아님
    if (!name && price) {
      Logger.log('[extractItemColumns] WARN col%s: 단가는 있지만 품목명 없음 (price=%s) → "무명-%s"', c + 1, price, c + 1);
    }

    items.push({
      colIdx: c,
      colLetter: colLetter(c),
      name: name || ('무명-' + colLetter(c)),
      price: price,
    });
  }

  if (items.length === 0) {
    throw new Error('품목 컬럼을 하나도 찾지 못했습니다. 헤더 행(' + (anchors.headerRowIdx + 1) + ') 주변 구조를 확인하세요.');
  }

  Logger.log('[extractItemColumns] items(%s):\n%s',
             items.length,
             items.map(it => '  ' + it.colLetter + ' | ' + it.name + ' | ' + it.price).join('\n'));
  return items;
}

/**
 * 수령기간 텍스트 추출:
 *   - itemNameRow(C열 부근)에 "M/D~D..." 형태 문자열이 있으면 거기서
 *   - 없으면 headerRow 위쪽 5행까지 스캔
 *   - 정규식: /(\d{1,2}\/\d{1,2}(?:~\d{1,2}(?:\/\d{1,2})?)?[^\n\r]*)/
 */
function extractPeriodText(values, anchors) {
  const rx = /(\d{1,2}\/\d{1,2}(?:\s*~\s*\d{1,2}(?:\/\d{1,2})?)?[^\n\r]*)/;

  const scanStart = Math.max(0, anchors.headerRowIdx - 5);
  const scanEnd   = anchors.headerRowIdx; // 포함
  for (let r = scanEnd; r >= scanStart; r--) {
    const row = values[r] || [];
    for (let c = 0; c < Math.min(row.length, ITEM_COL_MAX); c++) {
      const cell = row[c];
      if (cell == null || cell === '') continue;
      const text = String(cell).replace(/\s+/g, ' ').trim();
      const m = rx.exec(text);
      if (m && text.length < 80) {       // 헤더성 텍스트만 (길면 다른 메모일 가능성)
        Logger.log('[extractPeriodText] found at row%s col%s: %s', r + 1, c + 1, text);
        return text;
      }
    }
  }
  Logger.log('[extractPeriodText] NOT FOUND — 빈 문자열 반환');
  return '';
}

/**
 * 데이터 행 추출:
 *   - dataStartRow 부터 lastRow 까지 스캔
 *   - B열(원본순번)이 숫자여야 데이터 행으로 인정
 *   - C열(뒷자리)이 숫자로 해석 가능해야 예약 있음 → 없으면 스킵
 *   - 품목 수량 셀이 모두 0/빈값이면 "예약 없는 빈 행" → 스킵
 *   - 뒷자리는 숫자만 남겨 최대 4자리 zero-pad
 *   - 한 예약 행에서 수량>0 인 품목마다 order 레코드 1건 생성
 *     (예약내품목순서 1,2,3 … 부여)
 */
function extractDataRows(values, anchors, items, period) {
  const nRows = values.length;
  const orders = [];
  const seenSeqs = new Set();
  let skippedEmpty = 0;
  let skippedNoPhone = 0;
  let dupSeqCount = 0;

  // Z열(행 합계 수량) 위치: 컬럼 26 (0-based 25). 안전하게 접근만 하고 없으면 무시.
  const rowTotalColIdx = 25;

  for (let r = anchors.dataStartRowIdx; r < nRows; r++) {
    const row = values[r] || [];
    const seqRaw   = row[1];   // B
    const phoneRaw = row[2];   // C

    // (1) 순번 숫자 검증
    const seqNum = toNumber(seqRaw);
    if (seqNum == null || seqNum <= 0 || !Number.isFinite(seqNum)) continue;

    // (2) 뒷자리 숫자 검증
    const phoneStr = String(phoneRaw == null ? '' : phoneRaw).trim();
    const phoneDigits = phoneStr.replace(/\D/g, '');
    if (!phoneDigits) { skippedNoPhone++; continue; }
    const phone4 = phoneDigits.slice(-4).padStart(4, '0');

    // (3) 품목별 수량 합이 0이면 실예약 없는 행
    const qtyByItem = items.map(it => Math.max(0, toNumber(row[it.colIdx]) || 0));
    const totalQty  = qtyByItem.reduce((a, b) => a + b, 0);
    if (totalQty <= 0) { skippedEmpty++; continue; }

    // (4) 중복 순번 허용하지만 카운트
    if (seenSeqs.has(seqNum)) dupSeqCount++;
    seenSeqs.add(seqNum);

    const rowTotalQty = toNumber(row[rowTotalColIdx]);

    // (5) 예약 내 품목순서 1..N 부여
    let itemNoInOrder = 0;
    items.forEach((it, idx) => {
      const qty = qtyByItem[idx];
      if (qty <= 0) return;
      itemNoInOrder++;
      orders.push({
        원본순번: seqNum,
        뒷자리: phone4,
        원본뒷자리: phoneStr,
        품목명: it.name,
        원본품목: String((values[anchors.itemNameRowIdx] || [])[it.colIdx] || '').trim(),
        단가: it.price,
        수량: qty,
        품목금액: qty * it.price,
        예약내품목순서: itemNoInOrder,
        행합계수량: rowTotalQty == null ? '' : rowTotalQty,
        수령기간: period,
        _sheetRow: r + 1, // 디버그용
      });
    });
  }

  Logger.log('[extractDataRows] orders=%s, distinctSeq=%s, dupSeq=%s, skippedEmpty=%s, skippedNoPhone=%s',
             orders.length, seenSeqs.size, dupSeqCount, skippedEmpty, skippedNoPhone);
  return orders;
}

// ──────────────── 파싱 헬퍼 ────────────────
function parsePrice(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : 0;
  const s = String(raw).replace(/[^\d.\-]/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toNumber(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const s = String(raw).replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function colLetter(idx0) {
  // 0-based → A, B, ... AA, AB...
  let n = idx0;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// ──────────────── Import (스냅샷 생성) ────────────────
function importFromSource(label) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const { orders, items, period } = parseSource();

  const today = formatDate(new Date());
  const labelSafe = sanitizeLabel(label);
  const snapshotId = labelSafe ? `${today}_${labelSafe}` : today;
  const tabName = APP_STATUS_PREFIX + snapshotId;

  // 수령 상태 복원:
  //   기존 스냅샷이 있으면 (원본순번|뒷자리|품목명|예약내품목순서) 조합 기준으로
  //   예약상태/수령여부/수령일시/처리자/비고를 그대로 가져온다.
  const prevStatus = {};
  let restoredCount = 0;
  const existing = ss.getSheetByName(tabName);
  if (existing) {
    const prev = readSnapshot(snapshotId);
    prev.forEach(r => {
      const k = statusKey(r['원본순번'], r['뒷자리'], r['품목명'], r['예약내품목순서']);
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
    const key = statusKey(o.원본순번, o.뒷자리, o.품목명, o.예약내품목순서);
    const restored = prevStatus[key];
    if (restored) restoredCount++;
    const 예약번호 = 'R' + String(o.원본순번).padStart(4, '0') + '-' + o.예약내품목순서;
    return [
      예약번호,
      i + 1,                            // 순번 (스냅샷 내 일련번호)
      o.원본순번,
      o.뒷자리,
      o.품목명,
      o.단가,
      o.수량,
      o.품목금액,
      o.예약내품목순서,
      o.행합계수량,
      o.수령기간,
      (restored && restored.예약상태) || '예약중',
      (restored && restored.수령여부) || 'N',
      (restored && restored.수령일시) || '',
      (restored && restored.처리자)   || '',
      (restored && restored.비고)     || '',
      o.원본뒷자리,
      o.원본품목,
    ];
  });

  if (rows.length) {
    // 뒷자리 컬럼은 텍스트 포맷으로 고정해야 "0043" 형태 보존
    const idxBackDigit = SCHEMA.indexOf('뒷자리') + 1;
    const idxOriginalBack = SCHEMA.indexOf('원본뒷자리') + 1;
    if (idxBackDigit > 0) sheet.getRange(2, idxBackDigit, rows.length, 1).setNumberFormat('@');
    if (idxOriginalBack > 0) sheet.getRange(2, idxOriginalBack, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, SCHEMA.length).setValues(rows);
  }

  // 컬럼 폭 (가독성)
  sheet.setColumnWidth(1, 110);  // 예약번호
  sheet.setColumnWidth(5, 180);  // 품목명
  sheet.setColumnWidth(11, 180); // 수령기간

  setActiveSnapshotDate(snapshotId);

  const summary = {
    date: today,
    snapshotId: snapshotId,
    label: labelSafe || null,
    tabName: tabName,
    count: rows.length,
    itemCount: items.length,
    items: items.map(it => ({ name: it.name, price: it.price, col: it.colLetter })),
    period: period,
    restored: restoredCount,
  };
  Logger.log('[importFromSource] %s', JSON.stringify(summary));
  return summary;
}

// 탭 이름에 사용할 수 있는 라벨로 정규화
// - 구글 시트 탭명 금지 문자: [] * ? / \ : 및 긴 공백
// - 길이 제한 적용
function sanitizeLabel(label) {
  if (!label) return '';
  return String(label)
    .replace(/[\[\]\*\?\/\\:]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

function statusKey(순번, 뒷자리, 품목명, 예약내품목순서) {
  // 뒷자리는 Sheets가 숫자로 자동 변환하는 경우가 있어 4자리 0-padded로 정규화
  const p = String(뒷자리 ?? '').replace(/\D/g, '').padStart(4, '0');
  const name = String(품목명 ?? '').replace(/\s+/g, ' ').trim();
  return [Number(순번) || 순번, p, name, Number(예약내품목순서) || 예약내품목순서].join('|');
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
    Object.keys(obj).forEach(k => {
      if (obj[k] instanceof Date) obj[k] = formatDateTime(obj[k]);
    });
    return obj;
  });
}

// ──────────────── 상태 업데이트 ────────────────
function setPickup(id, yes, date) {
  const { sheet, rowIdx } = findRowById(id, date);
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

function setStatus(id, status, y, date) {
  const { sheet, rowIdx } = findRowById(id, date);
  const headerIdx = Object.fromEntries(SCHEMA.map((h, i) => [h, i + 1]));
  sheet.getRange(rowIdx, headerIdx['예약상태']).setValue(status);
  sheet.getRange(rowIdx, headerIdx['수령여부']).setValue(y);
  if (status !== '수령완료') {
    sheet.getRange(rowIdx, headerIdx['수령일시']).setValue('');
    sheet.getRange(rowIdx, headerIdx['처리자']).setValue('');
  }
  return getRow(sheet, rowIdx);
}

// 인라인 편집용 — 허용된 필드만 수정
const EDITABLE_FIELDS = new Set(['비고', '수량', '예약상태', '수령여부']);

function updateCell(id, field, value, date) {
  if (!EDITABLE_FIELDS.has(field)) {
    throw new Error('수정이 허용되지 않은 필드: ' + field);
  }
  const { sheet, rowIdx } = findRowById(id, date);
  const headerIdx = Object.fromEntries(SCHEMA.map((h, i) => [h, i + 1]));

  if (field === '예약상태') {
    const allowed = ['예약중', '수령완료', '취소됨'];
    if (!allowed.includes(value)) throw new Error('잘못된 예약상태: ' + value);
    sheet.getRange(rowIdx, headerIdx['예약상태']).setValue(value);
    if (value === '수령완료') {
      sheet.getRange(rowIdx, headerIdx['수령여부']).setValue('Y');
      const cur = sheet.getRange(rowIdx, headerIdx['수령일시']).getValue();
      if (!cur) {
        sheet.getRange(rowIdx, headerIdx['수령일시']).setValue(formatDateTime(new Date()));
        sheet.getRange(rowIdx, headerIdx['처리자']).setValue('점주');
      }
    } else {
      sheet.getRange(rowIdx, headerIdx['수령여부']).setValue('N');
      sheet.getRange(rowIdx, headerIdx['수령일시']).setValue('');
      sheet.getRange(rowIdx, headerIdx['처리자']).setValue('');
    }
  } else if (field === '수량') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error('잘못된 수량: ' + value);
    sheet.getRange(rowIdx, headerIdx['수량']).setValue(n);
    const 단가 = Number(sheet.getRange(rowIdx, headerIdx['단가']).getValue() || 0);
    sheet.getRange(rowIdx, headerIdx['품목금액']).setValue(n * 단가);
  } else {
    sheet.getRange(rowIdx, headerIdx[field]).setValue(String(value ?? ''));
  }
  return getRow(sheet, rowIdx);
}

function findRowById(id, date) {
  if (!date) throw new Error('스냅샷(date)이 지정되지 않았습니다: ' + id);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(APP_STATUS_PREFIX + date);
  if (!sheet) throw new Error('스냅샷 탭을 찾을 수 없습니다: ' + date);
  const r = findInSheet(sheet, id);
  if (!r) throw new Error('예약번호를 찾을 수 없습니다: ' + id + ' (스냅샷: ' + date + ')');
  return r;
}

function findInSheet(sheet, id) {
  if (!sheet) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      return { sheet, rowIdx: i + 2, rowData: null };
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

// ──────────────── 공통 유틸 ────────────────
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function formatDateTime(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return y + '-' + m + '-' + day + ' ' + hh + ':' + mm;
}

// ══════════════════════════════════════════════════════════════════
//                        디버그 / 검증 함수
// ══════════════════════════════════════════════════════════════════

/**
 * debugParse:
 *   원본 스캔 결과(앵커·품목·주문)를 Logger 에 상세 출력.
 *   Apps Script 편집기의 "실행" 드롭다운에서 debugParse 선택 → Logger 확인.
 */
function debugParse() {
  Logger.log('===== debugParse START =====');
  const result = parseSource();
  const { orders, items, anchors, period } = result;

  Logger.log('---------- 앵커 ----------');
  Logger.log('headerRow (sheet row): %s', anchors.headerRowIdx + 1);
  Logger.log('itemNameRow (sheet row): %s', anchors.itemNameRowIdx + 1);
  Logger.log('dataStart (sheet row): %s', anchors.dataStartRowIdx + 1);
  Logger.log('anchorCol: %s', anchors.headerColIdx + 1);

  Logger.log('---------- 수령기간 ----------');
  Logger.log('"%s"', period);

  Logger.log('---------- 품목 %s개 ----------', items.length);
  items.forEach(it => {
    Logger.log('  %s (%s열) | 단가 %s', it.name, it.colLetter, it.price);
  });

  Logger.log('---------- 총 주문 %s건 ----------', orders.length);
  Logger.log('(일부 샘플 — 앞 5건)');
  orders.slice(0, 5).forEach((o, i) => {
    Logger.log('  #%s | 원본행%s | 순번%s | 뒷자리%s | %s x%s = %s',
               i + 1, o._sheetRow, o.원본순번, o.뒷자리, o.품목명, o.수량, o.품목금액);
  });
  if (orders.length > 5) {
    Logger.log('(뒤 5건)');
    orders.slice(-5).forEach((o, i) => {
      const idx = orders.length - 5 + i;
      Logger.log('  #%s | 원본행%s | 순번%s | 뒷자리%s | %s x%s = %s',
                 idx + 1, o._sheetRow, o.원본순번, o.뒷자리, o.품목명, o.수량, o.품목금액);
    });
  }
  Logger.log('===== debugParse END =====');
  return { count: orders.length, items: items.length };
}

/**
 * debugImport:
 *   importFromSource 실행 + 결과 요약을 Logger 에 출력.
 */
function debugImport() {
  Logger.log('===== debugImport START =====');
  const r = importFromSource();
  Logger.log('스냅샷 탭: %s', r.tabName);
  Logger.log('날짜: %s', r.date);
  Logger.log('주문 건수: %s', r.count);
  Logger.log('품목 수: %s', r.itemCount);
  Logger.log('수령기간: %s', r.period);
  Logger.log('복원된 수령상태: %s 건', r.restored);
  Logger.log('품목 목록:');
  r.items.forEach(it => Logger.log('  %s (%s열) %s', it.name, it.col, it.price));
  Logger.log('===== debugImport END =====');
  return r;
}

/**
 * debugAnchors:
 *   파싱은 하지 않고 앵커만 빠르게 검증할 때 사용.
 *   원본 구조가 바뀌었을 때 "어디에서 실패하는지"를 즉시 확인.
 */
// ──────────────── Eval용 시딩 ────────────────
// 과거 날짜 가상의 스냅샷을 생성 (원본 시트는 건드리지 않음, 현재 탭도 건드리지 않음)
// 동일 파일 내 _AppStatus_* 탭 중 '_seed_' 태그가 붙은 것만 clear가 삭제
function seedHistorical() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const { orders } = parseSource();
  const staff = ['박미선', '최지훈', '이재현', '김서연'];
  const scenarios = [
    // (snapshotId, 수령률, 취소비율, 수령기간, 기간오프셋(일))
    { id: '2026-04-05',            pickupRate: 1.00, cancelRate: 0.00, period: '4/6~7 월화 수령',   dayOffset: -14, tag: 'seed_all_done' },
    { id: '2026-04-12',            pickupRate: 0.85, cancelRate: 0.05, period: '4/13~14 월화 수령', dayOffset: -7,  tag: 'seed_mostly_done' },
    { id: '2026-04-12_추가입고',   pickupRate: 0.60, cancelRate: 0.10, period: '4/13~14 월화 수령', dayOffset: -7,  tag: 'seed_mixed' },
    { id: '2026-04-19_eval',       pickupRate: 0.30, cancelRate: 0.03, period: '4/20~21 월화 수령', dayOffset: 0,   tag: 'seed_in_progress' },
  ];
  const created = [];
  scenarios.forEach(sc => {
    const tabName = APP_STATUS_PREFIX + sc.id;
    const existing = ss.getSheetByName(tabName);
    if (existing) ss.deleteSheet(existing);
    const sh = ss.insertSheet(tabName);
    sh.getRange(1, 1, 1, SCHEMA.length).setValues([SCHEMA]);
    sh.setFrozenRows(1);
    const rows = orders.map((o, i) => {
      const r = Math.random();
      let 예약상태, 수령여부, 수령일시, 처리자;
      if (r < sc.cancelRate) {
        예약상태 = '취소됨'; 수령여부 = 'N'; 수령일시 = ''; 처리자 = '';
      } else if (r < sc.cancelRate + sc.pickupRate) {
        예약상태 = '수령완료'; 수령여부 = 'Y';
        const base = new Date();
        base.setDate(base.getDate() + sc.dayOffset);
        base.setHours(9 + Math.floor(Math.random() * 11), Math.floor(Math.random() * 60));
        수령일시 = formatDateTime(base);
        처리자 = staff[Math.floor(Math.random() * staff.length)];
      } else {
        예약상태 = '예약중'; 수령여부 = 'N'; 수령일시 = ''; 처리자 = '';
      }
      const memo = sc.tag === 'seed_in_progress' && Math.random() < 0.15 ? 'eval 시딩 주문' : '';
      return [
        'R' + String(o.원본순번).padStart(4, '0') + '-' + o.예약내품목순서,
        i + 1,
        o.원본순번,
        o.뒷자리,
        o.품목명,
        o.단가,
        o.수량,
        o.품목금액,
        o.예약내품목순서,
        o.행합계수량,
        sc.period,
        예약상태,
        수령여부,
        수령일시,
        처리자,
        memo,
        o.원본뒷자리,
        o.원본품목,
      ];
    });
    if (rows.length) sh.getRange(2, 1, rows.length, SCHEMA.length).setValues(rows);
    created.push({ id: sc.id, tab: tabName, count: rows.length, tag: sc.tag });
  });
  return { created, count: created.length };
}

function clearSeeded() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const seedIds = [
    '2026-04-05',
    '2026-04-12',
    '2026-04-12_추가입고',
    '2026-04-19_eval',
    // eval 중 생성된 테스트 잔여물
    '2026-04-19_오전분',
    '2026-04-19_API 테스트',
    '2026-04-19_a-b-c-d',
    '2026-04-19_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  ];
  const deleted = [];
  seedIds.forEach(id => {
    const sh = ss.getSheetByName(APP_STATUS_PREFIX + id);
    if (sh) { ss.deleteSheet(sh); deleted.push(id); }
  });
  return { deleted };
}

function debugAnchors() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SOURCE_SHEET_TAB
    ? ss.getSheetByName(SOURCE_SHEET_TAB)
    : ss.getSheets().find(s => !s.getName().startsWith('_') && !s.isSheetHidden());
  if (!sheet) { Logger.log('원본 탭을 찾지 못함'); return; }
  const values = sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 40), Math.min(sheet.getLastColumn(), 30)).getValues();
  const a = detectAnchorRows(values);
  Logger.log('앵커: %s', JSON.stringify(a));
  Logger.log('itemNameRow 내용: %s', JSON.stringify(values[a.itemNameRowIdx]));
  Logger.log('headerRow 내용: %s', JSON.stringify(values[a.headerRowIdx]));
  Logger.log('dataStart(+0) 내용: %s', JSON.stringify(values[a.dataStartRowIdx]));
}
