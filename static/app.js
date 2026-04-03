// 仅仅是针对新 UI 结构调整了选择器和 DOM 渲染生成逻辑，核心 API 请求和轮询机制原封不动。
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
const submitText = document.getElementById('submit-text');
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
  const labels = { queued: '排队中', running: '处理中', completed: '已完成', failed: '失败', completed_with_errors: '部分失败' };
  return labels[status] || status;
}

function stageLabel(stage) {
  const labels = { queued: '等待执行', starting: '准备中', probing: '读取元数据', extracting_frames: '抽取关键帧', calling_ollama: '发送到 Ollama', uploading_video: '上传视频', processing_video: '服务端处理', calling_gemini: '调用 Gemini', completed: '处理完成', failed: '处理失败' };
  return labels[stage] || stage || '等待执行';
}

function formatSeconds(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return `${Number(value).toFixed(2)}s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatVideoMeta(video) {
  if (!video) return [];
  const items = [];
  if (video.duration_seconds) items.push({ label: '视频时长', value: `${video.duration_seconds}s` });
  if (video.width && video.height) items.push({ label: '分辨率', value: `${video.width} x ${video.height}` });
  if (video.video_codec) items.push({ label: '视频编码', value: video.video_codec });
  if (video.audio_codec) items.push({ label: '音频编码', value: video.audio_codec });
  return items;
}

function isVideoFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('video/')) return true;
  return /\.(mp4|mov|m4v|avi|mkv|webm|mpeg|mpg|3gp|ts|mts)$/i.test(file.name);
}

function getScope() { return scopeInput.value; }
function getProvider() { return providerInput.value; }
function getSelectedFiles() {
  if (getScope() === 'folder') {
    return Array.from(folderVideoInput.files || []).filter(isVideoFile).sort((a, b) => {
      return (a.webkitRelativePath || a.name).toLowerCase().localeCompare((b.webkitRelativePath || b.name).toLowerCase());
    });
  }
  return Array.from(singleVideoInput.files || []).filter(isVideoFile).slice(0, 1);
}

function setSubmitButtonIdleText() {
  submitText.textContent = getScope() === 'folder' ? '开始批量分析' : '开始分析';
}

function setScope(scope) {
  scopeInput.value = scope;
  Array.from(scopeSwitch.querySelectorAll('.segment')).forEach(btn => btn.classList.toggle('active', btn.dataset.scope === scope));
  singleDrop.classList.toggle('hidden', scope !== 'single');
  folderDrop.classList.toggle('hidden', scope !== 'folder');
  selectionModeNote.textContent = scope === 'single' ? '单视频模式' : '文件夹批量模式';
  
  if (scope === 'single') folderVideoInput.value = '';
  else singleVideoInput.value = '';
  
  setSubmitButtonIdleText();
  updateSelectionPreview();
}

function setProvider(provider) {
  providerInput.value = provider;
  Array.from(providerGrid.querySelectorAll('.engine-card')).forEach(card => card.classList.toggle('active', card.dataset.provider === provider));
  const useGemini = provider === 'gemini';
  ollamaFields.classList.toggle('hidden', useGemini);
  geminiFields.classList.toggle('hidden', !useGemini);
}

function renderChips(items) {
  metaChips.innerHTML = items.map(item => `<span class="chip">${item}</span>`).join('');
}

function renderMetrics(result) {
  resultMetrics.innerHTML = '';
  if (!result) return;
  const metrics = [
    { label: '提供方', value: result.provider_label || result.provider || 'n/a' },
    { label: '模型', value: result.model || 'n/a' },
    { label: '处理耗时', value: formatSeconds(result.job_seconds_total || result.processing_seconds) },
  ];
  if (result.provider === 'ollama') {
    metrics.push({ label: '抽帧 FPS', value: String(result.effective_fps ?? 'n/a') });
    metrics.push({ label: '关键帧数量', value: String(result.frame_count ?? 'n/a') });
  }
  formatVideoMeta(result.video).forEach(item => metrics.push(item));
  
  metrics.forEach(m => {
    resultMetrics.insertAdjacentHTML('beforeend', `<div class="metric-card"><span>${escapeHtml(m.label)}</span><strong>${escapeHtml(m.value)}</strong></div>`);
  });
}

function renderAnalysisText(text, subtitle) {
  resultSubtitle.textContent = subtitle;
  resultAnalysis.classList.remove('empty');
  resultAnalysis.textContent = text;
}

function renderEmptyDetail(message = '选择左侧队列以查看结果') {
  resultSubtitle.textContent = '暂无选中';
  resultMetrics.innerHTML = '';
  resultAnalysis.classList.add('empty');
  resultAnalysis.textContent = message;
  copyCurrentButton.disabled = true;
}

function selectDefaultItem(job) {
  if (!job?.items?.length) { selectedItemIndex = null; return; }
  if (selectedItemIndex !== null && selectedItemIndex >= 0 && selectedItemIndex < job.items.length) return;
  const preferredIndex = job.items.findIndex(item => item.status === 'completed');
  selectedItemIndex = preferredIndex >= 0 ? preferredIndex : 0;
}

function renderQueue(job) {
  const items = job?.items || [];
  itemList.innerHTML = '';
  if (!items.length) {
    itemList.innerHTML = '<div class="empty-state">队列为空</div>';
    return;
  }
  
  items.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `queue-item ${index === selectedItemIndex ? 'active' : ''}`;
    
    const label = item.relative_path || item.filename || `item-${index + 1}`;
    const duration = item.result?.job_seconds_total ? formatSeconds(item.result.job_seconds_total) : stageLabel(item.stage);
    
    btn.innerHTML = `
      <div class="q-head">
        <strong>${escapeHtml(label)}</strong>
        <span class="status-dot status-${item.status}">${statusLabel(item.status)}</span>
      </div>
      <div class="q-meta">
        <span>${escapeHtml(duration)}</span>
      </div>
    `;
    btn.addEventListener('click', () => {
      selectedItemIndex = index;
      renderQueue(job);
      renderDetail(job);
    });
    itemList.appendChild(btn);
  });
}

function renderBatchSummary(job) {
  const s = job?.summary || { total: 0, completed: 0, failed: 0 };
  batchSummary.innerHTML = `
    <div class="stat-box"><span>总量</span><strong>${s.total || 0}</strong></div>
    <div class="stat-box"><span>成功</span><strong style="color:var(--success)">${s.completed || 0}</strong></div>
    <div class="stat-box"><span>失败</span><strong style="color:var(--error)">${s.failed || 0}</strong></div>
  `;
}

function renderJobOverview(job) {
  const s = job?.summary || { total: 0, completed: 0, failed: 0 };
  renderMetrics(job.result || null);
  renderAnalysisText(`当前批量任务已结束。\n总计：${s.total} 个\n成功：${s.completed} 个\n失败：${s.failed} 个\n请在右侧列表点击单个视频查看具体分析报告。`, '批量任务概览');
  copyCurrentButton.disabled = true;
}

function renderDetail(job) {
  const items = job?.items || [];
  if (!items.length || selectedItemIndex === null || !items[selectedItemIndex]) {
    if (job?.mode === 'folder' && job?.result) return renderJobOverview(job);
    return renderEmptyDetail();
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
    renderAnalysisText(item.error || '未知错误', `${label} (失败)`);
    copyCurrentButton.disabled = false;
    return;
  }
  
  resultMetrics.innerHTML = '';
  renderAnalysisText((item.logs || []).join('\n') || '处理中...', `${label} · ${statusLabel(item.status)}`);
  copyCurrentButton.disabled = true;
}

function renderStatus(job) {
  currentJob = job;
  const s = job.summary || { total: 0, processed: 0 };
  const percent = s.total > 0 ? Math.round((s.processed / s.total) * 100) : 0;
  
  progressBar.style.width = `${percent}%`;
  statusLog.textContent = (job.logs || []).join('\n') || '处理中...';
  
  renderChips([
    job.mode === 'folder' ? '批量' : '单片',
    job.provider === 'ollama' ? 'Local' : 'Cloud',
    statusLabel(job.status)
  ]);
  
  renderBatchSummary(job);
  selectDefaultItem(job);
  renderQueue(job);
  renderDetail(job);
  
  if (terminalStatus(job.status)) {
    submitButton.disabled = false;
    setSubmitButtonIdleText();
  }
}

function updateSelectionPreview() {
  const files = getSelectedFiles();
  selectionPreview.innerHTML = '';
  if (!files.length) return;

  if (getScope() === 'single') {
    const f = files[0];
    selectionPreview.innerHTML = `<div class="sel-item"><span>${escapeHtml(f.name)}</span><span style="color:var(--text-muted)">${formatBytes(f.size)}</span></div>`;
  } else {
    const size = files.reduce((acc, f) => acc + f.size, 0);
    selectionPreview.innerHTML = `<div class="sel-item"><span>选中了 ${files.length} 个视频</span><span style="color:var(--text-muted)">${formatBytes(size)}</span></div>`;
  }
}

async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    config = data;
    const o = data.providers.ollama;
    providerSummary.innerHTML = o.ready 
      ? `<div class="pulse-dot"></div><span>Ollama 就绪 (${o.model})</span>`
      : `<div class="pulse-dot" style="background:var(--error);box-shadow:none"></div><span style="color:var(--error)">Ollama 失败: ${o.error || '不可用'}</span>`;
    document.getElementById('fps').value = o.default_fps;
    document.getElementById('max_frames').value = o.default_max_frames;
    document.getElementById('gemini_model').value = data.providers.gemini.model;
  } catch(e) {
    providerSummary.innerHTML = `<div class="pulse-dot" style="background:var(--error);box-shadow:none"></div><span style="color:var(--error)">读取配置失败</span>`;
  }
}

async function pollJob(jobId) {
  const res = await fetch(`/api/jobs/${jobId}`);
  const payload = await res.json();
  renderStatus(payload.job);
  if (terminalStatus(payload.job.status)) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

scopeSwitch.addEventListener('click', e => {
  const btn = e.target.closest('[data-scope]');
  if (btn) setScope(btn.dataset.scope);
});

providerGrid.addEventListener('click', e => {
  const btn = e.target.closest('[data-provider]');
  if (btn) setProvider(btn.dataset.provider);
});

singleVideoInput.addEventListener('change', updateSelectionPreview);
folderVideoInput.addEventListener('change', updateSelectionPreview);

copyCurrentButton.addEventListener('click', async () => {
  const txt = resultAnalysis.textContent || '';
  if (!txt.trim()) return;
  await navigator.clipboard.writeText(txt);
  const orig = copyCurrentButton.innerHTML;
  copyCurrentButton.innerHTML = '已复制';
  setTimeout(() => { copyCurrentButton.innerHTML = orig; }, 1200);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = getSelectedFiles();
  if (!files.length) return alert('请先选择视频文件。');
  if (getProvider() === 'gemini' && !document.getElementById('gemini_api_key').value.trim()) {
    return alert('Gemini 模式需要填写 API Key。');
  }
  
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  
  const fd = new FormData();
  fd.append('scope', getScope());
  fd.append('provider', getProvider());
  fd.append('fps', document.getElementById('fps').value);
  fd.append('max_frames', document.getElementById('max_frames').value);
  fd.append('prompt', document.getElementById('prompt').value);
  fd.append('gemini_api_key', document.getElementById('gemini_api_key').value);
  fd.append('gemini_model', document.getElementById('gemini_model').value);
  
  files.forEach(f => {
    fd.append(getScope() === 'folder' ? 'videos' : 'video', f, getScope() === 'folder' ? (f.webkitRelativePath || f.name) : f.name);
  });
  
  submitButton.disabled = true;
  submitText.textContent = '提交中...';
  progressBar.style.width = '0%';
  renderChips(['正在提交']);
  statusLog.textContent = '上传数据并创建任务...';
  itemList.innerHTML = '<div class="empty-state">等待服务器响应...</div>';
  renderEmptyDetail('任务提交中...');
  selectedItemIndex = null;
  currentJob = null;
  
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || '任务创建失败');
    renderStatus(payload.job);
    pollTimer = setInterval(() => pollJob(payload.job_id).catch(err => {
      clearInterval(pollTimer);
      pollTimer = null;
      statusLog.textContent += `\n轮询失败: ${err}`;
      submitButton.disabled = false;
      setSubmitButtonIdleText();
    }), 1500);
  } catch(err) {
    statusLog.textContent = `提交失败: ${err}`;
    submitButton.disabled = false;
    setSubmitButtonIdleText();
  }
});

setScope('single');
setProvider('ollama');
renderEmptyDetail();
fetchConfig();