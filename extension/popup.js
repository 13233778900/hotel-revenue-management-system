// popup.js - v6.6.9.4_20260127_1600 (Root Cause Fix & Precision Calibration)
const API_BASE = 'https://revenuepilot.wangqihao520.workers.dev';

const els = {
  setupPanel: document.getElementById('setup-panel'),
  mainPanel: document.getElementById('main-panel'),
  usernameInput: document.getElementById('usernameInput'),
  passwordInput: document.getElementById('passwordInput'),
  saveConfigBtn: document.getElementById('save-config-btn'),
  storeName: document.getElementById('storeName'),
  storeTrigger: document.getElementById('store-trigger'),
  storeSwitcherContainer: document.getElementById('store-switcher-container'),
  storeDropdownList: document.getElementById('store-dropdown-list'),
  versionBtn: document.getElementById('version-btn'),

  // Automation Console
  automationConsole: document.getElementById('automation-console'),
  actionPanel: document.getElementById('action-panel'),
  btnToday: document.getElementById('btn-today'),
  btnFuture: document.getElementById('btn-future'),
  btnPause: document.getElementById('btn-pause'),
  btnStop: document.getElementById('btn-stop'),
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  progressStatus: document.getElementById('progress-status'),

  // Timers
  nextTaskTimeToday: document.getElementById('next-task-time-today'),
  nextTaskTimeFuture: document.getElementById('next-task-time-future'),
  futurePlanText: document.getElementById('future-plan-text'),

  // Log
  activityLogBody: document.getElementById('activity-log-body'),
  emptyLog: document.getElementById('empty-log'),

  // Manager
  hotelManagerOverlay: document.getElementById('hotel-manager-overlay'),
  hotelListContainer: document.getElementById('hotel-list-container'),
  closeManager: document.getElementById('close-manager'),

  // Actions
  logoutBtn: document.getElementById('logout-btn'),
  togglePassword: document.getElementById('togglePassword'),
  rememberMe: document.getElementById('rememberMe')
};

let g_config = { storeId: '', storeName: '', hotels: [] };
let g_history = [];
let g_activeResults = [];

// ================= INITIALIZATION =================

document.addEventListener('DOMContentLoaded', async () => {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.storage) {
    els.setupPanel.classList.remove('hidden');
    return;
  }

  const data = await chrome.storage.local.get(['storeId', 'storeName', 'hotels', 'recentHistory', 'batchState', 'availableStores']);
  g_history = data.recentHistory || [];
  g_config.hotels = data.hotels || [];

  if (data.storeId) {
    g_config.storeId = data.storeId;
    g_config.storeName = data.storeName || '未命名门店';
    showMainView(data.batchState, data.availableStores);

    // [v6.6.9.2] Proactively request the latest batch state to avoid lag
    chrome.runtime.sendMessage({ type: 'GET_BATCH_STATE' }, (state) => {
      if (state) {
        console.log('[popup.js:同步] -> 实时拉取最新运行状态', state);
        updateProgressUI(state);
        toggleAutomationUI(state.isRunning);
      }
    });
  } else {
    showSetupView();
  }

  setupEventListeners();
  startSchedulerTimer();
});

function setupEventListeners() {
  els.saveConfigBtn?.addEventListener('click', handleSaveConfig);
  els.btnToday.addEventListener('click', () => startTask('today'));
  els.btnFuture.addEventListener('click', () => startTask('future'));
  els.btnPause.addEventListener('click', handleTogglePause);
  els.btnStop.addEventListener('click', handleStopTask);
  els.storeTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    els.storeDropdownList.classList.toggle('active');
    els.storeTrigger.parentElement.classList.toggle('active-dropdown');
  });

  document.addEventListener('click', () => {
    els.storeDropdownList.classList.remove('active');
    els.storeTrigger.parentElement.classList.remove('active-dropdown');
  });

  els.versionBtn?.addEventListener('dblclick', () => {
    // [v6.6.9.1] Enhanced Hotel Discovery Logic
    console.log('[popup.js:调试] -> 尝试跳转当前酒店页面...');

    // 1. 查找标记为 self 的酒店
    console.log(`[popup.js:跳转] -> 页面: ${targetHotel.name} | URL: ${url}`);
    chrome.tabs.create({ url: url });
  } else {
    console.error('[popup.js:跳转失败] -> 无有效 URL', { targetHotel, allHotels: g_config.hotels });
    alert(`未找到有效的酒店链接。\n\n当前门店: ${g_config.storeName
  }\n酒店总数: ${ g_config.hotels.length }\n\n请确认后台"监控列表"中已添加酒店。`);
    }
  });

  els.togglePassword?.addEventListener('click', () => {
    const type = els.passwordInput.type === 'password' ? 'text' : 'password';
    els.passwordInput.type = type;
    els.togglePassword.textContent = type === 'password' ? '👁️' : '🔒';
  });

  // [v6.6.9.2] Real-time Progress Listener
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BATCH_UPDATE') {
      console.log('[popup.js:监听] -> 收到实时进度更新', msg.payload);
      updateProgressUI(msg.payload);
      toggleAutomationUI(msg.payload.isRunning);
    }
    if (msg.type === 'AUTH_PROGRESS') {
      if (els.saveConfigBtn) els.saveConfigBtn.textContent = msg.status;
    }
  });
}

// ================= VIEWS =================

function showSetupView() {
  els.setupPanel.classList.remove('hidden');
  els.mainPanel.classList.add('hidden');
}

async function showMainView(batchState, availableStores) {
  els.setupPanel.classList.add('hidden');
  els.mainPanel.classList.remove('hidden');
  els.storeName.textContent = g_config.storeName;

  // Populate Inline Switcher
  if (availableStores && availableStores.length > 0) {
    els.storeDropdownList.innerHTML = availableStores.map(s => `
  < div class= "store-item ${s.id === g_config.storeId ? 'selected' : ''}" data - id="${s.id}" >
  ${ s.name } ${ s.id === g_config.storeId ? '✓' : '' }
        </div >
    `).join('');

    els.storeDropdownList.querySelectorAll('.store-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const nextId = e.target.getAttribute('data-id');
        if (nextId && nextId !== g_config.storeId) {
          switchStore(nextId);
        }
      });
    });
  }

  if (batchState && batchState.isRunning) {
    toggleAutomationUI(true);
    updateProgressUI(batchState);
  } else {
    toggleAutomationUI(false);
    renderLog();
  }
  refreshConfig();
}

function toggleAutomationUI(isRunning) {
  els.automationConsole.classList.toggle('hidden', !isRunning);
  els.actionPanel.classList.toggle('hidden', isRunning);
}

// ================= ACTIONS =================

async function handleSaveConfig() {
  const username = els.usernameInput.value.trim();
  const password = els.passwordInput.value.trim();
  if (!username || !password) return alert('请输入账号和密码');

  els.saveConfigBtn.disabled = true;
  els.saveConfigBtn.textContent = '正在核验...';

  chrome.runtime.sendMessage({ type: 'AUTH_LOGIN', username, password }, (res) => {
    if (res?.success) {
      window.location.reload();
    } else {
      alert('登录失败: ' + (res?.error || '未知原因'));
      els.saveConfigBtn.disabled = false;
      els.saveConfigBtn.textContent = '重试登录';
    }
  });
}

function handleLogout() {
  if (confirm('确定要退出当前账号吗？')) {
    chrome.storage.local.clear(() => window.location.reload());
  }
}

function switchStore(storeId) {
  chrome.runtime.sendMessage({ type: 'SYNC_CONFIG', storeId }, (res) => {
    if (res?.success) {
      chrome.storage.local.set({ storeId }, () => window.location.reload());
    } else {
      alert('切换失败: ' + (res?.error || '配置加载失败'));
    }
  });
}

function startTask(type) {
  els.btnToday.disabled = true;
  els.btnFuture.disabled = true;
  chrome.runtime.sendMessage({ type: 'START_BATCH_SCRAPE', scrapeType: type }, (res) => {
    if (!res?.success) {
      alert('启动失败: ' + (res?.error || '任务冲突'));
      els.btnToday.disabled = false;
      els.btnFuture.disabled = false;
    } else {
      g_activeResults = [];
      renderLog();
      toggleAutomationUI(true);
    }
  });
}

function handleTogglePause() {
  const isPaused = els.btnPause.textContent.includes('继续');
  chrome.runtime.sendMessage({ type: isPaused ? 'RESUME_BATCH' : 'PAUSE_BATCH' });
  els.btnPause.textContent = isPaused ? '⏸ 暂停' : '▶️ 继续';
}

function handleStopTask() {
  if (confirm('确定终止抓取吗？')) {
    chrome.runtime.sendMessage({ type: 'STOP_BATCH' });
    g_activeResults = [];
    renderLog();
    toggleAutomationUI(false);
  }
}

// ================= TIMERS =================

function formatTime(ms) {
  if (!ms || ms <= 0) return "00:00:00";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSecs % 3600) / 60).toString().padStart(2, '0');
  const s = (totalSecs % 60).toString().padStart(2, '0');
  return `${ h }: ${ m }: ${ s }`;
}

function startSchedulerTimer() {
  const update = () => {
    chrome.runtime.sendMessage({ type: 'GET_SCHEDULER_INFO' }, (res) => {
      if (res) {
        els.nextTaskTimeToday.textContent = formatTime(res.nextHourly - Date.now());
        els.nextTaskTimeFuture.textContent = formatTime(res.nextDaily - Date.now());
      }
    });

    // v6.6.0: Fetch Task Config for range info
    chrome.runtime.sendMessage({ type: 'GET_TASK_CONFIG' }, (res) => {
      if (res && els.futurePlanText) {
        els.futurePlanText.textContent = `未来策略: 凌晨 05:00(未来 ${ res.futureDays } 天)`;
      }
    });
  };
  update();
  setInterval(update, 1000);
}

// ================= CONFIG & LISTS =================

async function refreshConfig() {
  if (!g_config.storeId) return;
  chrome.runtime.sendMessage({ type: 'SYNC_CONFIG', storeId: g_config.storeId }, (res) => {
    if (res?.config) {
      if (res.config.selfHotel) g_config.hotels = [res.config.selfHotel, ...(res.config.competitors || [])];
      els.storeName.textContent = res.config.storeName || g_config.storeName;
    }
  });
}

async function openHotelManager() {
  els.hotelManagerOverlay.classList.remove('hidden');
  els.hotelListContainer.innerHTML = '<div class="empty-state">加载中...</div>';

  try {
    const response = await fetch(`${ API_BASE } / api / client / config ? storeId = ${ g_config.storeId }`);
    const resJson = await response.json();
    const data = resJson.config || resJson;

    const selfHotels = [];
    if (data.selfHotel) selfHotels.push(data.selfHotel);

    const allCompetitors = data.competitors || [];

    if (selfHotels.length === 0) {
      els.hotelListContainer.innerHTML = '<div class="empty-state">未配置酒店</div>';
      return;
    }

    els.hotelListContainer.innerHTML = selfHotels.map(self => {
      const comps = allCompetitors.filter(c => c.storeId === self.storeId || true); // Group fallback
      return `
  < div class= "hotel-group" id = "group-${self.id}" >
                    <div class="hotel-parent" onclick="document.getElementById('group-${self.id}').classList.toggle('expanded')">
                        <span class="hotel-arrow">▶</span>
                        <div style="flex:1">
                            <div style="font-weight:700; font-size:13px;">${self.name}</div>
                            <div style="font-size:10px; color:var(--text-sub);">一级 (本店)</div>
                        </div>
                        <label class="switch" onclick="event.stopPropagation()">
                            <input type="checkbox" class="hotel-toggle" data-id="${self.id}" ${self.is_active !== 0 ? 'checked' : ''}>
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="competitor-list">
                        ${comps.map(c => `
                            <div class="hotel-child">
                                <div style="flex:1">
                                    <div style="font-size:12px;">${c.name}</div>
                                    <div style="font-size:9px; color:var(--text-sub);">二级 (竞对)</div>
                                </div>
                                <label class="switch">
                                    <input type="checkbox" class="hotel-toggle" data-id="${c.id}" ${c.is_active !== 0 ? 'checked' : ''}>
                                    <span class="slider"></span>
                                </label>
                            </div>
                        `).join('')}
                    </div>
                </div >
    `;
    }).join('');

    // Bind Toggles
    document.querySelectorAll('.hotel-toggle').forEach(btn => {
      btn.addEventListener('change', async (e) => {
        const id = e.target.getAttribute('data-id');
        const checked = e.target.checked;
        try {
          await fetch(`${ API_BASE } / api / hotels / ${ id } / toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: checked })
          });
          // Refresh data in bg
          chrome.runtime.sendMessage({ type: 'SYNC_CONFIG', storeId: g_config.storeId });
        } catch (err) {
          alert('网络异常');
          e.target.checked = !checked;
        }
      });
    });

  } catch (e) {
    els.hotelListContainer.innerHTML = '<div class="empty-state">加载失败</div>';
  }
}

// ================= LOGS =================

function renderLog() {
  const combined = [...g_activeResults, ...g_history];
  const seen = new Set();
  const final = [];
  for (const i of combined) {
    const k = `${ i.hotel } | ${ i.date }`;
    if (!seen.has(k)) { seen.add(k); final.push(i); }
  }

  const items = final.slice(0, 50);
  if (items.length === 0) {
    els.emptyLog.classList.remove('hidden');
    els.activityLogBody.innerHTML = '';
    return;
  }

  els.emptyLog.classList.add('hidden');
  els.activityLogBody.innerHTML = items.map(item => {
    const d = new Date(item.timestamp || Date.now());
    const tStr = `${(d.getMonth() + 1).toString().padStart(2, '0')} -${ d.getDate() } ${ d.getHours() }:${ d.getMinutes().toString().padStart(2, '0') } `;
    const isOk = item.price && (item.price > 0 || item.price === -1);
    return `
  < div class="log-row" >
                <div style="color:var(--text-sub); font-size:9px;">${tStr}</div>
                <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.hotel || '-'}</div>
                <div>${item.date || '-'}</div>
                <div style="font-weight:700; color:${isOk ? 'var(--success)' : 'var(--danger)'}">
                    ${item.price === -1 ? '满房' : (item.price ? '¥' + item.price : '-')}
                </div>
                <div style="text-align:center;">${isOk ? '✅' : '❌'}</div>
            </div >
  `;
  }).join('');
}

function updateProgressUI(state) {
  const { current, total, status, results } = state;
  const pct = total > 0 ? (current / total) * 100 : 0;
  els.progressBar.style.width = `${ pct }% `;
  els.progressText.textContent = `${ current }/${total} (${Math.round(pct)}%)`;
els.progressStatus.textContent = status || '正在抓取...';
if (results) { g_activeResults = results; renderLog(); }
}
