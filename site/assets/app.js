const CONFIG_KEY = 'table-matcher.config';
const LOCAL_DB_NAME = 'table-matcher-db';
const LOCAL_STORE_NAME = 'datasets';
const PREVIEW_LIMIT = 8;
const RESULT_PREVIEW_LIMIT = 20;


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

function setStatus(target, message, tone = 'info') {
  target.className = `status-box ${tone}`;
  target.textContent = message;
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

function renderSheetOptions(dataset) {
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

function updateDatasetPanel() {
  const dataset = getSelectedDataset();
  renderSheetOptions(dataset);

  if (!dataset) {
    setStatus(el.datasetInfo, '当前没有可用数据表。', 'muted');
    renderPreview(null);
    return;
  }

  const sheet = getSelectedSheet(dataset);
  const message = `已选择 ${dataset.fileName}，包含 ${dataset.sheetNames.length} 个工作表，总计 ${dataset.rowCount} 行数据。当前工作表：${sheet?.name || '无'}`;
  setStatus(el.datasetInfo, message, 'success');
  renderPreview(sheet);
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

function buildSearchIndex(rows) {
  const corpus = [];
  for (const row of rows) {
    const normalizedCells = Object.values(row).map((cell) => normalize(cell)).filter(Boolean);
    if (normalizedCells.length === 0) {
      continue;
    }
    corpus.push(...normalizedCells, normalizedCells.join(''));
  }
  return corpus;
}

async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function parseTableFile(file) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const workbook = ext === 'csv'
    ? XLSX.read(await file.text(), { type: 'string' })
    : XLSX.read(await file.arrayBuffer(), { type: 'array' });

  const sheets = workbook.SheetNames.map((sheetName) => {
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
      searchIndex: buildSearchIndex(rows),
    };
  });

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

function normalizeDataset(record) {
  return {
    id: record.id,
    fileName: record.file_name || record.fileName,
    fileHash: record.file_hash || record.fileHash,
    rowCount: Number(record.row_count || record.rowCount || 0),
    sheetNames: record.sheet_names || record.sheetNames || [],
    sheets: record.sheets_json || record.sheets || [],
    createdAt: record.created_at || record.createdAt || new Date().toISOString(),
    storagePath: record.storage_path || record.storagePath || '',
  };
}

async function persistDataset(file, dataset) {
  if (!state.client) {
    await writeLocalDataset(dataset);
    return dataset;
  }

  const storagePath = `${dataset.fileHash}/${encodeURIComponent(file.name)}`;

  const storage = state.client.storage.from('table-files');
  const uploadResult = await storage.upload(storagePath, file, {
    upsert: true,
    contentType: file.type || 'application/octet-stream',
  });
  if (uploadResult.error) {
    throw uploadResult.error;
  }

  const payload = {
    id: dataset.id,
    file_name: dataset.fileName,
    file_hash: dataset.fileHash,
    row_count: dataset.rowCount,
    sheet_names: dataset.sheetNames,
    sheets_json: dataset.sheets,
    storage_path: storagePath,
  };

  const { data, error } = await state.client
    .from('table_datasets')
    .upsert(payload, { onConflict: 'file_hash' })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return normalizeDataset(data);
}

async function loadDatasets() {
  try {
    if (state.client) {
      const { data, error } = await state.client
        .from('table_datasets')
        .select('id, file_name, file_hash, row_count, sheet_names, sheets_json, storage_path, created_at')
        .order('created_at', { ascending: false });
      if (error) {
        throw error;
      }
      state.datasets = (data || []).map(normalizeDataset);
    } else {
      state.datasets = await readLocalDatasets();
    }


    if (!state.datasets.some((item) => item.id === state.selectedDatasetId)) {
      state.selectedDatasetId = state.datasets[0]?.id || '';
    }
    renderDatasetOptions();
    updateDatasetPanel();
  } catch (error) {
    setStatus(el.datasetInfo, `加载数据表失败：${error.message || '未知错误'}`, 'error');
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
      `已完成 ${file.name} 入库，累计写入 ${storedDataset.rowCount} 行，支持通过文件名再次选择。`,
      'success',
    );
  } catch (error) {
    setStatus(el.tableUploadStatus, `表格上传失败：${error.message || '未知错误'}`, 'error');
  } finally {
    el.uploadTableBtn.disabled = false;
  }
}

async function parseJsonlFile() {
  const file = el.jsonlFileInput.files?.[0];
  if (!file) {
    setStatus(el.jsonlStatus, '请先选择一个 JSONL 文件。', 'warn');
    return;
  }

  el.parseJsonlBtn.disabled = true;
  setStatus(el.jsonlStatus, `正在读取 ${file.name} ...`, 'info');

  try {
    const content = await file.text();
    const tasks = [];
    const skipped = [];

    content.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        const item = JSON.parse(trimmed);
        const task = typeof item.task === 'string' ? item.task.trim() : '';
        if (task) {
          tasks.push({
            lineNumber: index + 1,
            value: task,
            normalized: normalize(task),
          });
        } else {
          skipped.push(`第 ${index + 1} 行缺少 task 字段`);
        }
      } catch {
        skipped.push(`第 ${index + 1} 行不是合法 JSON`);
      }
    });

    state.jsonlTasks = tasks;
    state.skippedJsonlLines = skipped;
    setStatus(
      el.jsonlStatus,
      `已读取 ${tasks.length} 条 task 数据${skipped.length ? `，另外跳过 ${skipped.length} 行异常记录。` : '。'}`,
      skipped.length ? 'warn' : 'success',
    );
  } catch (error) {
    setStatus(el.jsonlStatus, `JSONL 读取失败：${error.message || '未知错误'}`, 'error');
  } finally {
    el.parseJsonlBtn.disabled = false;
  }
}

function renderResultLists(results) {
  const matchedPreview = results.details.filter((item) => item.matched).slice(0, RESULT_PREVIEW_LIMIT);
  const unmatchedPreview = results.details.filter((item) => !item.matched).slice(0, RESULT_PREVIEW_LIMIT);

  el.matchedList.innerHTML = matchedPreview.length
    ? matchedPreview
        .map((item) => `<li class="matched">第 ${item.lineNumber} 行：${escapeHtml(item.value)}</li>`)
        .join('')
    : '<li class="matched">没有匹配成功的 task。</li>';

  el.unmatchedList.innerHTML = unmatchedPreview.length
    ? unmatchedPreview
        .map((item) => `<li class="unmatched">第 ${item.lineNumber} 行：${escapeHtml(item.value)}</li>`)
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

function compareTasks() {
  const dataset = getSelectedDataset();
  const sheet = getSelectedSheet(dataset);

  if (!dataset || !sheet) {
    setStatus(el.datasetInfo, '请先选择一个可用的数据表。', 'warn');
    return;
  }

  if (!state.jsonlTasks.length) {
    setStatus(el.jsonlStatus, '请先读取 JSONL 中的 task 字段。', 'warn');
    return;
  }

  const corpus = Array.isArray(sheet.searchIndex) && sheet.searchIndex.length
    ? sheet.searchIndex
    : buildSearchIndex(sheet.rows || []);

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
}

function bindEvents() {
  el.saveConfigBtn.addEventListener('click', saveConfig);
  el.uploadTableBtn.addEventListener('click', handleTableUpload);
  el.refreshDatasetsBtn.addEventListener('click', loadDatasets);
  el.parseJsonlBtn.addEventListener('click', parseJsonlFile);
  el.compareBtn.addEventListener('click', compareTasks);

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
    const file = el.jsonlFileInput.files?.[0];
    setStatus(el.jsonlStatus, file ? `已选择文件：${file.name}` : '尚未读取 JSONL。', file ? 'info' : 'muted');
  });
}

async function bootstrap() {
  initializeClient();
  bindEvents();
  await loadDatasets();
}

bootstrap();
