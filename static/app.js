const form = document.getElementById('analyze-form');
const scopeInput = document.getElementById('scope');
const providerInput = document.getElementById('provider');
const scopeSwitch = document.getElementById('scope-switch');
const providerGrid = document.getElementById('provider-grid');
const singleDrop = document.getElementById('single-drop');
const folderDrop = document.getElementById('folder-drop');
const singleVideoInput = document.getElementById('single-video-input');
const folderVideoInput = document.getElementById('folder-video-input');
const selectionPreview = document.getElementById('selection-preview');
const selectionModeNote = document.getElementById('selection-mode-note');
const providerSummary = document.getElementById('provider-summary');
const ollamaFields = document.getElementById('ollama-fields');
const geminiFields = document.getElementById('gemini-fields');
const statusHeadline = document.getElementById('status-headline');
const statusLog = document.getElementById('status-log');
const metaChips = document.getElementById('meta-chips');
const progressBar = document.getElementById('progress-bar');
const batchSummary = document.getElementById('batch-summary');
const itemList = document.getElementById('item-list');
const queueSubtitle = document.getElementById('queue-subtitle');
const resultSubtitle = document.getElementById('result-subtitle');
const resultMetrics = document.getElementById('result-metrics');
const resultAnalysis = document.getElementById('result-analysis');
const submitButton = document.getElementById('submit-button');
const submitHint = document.getElementById('submit-hint');
const copyCurrentButton = document.getElementById('copy-current');

let pollTimer = null;
let config = null;
let currentJob = null;
let selectedItemIndex = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function terminalStatus(status) {
  return ['completed', 'failed', 'completed_with_errors'].includes(status);
}

function statusLabel(status) {
  const labels = {
    queued: '排队中',
    running: '处理中',
    completed: '已完成',
    failed: '失败',
    completed_with_errors: '部分失败',
  };
  return labels[status] || status;
}

function stageLabel(stage) {
  const labels = {
    queued: '等待执行',
    starting: '准备中',
    probing: '读取元数据',
    extracting_frames: '抽取关键帧',
    calling_ollama: '发送到 Ollama',
    uploading_video: '上传视频',
    processing_video: '服务端处理中',
    calling_gemini: '调用 Gemini',
    completed: '处理完成',
    failed: '处理失败',
  };
  return labels[stage] || stage || '等待执行';
}

function formatSeconds(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'n/a';
  }
  return `${Number(value).toFixed(2)} s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const decimals = size >= 100 || index === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[index]}`;
}

function formatVideoMeta(video) {
  if (!video) {
    return [];
  }
  const items = [];
  if (video.duration_seconds) items.push({ label: '视频时长', value: `${video.duration_seconds}s` });
  if (video.width && video.height) items.push({ label: '分辨率', value: `${video.width} x ${video.height}` });
  if (video.video_codec) items.push({ label: '视频编码', value: video.video_codec });
  if (video.audio_codec) items.push({ label: '音频编码', value: video.audio_codec });
  if (video.mime_type) items.push({ label: 'MIME', value: video.mime_type });
  return items;
}

function isVideoFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('video/')) return true;
  return /\.(mp4|mov|m4v|avi|mkv|webm|mpeg|mpg|3gp|ts|mts)$/i.test(file.name);
}

function getScope() {
  return scopeInput.value;
}

function getProvider() {
  return providerInput.value;
}

function getSelectedFiles() {
  if (getScope() === 'folder') {
    return Array.from(folderVideoInput.files || [])
      .filter(isVideoFile)
      .sort((a, b) => {
        const left = (a.webkitRelativePath || a.name).toLowerCase();
        const right = (b.webkitRelativePath || b.name).toLowerCase();
        return left.localeCompare(right);
      });
  }
  return Array.from(singleVideoInput.files || []).filter(isVideoFile).slice(0, 1);
}

function setSubmitButtonIdleText() {
  submitButton.textContent = getScope() === 'folder' ? '开始批量分析' : '开始分析';
}

function setScope(scope) {
  scopeInput.value = scope;
  Array.from(scopeSwitch.querySelectorAll('.segment')).forEach((button) => {
    button.classList.toggle('active', button.dataset.scope === scope);
  });
  singleDrop.classList.toggle('hidden', scope !== 'single');
  folderDrop.classList.toggle('hidden', scope !== 'folder');
  selectionModeNote.textContent = scope === 'single' ? '当前为单视频模式' : '当前为整文件夹批量模式';
  submitHint.textContent = scope === 'single'
    ? '单视频适合细调 Prompt 或验证模型输出。'
    : '批量任务会顺序处理文件夹中的每个视频，并把结果留在队列里。';
  if (scope === 'single') {
    folderVideoInput.value = '';
  } else {
    singleVideoInput.value = '';
  }
  setSubmitButtonIdleText();
  updateSelectionPreview();
}

function setProvider(provider) {
  providerInput.value = provider;
  Array.from(providerGrid.querySelectorAll('.provider-card')).forEach((button) => {
    button.classList.toggle('active', button.dataset.provider === provider);
  });
  const useGemini = provider === 'gemini';
  ollamaFields.classList.toggle('hidden', useGemini);
  geminiFields.classList.toggle('hidden', !useGemini);
}

function renderChips(items) {
  metaChips.innerHTML = '';
  items.forEach((item) => {
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = item;
    metaChips.appendChild(span);
  });
}

function renderMetrics(result) {
  resultMetrics.innerHTML = '';
  if (!result) {
    return;
  }

  const metrics = [
    { label: '提供方', value: result.provider_label || result.provider || 'n/a' },
    { label: '模型', value: result.model || 'n/a' },
    { label: '处理耗时', value: formatSeconds(result.job_seconds_total || result.processing_seconds) },
  ];

  if (result.provider === 'ollama') {
    metrics.push({ label: '抽帧 FPS', value: String(result.effective_fps ?? 'n/a') });
    metrics.push({ label: '关键帧数量', value: String(result.frame_count ?? 'n/a') });
  }

  formatVideoMeta(result.video).forEach((item) => metrics.push(item));

  metrics.forEach((metric) => {
    const card = document.createElement('div');
    card.className = 'metric-card';
    card.innerHTML = `<span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong>`;
    resultMetrics.appendChild(card);
  });
}

function renderAnalysisText(text, subtitle) {
  resultSubtitle.textContent = subtitle;
  resultAnalysis.classList.remove('empty');
  resultAnalysis.textContent = text;
}

function renderEmptyDetail(message = '选择并运行任务后，这里会展示当前选中视频的分析结果。') {
  resultSubtitle.textContent = '暂无结果';
  resultMetrics.innerHTML = '';
  resultAnalysis.classList.add('empty');
  resultAnalysis.textContent = message;
  copyCurrentButton.disabled = true;
}

function selectDefaultItem(job) {
  if (!job?.items?.length) {
    selectedItemIndex = null;
    return;
  }
  if (
    selectedItemIndex !== null &&
    selectedItemIndex >= 0 &&
    selectedItemIndex < job.items.length
  ) {
    return;
  }
  const preferredIndex = job.items.findIndex((item) => item.status === 'completed');
  selectedItemIndex = preferredIndex >= 0 ? preferredIndex : 0;
}

function renderQueue(job) {
  const items = job?.items || [];
  itemList.innerHTML = '';

  if (!items.length) {
    itemList.innerHTML = '<div class="empty-state">提交任务后，这里会出现单视频或文件夹里的所有视频条目。</div>';
    return;
  }

  items.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'queue-item';
    if (index === selectedItemIndex) {
      button.classList.add('active');
    }

    const relativePath = item.relative_path || item.filename || `item-${index + 1}`;
    const duration = item.result?.job_seconds_total ? formatSeconds(item.result.job_seconds_total) : stageLabel(item.stage);
    const metaLine = item.result?.video?.duration_seconds
      ? `${item.result.video.duration_seconds}s`
      : item.status === 'failed'
        ? '查看错误信息'
        : '等待结果';

    button.innerHTML = `
      <div class="queue-head">
        <strong>${escapeHtml(relativePath)}</strong>
        <span class="queue-status queue-status-${item.status}">${statusLabel(item.status)}</span>
      </div>
      <div class="queue-meta">
        <span>${escapeHtml(duration)}</span>
        <span>${escapeHtml(metaLine)}</span>
      </div>
    `;

    button.addEventListener('click', () => {
      selectedItemIndex = index;
      renderQueue(job);
      renderDetail(job);
    });
    itemList.appendChild(button);
  });
}

function renderBatchSummary(job) {
  const summary = job?.summary || { total: 0, queued: 0, running: 0, completed: 0, failed: 0 };
  batchSummary.innerHTML = '';

  const cards = [
    { label: '总文件数', value: summary.total ?? 0 },
    { label: '待处理', value: summary.queued ?? 0 },
    { label: '处理中', value: summary.running ?? 0 },
    { label: '已完成', value: summary.completed ?? 0 },
    { label: '失败', value: summary.failed ?? 0 },
  ];

  cards.forEach((card) => {
    const node = document.createElement('div');
    node.className = 'summary-card';
    node.innerHTML = `<span>${escapeHtml(card.label)}</span><strong>${escapeHtml(card.value)}</strong>`;
    batchSummary.appendChild(node);
  });
}

function renderJobOverview(job) {
  const summary = job?.summary || { total: 0, completed: 0, failed: 0 };
  const lines = [
    `当前任务模式：${job.mode === 'folder' ? '文件夹批量' : '单视频'}`,
    `处理状态：${statusLabel(job.status)}`,
    `已完成 ${summary.completed || 0} 个，失败 ${summary.failed || 0} 个，总计 ${summary.total || 0} 个。`,
    '',
    '从左侧队列选择一条视频，可查看该文件的详细分析结果。',
  ];
  renderMetrics(job.result || null);
  renderAnalysisText(lines.join('\n'), '任务概览');
  copyCurrentButton.disabled = true;
}

function renderDetail(job) {
  const items = job?.items || [];
  if (!items.length || selectedItemIndex === null || !items[selectedItemIndex]) {
    if (job?.mode === 'folder' && job?.result) {
      renderJobOverview(job);
      return;
    }
    renderEmptyDetail();
    return;
  }

  const item = items[selectedItemIndex];
  const label = item.relative_path || item.filename || '未命名视频';

  if (item.status === 'completed' && item.result) {
    renderMetrics(item.result);
    renderAnalysisText(item.result.analysis || '模型未返回正文。', label);
    copyCurrentButton.disabled = !(item.result.analysis || '').trim();
    return;
  }

  if (item.status === 'failed') {
    resultMetrics.innerHTML = '';
    renderAnalysisText(item.error || '未知错误', `${label} · 失败`);
    copyCurrentButton.disabled = false;
    return;
  }

  resultMetrics.innerHTML = '';
  const logs = (item.logs || []).join('\n') || '处理中…';
  renderAnalysisText(logs, `${label} · ${statusLabel(item.status)}`);
  copyCurrentButton.disabled = true;
}

function renderStatus(job) {
  currentJob = job;
  const summary = job.summary || { total: 0, processed: 0, completed: 0, failed: 0 };
  const processed = summary.processed ?? 0;
  const total = summary.total ?? 0;
  const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

  statusHeadline.textContent = `${statusLabel(job.status)} · ${processed}/${total} 已处理`;
  statusLog.textContent = (job.logs || []).join('\n') || '处理中…';
  progressBar.style.width = `${percentage}%`;

  const chips = [
    `模式: ${job.mode === 'folder' ? '文件夹批量' : '单视频'}`,
    `后端: ${job.provider === 'ollama' ? 'Ollama' : 'Gemini'}`,
    `状态: ${statusLabel(job.status)}`,
  ];
  if (job.current_item_label) {
    chips.push(`当前: ${job.current_item_label}`);
  }
  renderChips(chips);

  queueSubtitle.textContent = job.mode === 'folder'
    ? `本次批量任务共 ${total} 个视频。点击条目可查看单个结果。`
    : '当前任务只有一个视频，也会保留为单独条目供你查看结果。';

  renderBatchSummary(job);
  selectDefaultItem(job);
  renderQueue(job);
  renderDetail(job);

  if (terminalStatus(job.status)) {
    submitButton.disabled = false;
    setSubmitButtonIdleText();
  }
}

function makeFact(label, value) {
  const node = document.createElement('div');
  node.className = 'selection-fact';
  node.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
  return node;
}

function updateSelectionPreview() {
  const files = getSelectedFiles();
  selectionPreview.innerHTML = '';

  if (!files.length) {
    selectionPreview.innerHTML = '<div class="selection-empty">还没有选择文件。</div>';
    return;
  }

  const header = document.createElement('div');
  header.className = 'selection-header';

  const facts = document.createElement('div');
  facts.className = 'selection-facts';
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);

  if (getScope() === 'single') {
    const file = files[0];
    header.innerHTML = `<strong>${escapeHtml(file.name)}</strong><span>单视频输入</span>`;
    facts.appendChild(makeFact('文件大小', formatBytes(file.size || 0)));
    facts.appendChild(makeFact('文件类型', file.type || 'video/*'));
    selectionPreview.appendChild(header);
    selectionPreview.appendChild(facts);
    return;
  }

  const samplePath = files[0].webkitRelativePath || files[0].name;
  const rootFolder = samplePath.includes('/') ? samplePath.split('/')[0] : '已选文件夹';
  header.innerHTML = `<strong>${escapeHtml(rootFolder)}</strong><span>文件夹批量输入</span>`;
  facts.appendChild(makeFact('视频数量', String(files.length)));
  facts.appendChild(makeFact('累计大小', formatBytes(totalBytes)));

  const list = document.createElement('div');
  list.className = 'selection-list';
  files.slice(0, 6).forEach((file) => {
    const row = document.createElement('div');
    row.className = 'selection-row';
    const path = file.webkitRelativePath || file.name;
    row.innerHTML = `<span>${escapeHtml(path)}</span><em>${escapeHtml(formatBytes(file.size || 0))}</em>`;
    list.appendChild(row);
  });

  if (files.length > 6) {
    const more = document.createElement('div');
    more.className = 'selection-more';
    more.textContent = `另外还有 ${files.length - 6} 个视频文件。`;
    list.appendChild(more);
  }

  selectionPreview.appendChild(header);
  selectionPreview.appendChild(facts);
  selectionPreview.appendChild(list);
}

async function fetchConfig() {
  const response = await fetch('/api/config');
  const data = await response.json();
  config = data;

  const ollama = data.providers.ollama;
  const gemini = data.providers.gemini;
  providerSummary.textContent = ollama.ready
    ? `Ollama 已就绪，当前本地模型为 ${ollama.model}。也可以切换到 Gemini 路线。`
    : `Ollama 检查失败：${ollama.error || '本地模型不可用'}。仍可切换到 Gemini。`;

  document.getElementById('fps').value = ollama.default_fps;
  document.getElementById('max_frames').value = ollama.default_max_frames;
  document.getElementById('gemini_model').value = gemini.model;
}

async function pollJob(jobId) {
  const response = await fetch(`/api/jobs/${jobId}`);
  const payload = await response.json();
  const job = payload.job;
  renderStatus(job);

  if (terminalStatus(job.status)) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

scopeSwitch.addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope]');
  if (!button) return;
  setScope(button.dataset.scope);
});

providerGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-provider]');
  if (!button) return;
  setProvider(button.dataset.provider);
});

singleVideoInput.addEventListener('change', updateSelectionPreview);
folderVideoInput.addEventListener('change', updateSelectionPreview);

copyCurrentButton.addEventListener('click', async () => {
  let text = resultAnalysis.textContent || '';
  if (!text.trim()) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    copyCurrentButton.textContent = '已复制';
    window.setTimeout(() => {
      copyCurrentButton.textContent = '复制当前结果';
    }, 1200);
  } catch (error) {
    statusHeadline.textContent = '复制失败';
    statusLog.textContent = String(error);
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const files = getSelectedFiles();
  if (!files.length) {
    selectionPreview.innerHTML = '<div class="selection-empty">请先选择至少一个视频文件。</div>';
    return;
  }

  if (getProvider() === 'gemini' && !document.getElementById('gemini_api_key').value.trim()) {
    selectionPreview.innerHTML = '<div class="selection-empty">Gemini 模式需要填写 API Key。</div>';
    return;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  const formData = new FormData();
  formData.append('scope', getScope());
  formData.append('provider', getProvider());
  formData.append('fps', document.getElementById('fps').value);
  formData.append('max_frames', document.getElementById('max_frames').value);
  formData.append('prompt', document.getElementById('prompt').value);
  formData.append('gemini_api_key', document.getElementById('gemini_api_key').value);
  formData.append('gemini_model', document.getElementById('gemini_model').value);

  files.forEach((file) => {
    const uploadName = getScope() === 'folder'
      ? (file.webkitRelativePath || file.name)
      : file.name;
    formData.append('videos', file, uploadName);
  });

  submitButton.disabled = true;
  submitButton.textContent = '任务提交中…';
  statusHeadline.textContent = '任务已提交';
  statusLog.textContent = '正在上传视频并创建任务…';
  progressBar.style.width = '0%';
  renderChips(['正在提交']);
  batchSummary.innerHTML = '';
  itemList.innerHTML = '<div class="empty-state">任务已提交，等待服务端返回队列信息。</div>';
  renderEmptyDetail('任务已提交，等待结果返回。');
  selectedItemIndex = null;
  currentJob = null;

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '任务创建失败');
    }

    renderStatus(payload.job);
    const jobId = payload.job_id;
    pollTimer = setInterval(() => {
      pollJob(jobId).catch((error) => {
        clearInterval(pollTimer);
        pollTimer = null;
        statusHeadline.textContent = '轮询失败';
        statusLog.textContent = String(error);
        submitButton.disabled = false;
        setSubmitButtonIdleText();
      });
    }, 1500);
  } catch (error) {
    statusHeadline.textContent = '任务创建失败';
    statusLog.textContent = String(error);
    submitButton.disabled = false;
    setSubmitButtonIdleText();
  }
});

setScope('single');
setProvider('ollama');
renderEmptyDetail();
fetchConfig().catch((error) => {
  providerSummary.textContent = `读取配置失败：${error}`;
});
