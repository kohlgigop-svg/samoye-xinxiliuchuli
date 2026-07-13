const CONFIG_KEY = 'table-matcher.config';
const LOCAL_DB_NAME = 'table-matcher-db';
const LOCAL_STORE_NAME = 'datasets';
const PREVIEW_LIMIT = 8;
const RESULT_PREVIEW_LIMIT = 20;
const STORAGE_BUCKET = 'table-files';
const fileNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
let currentRateRows = [];

const state = {
  client: null,
  datasets: [],
  selectedDatasetId: '',
  selectedSheetName: '',
  jsonlTasks: [],
  skippedJsonlLines: [],
};

const el = {
  supabaseUrl: document.querySelector('#supabaseUrl'),
  supabaseAnonKey: document.querySelector('#supabaseAnonKey'),
  saveConfigBtn: document.querySelector('#saveConfigBtn'),
  backendStatus: document.querySelector('#backendStatus'),
  tableFileInput: document.querySelector('#tableFileInput'),
  uploadTableBtn: document.querySelector('#uploadTableBtn'),
  tableUploadStatus: document.querySelector('#tableUploadStatus'),
  refreshDatasetsBtn: document.querySelector('#refreshDatasetsBtn'),
  datasetSelect: document.querySelector('#datasetSelect'),
  sheetSelect: document.querySelector('#sheetSelect'),
  datasetInfo: document.querySelector('#datasetInfo'),
  previewHead: document.querySelector('#previewHead'),
  previewBody: document.querySelector('#previewBody'),
  jsonlFileInput: document.querySelector('#jsonlFileInput'),
  parseJsonlBtn: document.querySelector('#parseJsonlBtn'),
  jsonlStatus: document.querySelector('#jsonlStatus'),
  compareBtn: document.querySelector('#compareBtn'),
  resultSummary: document.querySelector('#resultSummary'),
  matchedList: document.querySelector('#matchedList'),
  unmatchedList: document.querySelector('#unmatchedList'),
  rawResult: document.querySelector('#rawResult'),
  analysisSummary: document.querySelector('#analysisSummary'),
  rateSummaryTable: document.querySelector('#rateSummaryTable'),
  copyRatesBtn: document.querySelector('#copyRatesBtn'),
  overallTaskDuplicates: document.querySelector('#overallTaskDuplicates'),
  overallStepReasons: document.querySelector('#overallStepReasons'),
  fileCards: document.querySelector('#fileCards'),
  errorList: document.querySelector('#errorList'),
};


function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeKey(key) {
  return String(key ?? '').toLowerCase().replace(/[\s_-]/g, '');
}

function isTaskKey(key) {
  return normalizeKey(key) === 'task';
}

function isReasonKey(key) {
  return ['stepreason', 'stopreason'].includes(normalizeKey(key));
}

function safeText(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walk(child, visit);
  }
}

function normalizeReasonValue(value) {
  return String(value).trim().toLowerCase().replace(/[\s_-]/g, '');
}

function isTargetReasonValue(value) {
  return ['complete', 'calluser'].includes(normalizeReasonValue(value));
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function stripExtension(fileName) {
  return String(fileName).replace(/\.[^.]+$/, '');
}

function sortResultsByFileName(results) {
  return [...results].sort((a, b) => fileNameCollator.compare(stripExtension(a.fileName), stripExtension(b.fileName)));
}

function getGroupedEntries(values) {
  const map = new Map();
  for (const value of values) {
    map.set(value, (map.get(value) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN'));
}

function getDuplicateEntries(values) {
  return getGroupedEntries(values).filter((item) => item.count > 1);
}

function setStatus(target, message, tone = 'info') {
  target.className = `status-box ${tone}`;
  target.textContent = message;
}


function setSectionCollapsed(section, collapsed) {
  section.classList.toggle('is-collapsed', collapsed);
  const toggleBtn = section.querySelector('[data-section-toggle]');
  if (!toggleBtn) {
    return;
  }
  toggleBtn.textContent = collapsed ? '展开' : '收起';
  toggleBtn.setAttribute('aria-expanded', String(!collapsed));
}

function initializeSectionToggles() {
  document.querySelectorAll('[data-section]').forEach((section) => {
    const toggleBtn = section.querySelector('[data-section-toggle]');
    if (!toggleBtn) {
      return;
    }
    setSectionCollapsed(section, section.classList.contains('is-collapsed'));
    toggleBtn.addEventListener('click', () => {
      const nextCollapsed = !section.classList.contains('is-collapsed');
      setSectionCollapsed(section, nextCollapsed);
    });
  });
}

function readStoredConfig() {

  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
  } catch {
    return {};
  }
}

function getConfig() {
  const inlineConfig = window.APP_CONFIG || {};
  const storedConfig = readStoredConfig();
  return {
    supabaseUrl: storedConfig.supabaseUrl || inlineConfig.supabaseUrl || '',
    supabaseAnonKey: storedConfig.supabaseAnonKey || inlineConfig.supabaseAnonKey || '',
  };
}

function saveConfig() {
  const config = {
    supabaseUrl: el.supabaseUrl.value.trim(),
    supabaseAnonKey: el.supabaseAnonKey.value.trim(),
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  initializeClient();
  loadDatasets();
}

function initializeClient() {
  const config = getConfig();
  el.supabaseUrl.value = config.supabaseUrl;
  el.supabaseAnonKey.value = config.supabaseAnonKey;

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    state.client = null;
    setStatus(el.backendStatus, '未填写 Supabase 配置，当前处于浏览器本地演示模式。', 'warn');
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    state.client = null;
    setStatus(el.backendStatus, 'Supabase SDK 加载失败，请刷新页面后重试。', 'error');
    return;
  }

  state.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  setStatus(el.backendStatus, 'Supabase 已连接，上传的表格会写入后端仓库。', 'success');
}

function openLocalDb() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(LOCAL_DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_STORE_NAME)) {
        db.createObjectStore(LOCAL_STORE_NAME, { keyPath: 'fileHash' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readLocalDatasets() {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_STORE_NAME, 'readonly');
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const data = (request.result || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      resolve(data);
    };
  });
}

async function writeLocalDataset(dataset) {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const request = store.put(dataset);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(dataset);
  });
}

function buildSearchIndex(rows) {
  const corpus = new Set();
  for (const row of rows || []) {
    const normalizedCells = Object.values(row || {}).map((cell) => normalize(cell)).filter(Boolean);
    if (normalizedCells.length === 0) {
      continue;
    }
    normalizedCells.forEach((text) => corpus.add(text));
    corpus.add(normalizedCells.join(''));
  }
  return Array.from(corpus);
}

function hydrateSheets(sheets) {
  return (Array.isArray(sheets) ? sheets : []).map((sheet) => {
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const headers = Array.isArray(sheet.headers) && sheet.headers.length
      ? sheet.headers
      : Object.keys(rows[0] || {});
    return {
      name: sheet.name || 'Sheet1',
      headers,
      rows,
      rowCount: Number(sheet.rowCount ?? rows.length),
      searchIndex: Array.isArray(sheet.searchIndex) && sheet.searchIndex.length
        ? sheet.searchIndex
        : null,
    };
  });
}


function getSelectedDataset() {
  return state.datasets.find((item) => item.id === state.selectedDatasetId) || null;
}

function getSelectedSheet(dataset = getSelectedDataset()) {
  if (!dataset || !Array.isArray(dataset.sheets) || dataset.sheets.length === 0) {
    return null;
  }
  return dataset.sheets.find((item) => item.name === state.selectedSheetName) || dataset.sheets[0];
}

function renderDatasetOptions() {
  const options = ['<option value="">请选择已上传的表格文件</option>'];
  for (const dataset of state.datasets) {
    const createdLabel = dataset.createdAt ? new Date(dataset.createdAt).toLocaleString('zh-CN') : '未知时间';
    options.push(
      `<option value="${escapeHtml(dataset.id)}">${escapeHtml(dataset.fileName)} · ${dataset.rowCount} 行 · ${escapeHtml(createdLabel)}</option>`,
    );
  }
  el.datasetSelect.innerHTML = options.join('');
  el.datasetSelect.value = state.selectedDatasetId;
}

function renderSheetOptions(dataset, loading = false) {
  if (loading) {
    el.sheetSelect.disabled = true;
    el.sheetSelect.innerHTML = '<option value="">正在读取工作表...</option>';
    return;
  }

  if (!dataset || !Array.isArray(dataset.sheets) || dataset.sheets.length === 0) {
    el.sheetSelect.disabled = true;
    el.sheetSelect.innerHTML = '<option value="">请先选择表格文件</option>';
    return;
  }

  const currentSheet = getSelectedSheet(dataset);
  const options = dataset.sheets.map(
    (sheet) => `<option value="${escapeHtml(sheet.name)}">${escapeHtml(sheet.name)} · ${sheet.rowCount} 行</option>`,
  );

  el.sheetSelect.disabled = false;
  el.sheetSelect.innerHTML = options.join('');
  el.sheetSelect.value = currentSheet?.name || dataset.sheets[0].name;
  state.selectedSheetName = el.sheetSelect.value;
}

function renderPreview(sheet) {
  if (!sheet || !Array.isArray(sheet.rows) || sheet.rows.length === 0) {
    el.previewHead.innerHTML = '';
    el.previewBody.innerHTML = '<tr><td>当前工作表没有可预览的数据。</td></tr>';
    return;
  }

  const headers = sheet.headers || Object.keys(sheet.rows[0] || {});
  const headHtml = `<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;
  const rowsHtml = sheet.rows.slice(0, PREVIEW_LIMIT).map((row) => {
    const cells = headers.map((header) => `<td>${escapeHtml(row[header] || '')}</td>`).join('');
    return `<tr>${cells}</tr>`;
  });

  el.previewHead.innerHTML = headHtml;
  el.previewBody.innerHTML = rowsHtml.join('');
}

function buildRowsFromMatrix(matrix) {
  const cleaned = (matrix || [])
    .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '').trim()) : []))
    .filter((row) => row.some((cell) => normalize(cell)));

  const width = cleaned.reduce((max, row) => Math.max(max, row.length), 0);
  const headers = Array.from({ length: width }, (_, index) => `列${index + 1}`);
  const rows = cleaned.map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = String(row[index] ?? '');
    });
    return item;
  });

  return { headers, rows };
}

async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function readWorkbook(source, fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext === 'csv'
    ? XLSX.read(await source.text(), { type: 'string' })
    : XLSX.read(await source.arrayBuffer(), { type: 'array' });
}

function extractSheetsFromWorkbook(workbook) {
  return hydrateSheets(workbook.SheetNames.map((sheetName) => {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    const { headers, rows } = buildRowsFromMatrix(matrix);
    return {
      name: sheetName,
      headers,
      rows,
      rowCount: rows.length,
    };
  }));
}

async function parseTableFile(file) {
  const workbook = await readWorkbook(file, file.name);
  const sheets = extractSheetsFromWorkbook(workbook);

  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    fileHash: await hashFile(file),
    rowCount: sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0),
    sheetNames: sheets.map((sheet) => sheet.name),
    sheets,
    createdAt: new Date().toISOString(),
  };
}

async function parseStoredTableFile(blob, fileName) {
  const workbook = await readWorkbook(blob, fileName);
  const sheets = extractSheetsFromWorkbook(workbook);
  return {
    fileName,
    rowCount: sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0),
    sheetNames: sheets.map((sheet) => sheet.name),
    sheets,
  };
}

function normalizeDataset(record) {
  const rawSheets = record.sheets || [];
  return {
    id: record.id,
    fileName: record.file_name || record.fileName,
    fileHash: record.file_hash || record.fileHash,
    rowCount: Number(record.row_count || record.rowCount || 0),
    sheetNames: record.sheet_names || record.sheetNames || [],
    sheets: hydrateSheets(rawSheets),
    createdAt: record.created_at || record.createdAt || new Date().toISOString(),
    storagePath: record.storage_path || record.storagePath || '',
    parsedJsonPath: record.parsed_json_path || record.parsedJsonPath || '',
  };
}

async function loadRemoteDatasetContent(dataset) {
  if (!state.client) {
    return dataset;
  }
  if (Array.isArray(dataset.sheets) && dataset.sheets.length > 0) {
    return dataset;
  }

  if (dataset.storagePath) {
    const { data, error } = await state.client.storage.from(STORAGE_BUCKET).download(dataset.storagePath);
    if (error) {
      throw error;
    }

    const parsed = await parseStoredTableFile(data, dataset.fileName);
    return {
      ...dataset,
      rowCount: Number(parsed.rowCount ?? dataset.rowCount ?? 0),
      sheetNames: parsed.sheetNames || dataset.sheetNames || [],
      sheets: parsed.sheets,
    };
  }

  if (dataset.parsedJsonPath) {
    const { data, error } = await state.client.storage.from(STORAGE_BUCKET).download(dataset.parsedJsonPath);
    if (error) {
      throw error;
    }

    const parsed = JSON.parse(await data.text());
    return {
      ...dataset,
      rowCount: Number(parsed.rowCount ?? dataset.rowCount ?? 0),
      sheetNames: parsed.sheetNames || dataset.sheetNames || [],
      sheets: hydrateSheets(parsed.sheets || []),
    };
  }

  throw new Error('当前数据表缺少远程文件路径，请重新上传该文件。');
}


async function ensureDatasetLoaded(datasetId = state.selectedDatasetId) {
  const index = state.datasets.findIndex((item) => item.id === datasetId);
  if (index === -1) {
    return null;
  }

  const current = state.datasets[index];
  if (!state.client || (Array.isArray(current.sheets) && current.sheets.length > 0)) {
    return current;
  }

  const loaded = await loadRemoteDatasetContent(current);
  state.datasets[index] = loaded;
  return loaded;
}

async function persistDataset(file, dataset) {
  if (!state.client) {
    await writeLocalDataset(dataset);
    return dataset;
  }

  const storage = state.client.storage.from(STORAGE_BUCKET);
  const rawFilePath = `raw/${dataset.fileHash}/${encodeURIComponent(file.name)}`;

  const uploadRawResult = await storage.upload(rawFilePath, file, {
    upsert: true,
    contentType: file.type || 'application/octet-stream',
  });
  if (uploadRawResult.error) {
    throw uploadRawResult.error;
  }

  const payload = {
    id: dataset.id,
    file_name: dataset.fileName,
    file_hash: dataset.fileHash,
    row_count: dataset.rowCount,
    sheet_names: dataset.sheetNames,
    storage_path: rawFilePath,
    parsed_json_path: null,
  };

  const { data, error } = await state.client
    .from('table_datasets')
    .upsert(payload, { onConflict: 'file_hash' })
    .select('id, file_name, file_hash, row_count, sheet_names, storage_path, parsed_json_path, created_at')
    .single();

  if (error) {
    throw error;
  }

  return {
    ...normalizeDataset(data),
    sheets: dataset.sheets,
  };
}

async function loadDatasets() {
  try {
    if (state.client) {
      const { data, error } = await state.client
        .from('table_datasets')
        .select('id, file_name, file_hash, row_count, sheet_names, storage_path, parsed_json_path, created_at')
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }
      state.datasets = (data || []).map(normalizeDataset);
    } else {
      state.datasets = (await readLocalDatasets()).map(normalizeDataset);
    }

    if (!state.datasets.some((item) => item.id === state.selectedDatasetId)) {
      state.selectedDatasetId = state.datasets[0]?.id || '';
      state.selectedSheetName = '';
    }

    renderDatasetOptions();
    await updateDatasetPanel();
  } catch (error) {
    setStatus(el.datasetInfo, `加载数据表失败：${error.message || '未知错误'}`, 'error');
  }
}

async function updateDatasetPanel() {
  try {
    let dataset = getSelectedDataset();
    if (!dataset) {
      renderSheetOptions(null);
      setStatus(el.datasetInfo, '当前没有可用数据表。', 'muted');
      renderPreview(null);
      return;
    }

    if (state.client && (!Array.isArray(dataset.sheets) || dataset.sheets.length === 0) && (dataset.storagePath || dataset.parsedJsonPath)) {
      renderSheetOptions(null, true);
      renderPreview(null);
      setStatus(el.datasetInfo, `正在从后端下载 ${dataset.fileName} 并解析工作表...`, 'info');
      dataset = await ensureDatasetLoaded(dataset.id);
    }

    renderSheetOptions(dataset);
    const sheet = getSelectedSheet(dataset);
    const message = `已选择 ${dataset.fileName}，包含 ${dataset.sheetNames.length} 个工作表，总计 ${dataset.rowCount} 行数据。当前工作表：${sheet?.name || '无'}`;
    setStatus(el.datasetInfo, message, 'success');
    renderPreview(sheet);
  } catch (error) {
    renderSheetOptions(null);
    renderPreview(null);
    setStatus(el.datasetInfo, `读取数据表失败：${error.message || '未知错误'}`, 'error');
  }
}

async function handleTableUpload() {
  const file = el.tableFileInput.files?.[0];
  if (!file) {
    setStatus(el.tableUploadStatus, '请先选择一个表格文件。', 'warn');
    return;
  }

  if (!window.XLSX) {
    setStatus(el.tableUploadStatus, 'XLSX 解析库加载失败，请刷新页面后重试。', 'error');
    return;
  }

  el.uploadTableBtn.disabled = true;
  setStatus(el.tableUploadStatus, `正在解析并写入 ${file.name} ...`, 'info');

  try {
    const parsedDataset = await parseTableFile(file);
    const storedDataset = await persistDataset(file, parsedDataset);
    state.selectedDatasetId = storedDataset.id;
    state.selectedSheetName = storedDataset.sheetNames?.[0] || '';
    await loadDatasets();
    setStatus(
      el.tableUploadStatus,
      `已完成 ${file.name} 入库，累计写入 ${storedDataset.rowCount} 行。远程模式下仅保存原始表格文件，选择时再按需回读解析。`,
      'success',
    );
  } catch (error) {
    setStatus(el.tableUploadStatus, `表格上传失败：${error.message || '未知错误'}`, 'error');
  } finally {
    el.uploadTableBtn.disabled = false;
  }
}


function toRecordItems(value, fileName) {
  const records = Array.isArray(value) ? value : [value];
  return records.map((record, index) => ({
    record,
    lineNumber: null,
    recordIndex: index + 1,
    lineLabel: `${fileName} 第 ${index + 1} 条记录`,
  }));
}

function parseStructuredFile(text, fileName) {
  const normalizedText = String(text || '').replace(/^\uFEFF/, '');
  const trimmed = normalizedText.trim();
  if (!trimmed) {
    throw new Error('文件为空。');
  }

  const warnings = [];

  try {
    const value = JSON.parse(trimmed);
    return {
      items: toRecordItems(value, fileName),
      format: 'JSON',
      warnings,
    };
  } catch {
    // 继续尝试按 JSONL 读取
  }

  const items = [];
  const lines = normalizedText.split(/\r?\n/);


  lines.forEach((line, index) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return;
    }
    try {
      items.push({
        record: JSON.parse(trimmedLine),
        lineNumber: index + 1,
        recordIndex: items.length + 1,
        lineLabel: `${fileName} 第 ${index + 1} 行`,
      });
    } catch {
      warnings.push(`第 ${index + 1} 行不是合法 JSON。`);
    }
  });

  if (!items.length) {
    throw new Error('无法识别为合法 JSON 或 JSONL。');
  }

  if (warnings.length) {
    warnings.unshift(`JSONL 中有 ${warnings.length} 行解析失败，已跳过。`);
  }

  return {
    items,
    format: 'JSONL',
    warnings,
  };
}

function analyzeJsonItems(items, fileName) {
  const tasks = [];
  const taskEntries = [];
  const reasons = [];
  const matchedKeys = new Set();
  let completeOrCallUserCount = 0;

  for (const item of items) {
    let recordMatched = false;
    walk(item.record, (key, value) => {
      if (isTaskKey(key) && safeText(value)) {
        const task = String(value).trim();
        tasks.push(task);
        taskEntries.push({
          sourceFile: fileName,
          lineNumber: item.lineNumber || item.recordIndex,
          lineLabel: item.lineLabel,
          value: task,
          normalized: normalize(task),
        });
        matchedKeys.add(key);
      }
      if (isReasonKey(key) && safeText(value)) {
        const reasonText = String(value).trim();
        reasons.push(reasonText);
        matchedKeys.add(key);
        if (isTargetReasonValue(reasonText)) {
          recordMatched = true;
        }
      }
    });
    if (recordMatched) {
      completeOrCallUserCount += 1;
    }
  }

  return {
    fileName,
    recordCount: items.length,
    tasks,
    taskEntries,
    reasons,
    duplicateTasks: getDuplicateEntries(tasks),
    reasonGroups: getGroupedEntries(reasons),
    completeOrCallUserCount,
    completeOrCallUserRatio: items.length ? (completeOrCallUserCount / items.length) * 100 : 0,
    matchedKeys: Array.from(matchedKeys).sort(),
  };
}

function buildRateRows(results) {
  return results.map((result, index) => ({
    order: index + 1,
    fileName: result.fileName,
    ratio: formatPercent(result.completeOrCallUserRatio),
    matched: result.completeOrCallUserCount,
    total: result.recordCount,
  }));
}

function buildRateCopyPayload(rows) {
  const ratios = rows.map((row) => row.ratio);
  return {
    text: ratios.join('\r\n'),
    html: `<table><tbody>${ratios.map((ratio) => `<tr><td>${escapeHtml(ratio)}</td></tr>`).join('')}</tbody></table>`,
  };
}

async function copyText(text, html = '') {

  try {
    if (html && navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}


function renderDataTable(headers, rows) {
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
  `;
}

function renderEmptyPanel(text) {
  return `<div class="empty-panel">${escapeHtml(text)}</div>`;
}

function renderSummaryCards(items) {
  return items
    .map(
      (item) => `
        <article class="summary-card">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>
      `,
    )
    .join('');
}

function renderRateSummary(results) {
  currentRateRows = buildRateRows(results);
  el.copyRatesBtn.disabled = !currentRateRows.length;
  el.rateSummaryTable.innerHTML = currentRateRows.length
    ? renderDataTable(
        ['排序', '文件名', '占比结果', '命中数 (complete + call user)', '总记录数'],
        currentRateRows.map((row) => [row.order, row.fileName, row.ratio, row.matched, row.total]),
      )
    : renderEmptyPanel('暂无可复制的占比结果。');
}

function renderAnalysisSummary(files, tasks, reasons, results) {
  const duplicateTasks = getDuplicateEntries(tasks);
  const reasonGroups = getGroupedEntries(reasons);
  const totalRecords = results.reduce((sum, item) => sum + item.recordCount, 0);
  const matchedRecords = results.reduce((sum, item) => sum + item.completeOrCallUserCount, 0);
  const overallRatio = totalRecords ? formatPercent((matchedRecords / totalRecords) * 100) : '0.00%';

  el.analysisSummary.className = 'summary-grid';
  el.analysisSummary.innerHTML = renderSummaryCards([
    { label: '已选择文件', value: String(files.length) },
    { label: '成功解析文件', value: String(results.length) },
    { label: '记录总数', value: String(totalRecords) },
    { label: '提取到的 Task', value: String(tasks.length) },
    { label: '重复 Task 组数', value: String(duplicateTasks.length) },
    { label: 'stop_reason 不同值', value: String(reasonGroups.length) },
    { label: 'complete / call user 占比', value: overallRatio },
  ]);
}

function renderAnalysisFiles(results) {
  el.fileCards.innerHTML = results.length
    ? results
        .map((result) => {
          const duplicateBadge = result.duplicateTasks.length
            ? '<span class="analysis-badge danger">存在重复 Task</span>'
            : '<span class="analysis-badge ok">Task 无重复</span>';
          const keysText = result.matchedKeys.length ? result.matchedKeys.join('、') : '未匹配到字段';
          return `
            <article class="analysis-card">
              <div class="analysis-card-head">
                <div>
                  <div class="analysis-card-title">${escapeHtml(result.fileName)}</div>
                  <div class="analysis-meta">格式：${escapeHtml(result.detectedFormat)} ｜ 文件大小：${escapeHtml(result.fileSize)} ｜ 总记录数：${result.recordCount}<br>命中的字段名：${escapeHtml(keysText)}</div>
                </div>
                ${duplicateBadge}
              </div>
              <div class="analysis-mini-grid">
                <div class="analysis-mini"><div class="k">Task 数量</div><div class="v">${result.tasks.length}</div></div>
                <div class="analysis-mini"><div class="k">重复 Task 组数</div><div class="v">${result.duplicateTasks.length}</div></div>
                <div class="analysis-mini"><div class="k">stop_reason 数量</div><div class="v">${result.reasons.length}</div></div>
                <div class="analysis-mini"><div class="k">字段占比</div><div class="v">${formatPercent(result.completeOrCallUserRatio)}</div></div>
              </div>
              <details ${result.duplicateTasks.length ? 'open' : ''}>
                <summary>该文件的重复 Task</summary>
                <div class="details-body">
                  ${result.duplicateTasks.length
                    ? renderDataTable(['重复次数', 'Task'], result.duplicateTasks.map((item) => [item.count, item.value]))
                    : renderEmptyPanel('未发现重复的 Task。')}
                </div>
              </details>
              <details>
                <summary>该文件的 stop_reason 分布</summary>
                <div class="details-body">
                  <div class="formula-card">
                    <div class="label">自动计算结果</div>
                    <div class="value">${formatPercent(result.completeOrCallUserRatio)}</div>
                    <div class="desc">(${result.completeOrCallUserCount} / ${result.recordCount}) × 100% ，即 <code>complete + call user</code> / 该文件总记录数 × 100%</div>
                  </div>
                  ${result.reasonGroups.length
                    ? renderDataTable(['出现次数', 'stop_reason'], result.reasonGroups.map((item) => [item.count, item.value]))
                    : renderEmptyPanel('未发现 stop_reason / StepReason 字段。')}
                </div>
              </details>
            </article>
          `;
        })
        .join('')
    : renderEmptyPanel('暂无逐文件分析结果。');
}

function renderAnalysisErrors(errors) {
  el.errorList.innerHTML = errors.length
    ? errors.map((message) => `<div class="error-item">${escapeHtml(message)}</div>`).join('')
    : renderEmptyPanel('暂无解析问题。');
}

function resetJsonAnalysis() {
  currentRateRows = [];
  if (el.copyRatesBtn) {
    el.copyRatesBtn.disabled = true;
  }
  if (el.analysisSummary) {
    el.analysisSummary.className = 'summary-grid empty-state';
    el.analysisSummary.textContent = '读取 JSON / JSONL 后，这里会展示 Task 重复情况、stop_reason 分布和逐文件占比。';
  }
  if (el.rateSummaryTable) {
    el.rateSummaryTable.innerHTML = renderEmptyPanel('暂无可复制的占比结果。');
  }
  if (el.overallTaskDuplicates) {
    el.overallTaskDuplicates.innerHTML = renderEmptyPanel('暂无数据。');
  }
  if (el.overallStepReasons) {
    el.overallStepReasons.innerHTML = renderEmptyPanel('暂无数据。');
  }
  if (el.fileCards) {
    el.fileCards.innerHTML = renderEmptyPanel('暂无逐文件分析结果。');
  }
  if (el.errorList) {
    el.errorList.innerHTML = renderEmptyPanel('暂无解析问题。');
  }
}

function renderJsonAnalysis(files, tasks, reasons, results, errors) {
  if (!results.length) {
    resetJsonAnalysis();
    renderAnalysisErrors(errors);
    return;
  }

  renderAnalysisSummary(files, tasks, reasons, results);
  renderRateSummary(results);

  const duplicateTasks = getDuplicateEntries(tasks);
  const reasonGroups = getGroupedEntries(reasons);

  el.overallTaskDuplicates.innerHTML = duplicateTasks.length
    ? renderDataTable(['重复次数', 'Task'], duplicateTasks.map((item) => [item.count, item.value]))
    : renderEmptyPanel('未发现重复的 Task。');

  el.overallStepReasons.innerHTML = reasonGroups.length
    ? renderDataTable(['出现次数', 'stop_reason'], reasonGroups.map((item) => [item.count, item.value]))
    : renderEmptyPanel('未发现 stop_reason / StepReason 字段。');

  renderAnalysisFiles(results);
  renderAnalysisErrors(errors);
}

async function parseJsonlFile() {
  const files = Array.from(el.jsonlFileInput.files || []);
  if (!files.length) {
    setStatus(el.jsonlStatus, '请先选择一个或多个 JSON / JSONL 文件。', 'warn');
    return;
  }

  el.parseJsonlBtn.disabled = true;
  resetJsonAnalysis();
  setStatus(el.jsonlStatus, `正在读取并分析 ${files.length} 个 JSON / JSONL 文件 ...`, 'info');

  try {
    const taskEntries = [];
    const overallTasks = [];
    const overallReasons = [];
    const errors = [];
    const results = [];

    for (const file of files) {
      try {
        const content = await file.text();
        const parsed = parseStructuredFile(content, file.name);
        const analysis = analyzeJsonItems(parsed.items, file.name);
        results.push({
          ...analysis,
          detectedFormat: parsed.format,
          fileSize: formatSize(file.size),
        });
        taskEntries.push(...analysis.taskEntries);
        overallTasks.push(...analysis.tasks);
        overallReasons.push(...analysis.reasons);
        errors.push(...parsed.warnings.map((warning) => `${file.name}：${warning}`));
      } catch (error) {
        errors.push(`${file.name}：${error.message || '未知错误'}`);
      }
    }

    const sortedResults = sortResultsByFileName(results);
    state.jsonlTasks = taskEntries;
    state.skippedJsonlLines = errors;
    renderJsonAnalysis(files, overallTasks, overallReasons, sortedResults, errors);

    if (!sortedResults.length) {
      const firstError = errors[0] ? `首条原因：${errors[0]}` : '请检查文件格式。';
      setStatus(el.jsonlStatus, `未能从所选文件中解析出可用记录。${firstError}`, 'error');
      return;
    }


    const fileSummary = files.length === 1 ? `文件 ${files[0].name}` : `${files.length} 个文件`;
    setStatus(
      el.jsonlStatus,
      `已从${fileSummary}中提取 ${taskEntries.length} 条 task，并完成字段占比分析${errors.length ? `，另有 ${errors.length} 条解析提示。` : '。'}`,
      errors.length ? 'warn' : 'success',
    );
  } catch (error) {
    resetJsonAnalysis();
    setStatus(el.jsonlStatus, `JSON / JSONL 读取失败：${error.message || '未知错误'}`, 'error');
  } finally {
    el.parseJsonlBtn.disabled = false;
  }
}



function renderResultLists(results) {
  const matchedPreview = results.details.filter((item) => item.matched).slice(0, RESULT_PREVIEW_LIMIT);
  const unmatchedPreview = results.details.filter((item) => !item.matched).slice(0, RESULT_PREVIEW_LIMIT);

  el.matchedList.innerHTML = matchedPreview.length
    ? matchedPreview
        .map((item) => `<li class="matched">${escapeHtml(item.lineLabel || `第 ${item.lineNumber} 行`)}：${escapeHtml(item.value)}</li>`)
        .join('')
    : '<li class="matched">没有匹配成功的 task。</li>';

  el.unmatchedList.innerHTML = unmatchedPreview.length
    ? unmatchedPreview
        .map((item) => `<li class="unmatched">${escapeHtml(item.lineLabel || `第 ${item.lineNumber} 行`)}：${escapeHtml(item.value)}</li>`)
        .join('')
    : '<li class="matched">全部 task 均已匹配。</li>';
}


function renderSummary(results) {
  const summaryItems = [
    { label: 'task 总数', value: results.total },
    { label: '匹配成功', value: results.matchedCount },
    { label: '未匹配', value: results.unmatchedCount },
    { label: '匹配占比', value: `${results.ratio}%` },
  ];
  el.resultSummary.className = 'summary-grid';
  el.resultSummary.innerHTML = summaryItems
    .map(
      (item) => `
        <article class="summary-card">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>
      `,
    )
    .join('');
}

function formatSize(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

async function compareTasks() {

  try {
    let dataset = getSelectedDataset();
    if (!dataset) {
      setStatus(el.datasetInfo, '请先选择一个可用的数据表。', 'warn');
      return;
    }

    dataset = await ensureDatasetLoaded(dataset.id);
    const sheet = getSelectedSheet(dataset);
    if (!sheet) {
      setStatus(el.datasetInfo, '当前工作表尚未完成读取，请稍后重试。', 'warn');
      return;
    }

    if (!state.jsonlTasks.length) {
      setStatus(el.jsonlStatus, '请先读取 JSON / JSONL 中的 task 字段。', 'warn');
      return;
    }


    if (!Array.isArray(sheet.searchIndex) || !sheet.searchIndex.length) {
      sheet.searchIndex = buildSearchIndex(sheet.rows || []);
    }
    const corpus = sheet.searchIndex;


    const details = state.jsonlTasks.map((item) => ({
      ...item,
      matched: corpus.some((text) => item.normalized && text.includes(item.normalized)),
    }));

    const matchedCount = details.filter((item) => item.matched).length;
    const total = details.length;
    const ratio = total ? ((matchedCount / total) * 100).toFixed(2) : '0.00';
    const results = {
      fileName: dataset.fileName,
      sheetName: sheet.name,
      total,
      matchedCount,
      unmatchedCount: total - matchedCount,
      ratio,
      allMatched: matchedCount === total,
      skippedJsonlLines: state.skippedJsonlLines,
      details,
    };

    renderSummary(results);
    renderResultLists(results);
    el.rawResult.textContent = JSON.stringify(results, null, 2);
  } catch (error) {
    setStatus(el.datasetInfo, `匹配前读取数据失败：${error.message || '未知错误'}`, 'error');
  }
}

function bindEvents() {
  el.saveConfigBtn.addEventListener('click', saveConfig);
  el.uploadTableBtn.addEventListener('click', handleTableUpload);
  el.refreshDatasetsBtn.addEventListener('click', loadDatasets);
  el.parseJsonlBtn.addEventListener('click', parseJsonlFile);
  el.compareBtn.addEventListener('click', compareTasks);
  el.copyRatesBtn.addEventListener('click', async () => {
    if (!currentRateRows.length) {
      return;
    }
    const payload = buildRateCopyPayload(currentRateRows);
    const copied = await copyText(payload.text, payload.html);
    const originalText = el.copyRatesBtn.textContent;
    el.copyRatesBtn.textContent = copied ? '已复制占比列' : '复制失败';
    setTimeout(() => {
      el.copyRatesBtn.textContent = originalText;
    }, 1500);
  });


  el.datasetSelect.addEventListener('change', (event) => {
    state.selectedDatasetId = event.target.value;
    state.selectedSheetName = '';
    updateDatasetPanel();
  });

  el.sheetSelect.addEventListener('change', (event) => {
    state.selectedSheetName = event.target.value;
    updateDatasetPanel();
  });

  el.tableFileInput.addEventListener('change', () => {
    const file = el.tableFileInput.files?.[0];
    setStatus(el.tableUploadStatus, file ? `已选择文件：${file.name}` : '尚未选择文件。', file ? 'info' : 'muted');
  });

  el.jsonlFileInput.addEventListener('change', () => {
    const files = Array.from(el.jsonlFileInput.files || []);
    if (!files.length) {
      setStatus(el.jsonlStatus, '尚未读取 JSON / JSONL。', 'muted');
      return;
    }
    const previewNames = files.slice(0, 3).map((file) => file.name).join('、');
    const suffix = files.length > 3 ? ' 等' : '';
    const label = files.length === 1 ? `已选择文件：${files[0].name}` : `已选择 ${files.length} 个文件：${previewNames}${suffix}`;
    setStatus(el.jsonlStatus, label, 'info');
  });

  initializeSectionToggles();
}


async function bootstrap() {
  initializeClient();
  bindEvents();
  resetJsonAnalysis();
  await loadDatasets();
}


bootstrap();
