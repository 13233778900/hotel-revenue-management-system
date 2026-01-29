const API_BASE_URL = 'https://revenuepilot.wangqihao520.workers.dev';

// 初始化
const INJECTED_STORE_ID = '__STORE_ID__';
const INJECTED_CONFIG = {}; // Placeholder for injected data
const INJECTED_API_BASE = API_BASE_URL;

chrome.runtime.onInstalled.addListener(async () => {
  console.log('酒店收益管理系统 扩展已安装/更新 (v6.6.9.4_20260127_1600)');
  console.log('[background.js:初始化] -> 🚀 插件版本: v6.6.9.4 | 编译时间: 20260127_1600');

  // 初始化定时任务
  setupPrecisionAlarms();

  // 创建右键菜单 (容错性：如果失败不阻塞后续流程)
  try {
    chrome.contextMenus.create({
      id: "rp-calibrate",
      title: "👉 设为价格元素 (RevenuePilot)",
      contexts: ["all"]
    });
    console.log(`[background.js:初始化] -> ✅ 右键菜单创建成功`);
  } catch (e) {
    console.warn('[Init] 右键菜单创建失败 (可忽略):', e.message);
  }

  // 零配置初始化：保存 Store ID 并强制同步
  if (INJECTED_STORE_ID && !INJECTED_STORE_ID.startsWith('__')) {
    await chrome.storage.local.set({ storeId: INJECTED_STORE_ID });
    console.log(`[background.js:初始化] -> ✅ 自动载入门店 ID: ${INJECTED_STORE_ID}`);
    // 立即同步
    await forceSync();
  } else {
    console.warn('[Init] 未检测到有效的 Store ID');
  }
});

chrome.runtime.onStartup.addListener(() => {
  console.log('酒店收益管理系统 扩展启动');
  forceSync();
});

// 右键菜单点击处理 (容错)
try {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "rp-calibrate" && tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'CALIBRATE_ELEMENT' }).catch(() => { });
    }
  });
} catch (e) {
  console.warn('[Init] contextMenus.onClicked 注册失败:', e.message);
}

// 强制云同步
async function forceSync() {
  const data = await chrome.storage.local.get('storeId');
  if (data.storeId) {
    console.log(`[background.js:配置同步] -> 🚀 准备为门店 [${data.storeId}] 拉取云端配置...`);
    const result = await syncConfig(data.storeId);
    if (result.success) {
      console.log(`[background.js:配置同步] -> ✅ 同步成功: ${result.name}`);
    } else {
      console.error(`[background.js:配置同步] -> ❌ 同步失败: ${result.error}`);
    }
  } else {
    console.warn(`[background.js:配置同步] -> ⚠️ 本地存储无门店 ID，跳过同步`);
  }
}

// ==================== BATCH AUTOMATION (QUEUED) ====================

// v4.10.7: 建立近期上传缓存，彻底杜绝物理重复上报 (15秒窗口)
const recentUploads = new Map(); // key -> timestamp

class TaskQueue {
  constructor() {
    this.queue = [];      // Array of hotels to scrape
    this.activeTabs = new Map(); // tabId -> hotel
    this.processingTabs = new Set(); // [Base] Lock for async operations
    this.results = [];
    this.isRunning = false;
    this.isPaused = false;
    this.total = 0;
    // v4.9.19 [Base]: 降级为单线程串行抓取，彻底消除并发竞态风险
    this.concurrency = 1;
    this.batchId = 0; // [Fix] Unique Batch ID to identify sessions

    // v4.15.0 Patch 11: 5-Strike Warning
    this.consecutiveFailures = 0;

    // v4.15.0 Patch 9: Auto-Hydrate on startup
    this.hydrate();
  }

  async hydrate() {
    try {
      const data = await chrome.storage.local.get(['batchState', 'batchQueue', 'multiStoreConfigs', 'activeStores']);
      if (data.batchQueue && data.batchQueue.length > 0) {
        this.queue = data.batchQueue;
        this.total = this.queue.length;
        this.batchId = (data.batchState && data.batchState.batchId) ? data.batchState.batchId : Date.now();
        console.log(`[background.js:任务队列] -> 恢复了 ${this.queue.length} 个历史抓取任务`);
        this.broadcastState();
      }

      // Initialize activeStores if missing (Default all active)
      if (data.multiStoreConfigs && !data.activeStores) {
        const allIds = data.multiStoreConfigs.map(c => c.storeId);
        chrome.storage.local.set({ activeStores: allIds });
      }
    } catch (e) {
      console.error('[BatchQueue] Hydration failed', e);
    }
  }

  load(hotels) {
    this.batchId++; // New batch started
    this.activeTabs = new Map();
    this.processingTabs = new Set();
    this.concurrency = 3; // [v6.6.9.2] Boosted to 3 concurrent tabs
    this.queue = [...hotels];
    this.total = hotels.length;
    this.results = [];
    this.isRunning = true;
    this.isPaused = false;
    this.isStarting = false;
    this.consecutiveFailures = 0;
    console.log(`[BatchQueue] Loaded Batch #${this.batchId}`);

    // v4.15.0 Patch 8: Start Keep-Alive Alarm
    chrome.alarms.create('RP_BATCH_KEEPALIVE', { periodInMinutes: 0.5 });

    this.process();
    this.broadcastState();
  }

  pause() {
    this.isPaused = true;
    this.broadcastState();
  }

  resume() {
    this.isPaused = false;
    this.process();
    this.broadcastState();
  }

  stop() {
    // v4.15.0 Patch 8: Stop Keep-Alive Alarm
    chrome.alarms.clear('RP_BATCH_KEEPALIVE');

    this.batchId++; // Increment to invalidate any pending ops
    this.isRunning = false;
    this.queue = [];
    // Close all active tabs
    for (const [tabId] of this.activeTabs) {
      chrome.tabs.remove(tabId);
    }
    this.activeTabs.clear();
    this.isStarting = false; // [v6.5.0] Lock Reset
    this.broadcastState();

    // v4.16.6: Auto-Redirect if all items failed (All-Strike Protection)
    if (this.total > 0 && this.consecutiveFailures >= this.total) {
      console.warn(`[BatchQueue] 🚨 全军覆没 (${this.consecutiveFailures}/${this.total})，判定为未登录，正在跳转引导...`);
      chrome.storage.local.get('hotels', (data) => {
        const selfHotel = data.hotels?.find(h => h.hotel_type === 'self');
        const targetUrl = selfHotel?.ctrip_url || selfHotel?.url || 'https://passport.ctrip.com/user/login';
        chrome.tabs.create({ url: targetUrl, active: true });
        // Optional: Send notification
      });
    }
  }

  waitForContentScript(tabId, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = setInterval(() => {
        chrome.tabs.sendMessage(tabId, { type: 'PING' }, (response) => {
          if (chrome.runtime.lastError) {
            // ignore
          } else if (response && response.status === 'pong') {
            clearInterval(check);
            resolve();
          }
        });
        if (Date.now() - start > timeout) {
          clearInterval(check);
          reject(new Error('Content script timeout'));
        }
      }, 500);
    });
  }

  process() {
    if (!this.isRunning || this.isPaused) return;

    if (this.activeTabs.size >= this.concurrency) {
      console.log('[BatchQueue] 并发已满 (1/1)，等待当前任务完成...');
      return;
    }

    if (this.isStarting) {
      console.log('[BatchQueue] 启动锁(isStarting)已激活，等待中...');
      return;
    }

    if (this.queue.length === 0) {
      if (this.activeTabs.size > 0) {
        console.log(`[BatchQueue] 队列已空，等待剩余 ${this.activeTabs.size} 个任务完成...`);
        return;
      }
      console.log('[BatchQueue] ✅ 所有任务已处理完成');
      this.stop();
      return;
    }

    const currentBatchId = this.batchId;
    this.isStarting = true;

    const task = this.queue.shift();
    console.log(`[BatchQueue] 🚀 准备创建标签页 (Batch #${currentBatchId}, 酒店: ${task.hotelName || task.name})`);

    const targetUrl = task.url || task.ctrip_url;
    if (!targetUrl) {
      console.error('[BatchQueue] ❌ URL 为空，跳过任务');
      this.isStarting = false;
      this.process();
      return;
    }

    try {
      chrome.tabs.create({
        url: targetUrl,
        active: false,
        pinned: true,
        index: 0
      }, (tab) => {
        this.isStarting = false;

        if (chrome.runtime.lastError) {
          console.error('[BatchQueue] ❌ chrome.tabs.create 失败:', chrome.runtime.lastError.message);
          this.process();
          return;
        }

        if (this.batchId !== currentBatchId || !this.isRunning) {
          console.warn(`[BatchQueue] ⚠️ 任务流已变动，关闭新标签页: ${tab.id}`);
          chrome.tabs.remove(tab.id);
          return;
        }

        console.log(`[BatchQueue] ✅ 标签开启成功, ID: ${tab.id}`);

        task.timeoutId = setTimeout(() => {
          if (this.activeTabs.has(tab.id)) {
            console.error(`[BatchQueue] 🛑 任务超时(60s): ${task.name}`);
            chrome.tabs.remove(tab.id, () => { });
            this.activeTabs.delete(tab.id);
            this.process();
          }
        }, 60000);

        this.activeTabs.set(tab.id, task);
        this.broadcastState();

        this.waitForContentScript(tab.id, 15000).then(() => {
          if (this.batchId !== currentBatchId || !this.activeTabs.has(tab.id)) return;
          const msgType = task.type === 'future' || task.targetDate !== new Date().toISOString().split('T')[0]
            ? 'START_SCRAPE_FUTURE' : 'START_SCRAPE_TODAY';
          chrome.tabs.sendMessage(tab.id, {
            type: msgType,
            targetDate: task.targetDate,
            hotelId: task.id || task.hotelId
          }).catch(err => {
            console.error(`[BatchQueue] ❌ 发送指令失败 (Tab ${tab.id}):`, err.message);
          });
        }).catch(err => {
          console.error(`[BatchQueue] ❌ 内容脚本加载超时 (Tab ${tab.id}):`, err.message);
          if (this.activeTabs.has(tab.id)) {
            clearTimeout(task.timeoutId);
            chrome.tabs.remove(tab.id, () => { });
            this.activeTabs.delete(tab.id);
            this.process();
          }
        });
      });

      // [v6.6.9.2] 循环补位：如果还有空位且队列有任务，立即尝试开启下一个，不需要等当前这个 fully created
      if (this.activeTabs.size + 1 < this.concurrency && this.queue.length > 0) {
        setTimeout(() => this.process(), 500);
      }

    } catch (err) {
      console.error('[BatchQueue] ❌ 炸裂错误:', err.message);
      this.isStarting = false;
      this.process();
    }
  }


  handleResult(price, url) {
    // Find which tab/hotel this belongs to (approximate by URL or store)
    // Actually, we should track by sender.tab.id from the message
  }

  completeTask(tabId, price) {
    console.log('[BatchQueue] ===== completeTask START =====');
    console.log('[BatchQueue] tabId:', tabId);
    console.log('[BatchQueue] price:', price);
    console.log('[BatchQueue] this.activeTabs:', this.activeTabs);
    console.log('[BatchQueue] this.activeTabs.has(tabId):', this.activeTabs.has(tabId));

    // [Debug] Check if queue was lost due to SW restart
    if (this.activeTabs.size === 0 && this.results.length === 0 && !this.isRunning) {
      console.warn('[BatchQueue] ⚠️ Queue state appears empty. Service Worker might have restarted.');
    }

    if (this.activeTabs.has(tabId)) {
      const hotel = this.activeTabs.get(tabId);
      console.log('[BatchQueue] 找到酒店:', hotel);

      // [Defensive] Clear the 60s timeout
      if (hotel.timeoutId) {
        clearTimeout(hotel.timeoutId);
      }

      const result = {
        hotel: hotel.name,
        price,
        date: hotel.targetDate || new Date().toISOString().split('T')[0],
        timestamp: Date.now()
      };

      // v4.9.18: 结果去重 (Result Deduplication)
      // 如果已经有相同酒店+日期的结果，不再重复记录 (v4.10.6: 增强判定，忽略大小写和空格)
      const hotelKey = (result.hotel || '').trim().toLowerCase();
      const isDuplicate = this.results.some(r =>
        (r.hotel || '').trim().toLowerCase() === hotelKey && r.date === result.date
      );

      if (isDuplicate) {
        console.warn(`[BatchQueue] ⚠️ 忽略重复结果: ${result.hotel} (${result.date})`);
      } else {
        this.results.push(result);

        // 保存到 storage 以供 popup 显示
        chrome.storage.local.get(['recentHistory'], (data) => {
          const history = data.recentHistory || [];
          // 这里也做一次严格去重检查
          const historyDuplicate = history.some(h =>
            (h.hotel || '').trim().toLowerCase() === hotelKey && h.date === result.date
          );
          if (!historyDuplicate) {
            history.unshift(result);
            const trimmed = history.slice(0, 50); // 增加历史保留数量
            chrome.storage.local.set({ recentHistory: trimmed });
          }
        });
      }

      console.log('[BatchQueue] 任务完成:', result);
      console.log('[BatchQueue] this.results.length:', this.results.length);

      // [v4.10.7 Fix] Restore deletion to prevent queue stall
      this.activeTabs.delete(tabId);

      // Close tab
      chrome.tabs.remove(tabId, () => {
        // [v4.10.6] Ensure lock is released ONLY after tab is removed
        batchQueue.processingTabs.delete(tabId);
        console.log(`[BatchQueue] Tab ${tabId} closed, lock released.`);
      });

      // Next
      this.results.push(result);

      // v4.15.0 Patch 12: All-Strike Logic (Failures >= Total)
      if (price > 0) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.total) {
          console.warn('[BatchQueue] 🚨 触发全军覆没熔断 (All-Strike)，暂停队列');
          this.pause();
          // Optional: Notify UI about the reason
          chrome.storage.local.set({ pauseReason: 'all_strike_login_check' });
        }
      }

      this.broadcastState();

      // [v6.6.0] Critical Fix: Resume processing loop immediately after completion
      this.process();
    } else {
      console.error('[BatchQueue] tabId 不在 activeTabs 中！');
      console.error('[BatchQueue] tabId:', tabId);
      console.error('[BatchQueue] activeTabs keys:', Array.from(this.activeTabs.keys()));
      // [Security] Emergency release lock if tab is gone but activeTabs mismatch
      batchQueue.processingTabs.delete(tabId);
    }
    console.log('[BatchQueue] ===== completeTask END =====');
  }

  broadcastState() {
    const completedCount = this.results.length;
    const safeCurrent = Math.min(completedCount, this.total);

    const state = {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      total: this.total,
      current: safeCurrent,
      status: this.isRunning ? `处理中 (${this.activeTabs.size}个页面)...` : '已完成',
      results: this.results
    };

    console.log('[BatchQueue] 广播状态:', state);

    // [v6.6.9.3] 强制落库，解决 SW 重启后状态丢失导致的进度条“回滚”
    chrome.storage.local.set({ batchState: state });

    chrome.runtime.sendMessage({
      type: 'BATCH_UPDATE',
      payload: state
    }).catch(() => { }); // Popup might be closed
  }

  getState() {
    const completedCount = this.results.length;
    const safeCurrent = Math.min(completedCount, this.total);
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      total: this.total,
      current: safeCurrent,
      status: this.isRunning ? `处理中 (${this.activeTabs.size}个页面)...` : '已完成',
      results: this.results
    };
  }
}

const batchQueue = new TaskQueue();

// 核心消息处理器
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. SYNC CONFIG
  if (request.type === 'SYNC_CONFIG') {
    syncConfig(request.storeId).then(res => sendResponse(res));
    return true; // Async response
  }

  // [v6.6.9.2] GET LATEST STATE
  if (request.type === 'GET_BATCH_STATE') {
    sendResponse(batchQueue.getState());
    return true;
  }

  // [v6.6.3] AUTH LOGIN - Deep Refactored for Reliability
  if (request.type === 'AUTH_LOGIN') {
    const { username, password } = request;
    console.log(`[AUTH] 👤 Starting login for: ${username}`);

    const broadcast = (status) => {
      chrome.runtime.sendMessage({ type: 'AUTH_PROGRESS', status }).catch(() => { });
    };

    (async () => {
      try {
        broadcast('正在连接身份验证服务器...');
        const authRes = await fetch(`${API_BASE_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: username, password })
        });

        const authData = await authRes.json().catch(() => ({}));
        if (!authRes.ok || !(authData.token || authData.jwt)) {
          throw new Error(authData.message || authData.error || '账号或密码错误');
        }

        const token = authData.token || authData.jwt;
        broadcast('身份验证成功，正在同步门店信息...');

        // [v6.6.3] Parallel Discovery & Sync
        const discovery = await discoverStoreId(token, scavengeStoreId(authData));
        const finalId = discovery.storeId;

        if (!finalId) {
          throw new Error('未找到关联的门店，请联系管理员配置。');
        }

        broadcast(`正在同步门店配置 (ID: ${finalId})...`);
        await syncConfig(finalId, token);

        await chrome.storage.local.set({
          jwt: token,
          username: username,
          storeId: String(finalId),
          availableStores: discovery.availableStores,
          lastSync: Date.now()
        });

        setupPrecisionAlarms();
        sendResponse({ success: true, storeId: finalId });

      } catch (err) {
        console.error('[AUTH] ❌ Root Cause Failure:', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // v4.16.7: Get next task alarm info
  if (request.type === 'GET_SCHEDULER_INFO') {
    chrome.alarms.getAll((alarms) => {
      const hourly = alarms.find(a => a.name === 'hourly_job');
      const daily = alarms.find(a => a.name === 'daily_job');
      sendResponse({
        nextHourly: hourly ? hourly.scheduledTime : null,
        nextDaily: daily ? daily.scheduledTime : null,
        totalAlarms: alarms.length
      });
    });
    return true;
  }
  // 手动价格选择模式启动
  if (request.type === 'START_SELECT_MODE') {
    (async () => {
      try {
        const targetUrl = request.url;
        console.log('[background.js:选择模式] -> 准备启动手动校准, URL:', targetUrl);

        // 1. 创建标签页
        const tab = await chrome.tabs.create({ url: targetUrl, active: true });
        console.log(`[background.js:选择模式] -> 标签页已创建: ${tab.id}`);

        // 2. 等待加载完成并注入脚本
        // 容错：有些页面 document_start 注入可能失效，这里强制补票
        await new Promise(r => setTimeout(r, 2000)); // 给页面一点加载时间

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }).catch(e => console.warn('[Selector] Script already injected or failed:', e.message));

        // 3. 发送开启指令
        console.log(`[background.js:选择模式] -> 发送指令: ENABLE_SELECT_MODE 到 Tab ${tab.id}`);
        chrome.tabs.sendMessage(tab.id, { type: 'ENABLE_SELECT_MODE' }, (resp) => {
          if (chrome.runtime.lastError) {
            console.error('[background.js:选择模式] -> 指令发送失败:', chrome.runtime.lastError.message);
          } else {
            console.log('[background.js:选择模式] -> 指令已确认收到');
          }
        });

        // 4. 记录临时 ID
        chrome.storage.local.set({ __tempSelectTabId: tab.id });
        sendResponse({ success: true, tabId: tab.id });

      } catch (e) {
        console.error('[background.js:选择模式] -> 发生异常:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // 异步响应
  }

  // 处理 content 脚本返回的选择器和价格
  if (request.type === 'SELECTED_SELECTOR') {
    try {
      const { selector, price } = request.payload;
      console.log('[Background] 收到选择器:', selector, '价格:', price);

      // 1. 保存到本地 Storage
      chrome.storage.local.set({ customPriceSelector: selector }, () => {
        console.log('[Background] 自定义选择器已保存到本地');
      });

      // 2. [New] 上传到后端，以便 SettingsCenter 显示
      chrome.storage.local.get(['storeId', 'jwt'], async (data) => {
        if (data.storeId) {
          try {
            // 尝试更新后端配置
            // 注意：这里复用 uploadPrice 的 fetch 逻辑或者独立的 config update
            // 假设后端支持 POST /api/plugin/selector
            const apiUrl = `${API_BASE_URL}/api/stores/${data.storeId}/selector`;
            const res = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ selector })
            });
            if (res.ok) {
              console.log('[Background] 选择器已同步到云端');
            } else {
              console.warn('[Background] 选择器同步失败:', res.status);
            }
          } catch (err) {
            console.error('[Background] 上传选择器网络异常:', err);
          }
        }
      });

      // 关闭临时标签页（若存在）
      chrome.storage.local.get('__tempSelectTabId', (data) => {
        const tempTabId = data.__tempSelectTabId;
        if (tempTabId) {
          chrome.tabs.remove(tempTabId, () => {
            console.log('[Background] 临时选择标签已关闭', tempTabId);
            chrome.storage.local.remove('__tempSelectTabId');
          });
        }
      });
      // 将结果返回给 popup
      sendResponse({ success: true, selector, price });
    } catch (e) {
      console.error('[Background] SELECTED_SELECTOR 处理异常:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true; // 异步响应
  }
  // -----------------------------------

  if (request.type === 'GET_HOTEL_INFO') {
    getHotelByUrl(request.url).then(sendResponse);
    return true;
  }

  // 2. UPLOAD_PRICE (Modified for Batch)
  if (request.type === 'UPLOAD_PRICE') {
    // [Base] Lock check: Prevent double submission from same tab
    if (sender.tab && batchQueue.processingTabs.has(sender.tab.id)) {
      console.warn(`[Background] ⚠️ 拦截重复上传请求 (Tab: ${sender.tab.id})`);
      return false;
    }

    // [Base] Acquire Lock
    if (sender.tab) batchQueue.processingTabs.add(sender.tab.id);

    console.log('[Background] ===== UPLOAD_PRICE START =====');
    console.log('[Background] request.payload:', request.payload);

    uploadPrice(request.payload).then(res => {
      console.log('[Background] uploadPrice 完成，结果:', res);

      // If part of batch, mark complete
      if (batchQueue.isRunning && sender.tab) {
        batchQueue.completeTask(sender.tab.id, request.payload.price);
      } else {
        // If independent upload, release lock immediately
        if (sender.tab) batchQueue.processingTabs.delete(sender.tab.id);
      }

      sendResponse(res);
    }).catch(err => {
      console.error('[Background] Upload failed:', err);
      // Release lock on error
      if (sender.tab) batchQueue.processingTabs.delete(sender.tab.id);
      sendResponse({ success: false, error: err.message });
    });

    return true;
  }

  // 3. BATCH CONTROLS
  if (request.type === 'START_BATCH_SCRAPE') {
    chrome.storage.local.get(['hotels', 'taskConfig'], (data) => {
      if (data.hotels && data.hotels.length > 0) {
        // v4.9.14: 强制去重，防止重复抓取
        const uniqueHotels = [];
        const seenIds = new Set();
        data.hotels.forEach(h => {
          if (!seenIds.has(h.id)) {
            seenIds.add(h.id);
            uniqueHotels.push(h);
          }
        });

        console.log(`[Batch] 原始酒店数: ${data.hotels.length}, 去重后: ${uniqueHotels.length}`);

        // Filter out inactive hotels (Using weak equals for string/number tolerance)
        const activeHotels = uniqueHotels.filter(h => h.is_active != 0);
        console.log(`[Batch:Debug] 原始:${uniqueHotels.length} | 激活:${activeHotels.length}`);

        if (activeHotels.length === 0) {
          sendResponse({ success: false, error: '没有已激活的酒店可供抓取' });
          return;
        }

        let tasks = [];
        // Determine scrape type
        if (request.scrapeType === 'future') {
          console.log('[Background] 启动未来价格抓取任务...');
          tasks = generateFutureTasks(activeHotels, data.taskConfig || {});
        } else {
          console.log('[Background] 启动今日价格抓取任务...');
          const d = new Date();
          const todayStr = d.toISOString().split('T')[0];

          tasks = activeHotels.map(h => ({
            ...h,
            ctrip_url: h.ctrip_url || h.url,
            url: h.ctrip_url || h.url,
            type: 'today',
            targetDate: todayStr
          }));
        }

        // v4.9.17: 强制停止之前的任何任务
        batchQueue.stop();

        console.log(`[Batch] 生成任务总数: ${tasks.length}`);

        chrome.storage.local.set({ recentHistory: [] }, () => {
          batchQueue.load(tasks);
          batchQueue.broadcastState();
          sendResponse({ success: true, count: tasks.length });
        });
      } else {
        sendResponse({ success: false, error: '未找到酒店列表' });
      }
    });
    return true;
  }

  if (request.type === 'PAUSE_BATCH') {
    batchQueue.pause();
    return true;
  }

  if (request.type === 'RESUME_BATCH') {
    batchQueue.resume();
    return true;
  }

  if (request.type === 'STOP_BATCH') {
    batchQueue.stop();
    return true;
  }

  // 新增：保存手动选择器
  if (request.type === 'SAVE_SELECTOR') {
    saveSelector(request.selector).then(res => {
      sendResponse(res);
      // 同时也更新本地存储，立刻生效
      chrome.storage.local.set({ customPriceSelector: request.selector });
    });
    return true; // Keep channel open
  }

  // 新增：启动校准
  if (request.type === 'START_CALIBRATION') {
    chrome.tabs.create({ url: request.url, active: true }, (tab) => {
      // 复用 batchQueue 的等待逻辑
      batchQueue.waitForContentScript(tab.id, 15000).then(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'ENABLE_SELECT_MODE' }).catch(() => { });
      }).catch(err => {
        console.error('Calibration failed:', err);
      });
    });
    sendResponse({ success: true });
    return true;
  }

  // v4.9.11: 获取任务配置(用于popup显示未来天数)
  if (request.type === 'GET_TASK_CONFIG') {
    chrome.storage.local.get(['taskConfig'], (data) => {
      const config = data.taskConfig || {};
      sendResponse({
        futureDays: config.future_days || 7,
        futureDaysMin: config.future_days_min || 1,
        activeHours: config.active_hours || '07,08,09,10,11,12,13,14,15,16,17,18,19,20,21,22,23,00,01'
      });
    });
    return true; // Keep channel open for async response
  }

  // v4.15.0 Patch 11: Scheduler Info API
  // [v6.2.0] Enhanced Scheduler Info Relay
  if (request.type === 'GET_SCHEDULER_INFO') {
    chrome.alarms.getAll((alarms) => {
      const hourly = alarms.find(a => a.name === 'hourly_job');
      const daily = alarms.find(a => a.name === 'daily_job');
      sendResponse({
        nextHourly: hourly ? hourly.scheduledTime : null,
        nextDaily: daily ? daily.scheduledTime : null
      });
    });
    return true; // Keep channel open
  }

  if (request.type === 'TOGGLE_STORE') {
    const { storeId, enable } = request.payload;
    chrome.storage.local.get('activeStores', (data) => {
      let active = new Set(data.activeStores || []);
      if (enable) active.add(storeId);
      else active.delete(storeId);

      const newActive = Array.from(active);
      chrome.storage.local.set({ activeStores: newActive }, () => {
        // If disabled, we should probably purge tasks from queue? 
        // Or just let them run/fail? 
        // Better: When generating tasks, filter by activeStores. 
        // Implementing "Live" filtering in start_batch would be best.
        // For now, next batch will respect filters.
      });
    });
  }
});

// ==================== SELECTOR SAVING ====================
async function saveSelector(selector) {
  try {
    const { storeId } = await chrome.storage.local.get('storeId');
    if (!storeId) return { success: false, error: '未绑定门店 (请先同步配置)' };

    console.log('[Background] Saving Selector:', selector);

    // 1. Update Local Storage IMMEDIATELY (Critical for User Experience)
    await chrome.storage.local.set({ customPriceSelector: selector });

    // 2. Upload to Cloud (Persistence)
    const API_BASE = 'https://revenuepilot.wangqihao520.workers.dev';
    await fetch(`${API_BASE}/api/price-selectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId,
        selectorPath: selector,
        selectorType: 'css',
        testValue: 'manual_calibration'
      })
    });

    return { success: true };
  } catch (e) {
    console.error('Save selector failed:', e);
    return { success: false, error: e.message };
  }
}

// ==================== API SYNC ====================

// -----------------------------------
// Helper: Active Protocol Discovery
// 主动探测后端接口，获取真实的 Store ID
async function discoverStoreId(token, hintId = null) {
  let primaryId = hintId;
  let allAvailableStores = [];

  // 1. 获取门店列表
  try {
    const res = await fetch(`${API_BASE_URL}/api/client/stores`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.stores && Array.isArray(data.stores)) {
        allAvailableStores = data.stores;
        if (!primaryId && data.stores.length > 0) {
          primaryId = data.stores[0].id;
        }
      }
    }
  } catch (e) {
    console.warn('[Discovery] Failed to fetch store list:', e.message);
  }

  // 2. 如果还是没 ID，尝试 Probe
  if (!primaryId) {
    const endpoints = ['/api/user/me', '/api/client/config'];
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${API_BASE_URL}${endpoint}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const json = await res.json().catch(() => null);
        if (res.ok && json) {
          primaryId = scavengeStoreId(json);
          if (primaryId) break;
        }
      } catch (e) { }
    }
  }

  return { storeId: primaryId, availableStores: allAvailableStores };
}

// Helper: ID Scavenger (找回丢失的 ID)
function scavengeStoreId(data) {
  if (!data) return null;
  // 1. 显式 ID
  if (data.storeId) return data.storeId;
  if (data.store_id) return data.store_id;
  if (data.id && typeof data.id === 'string' && data.id.length > 20) return data.id; // UUID heuristic for store

  // 2. 配置包裹 (client/config)
  if (data.config) {
    if (data.config.storeId) return data.config.storeId;
    if (data.config.id) return data.config.id;
  }

  // 3. 用户关联 (auth/me - 注意区分 user.id 和 store.id)
  if (data.user) {
    if (data.user.storeId) return data.user.storeId;
    if (data.user.store_id) return data.user.store_id;
    // 不再将 user.id 作为 storeId 候选，防止冲突
  }
  return null;
}

// Helper: Sync Config with Multi-Store Support (Omni-Adaptive)
async function syncConfig(storeId, explicitJwt = null) {
  console.log(`[background.js:同步] -> 🔄 开始全能同步探测: [${storeId}]...`);

  // 1. 获取 Token
  let token = explicitJwt;
  if (!token) {
    const storage = await chrome.storage.local.get(['jwt']);
    token = storage.jwt;
  }

  // 2. 定义变体尝试队列 (String -> Number -> UserID fallback)
  const candidates = [];
  if (storeId) {
    candidates.push(String(storeId)); // "123"
    candidates.push(Number(storeId)); // 123
  }

  let validConfig = null;
  let lastError = null;
  let diagnosticContext = [];

  // 3. 循环尝试所有变体
  for (const idCandidate of candidates) {
    if (!idCandidate) continue;
    try {
      console.log(`[Sync] 🧪 尝试 ID 变体: ${idCandidate} (Type: ${typeof idCandidate})`);
      const url = `${API_BASE_URL}/api/client/config?storeId=${idCandidate}`;
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token || ''}`,
          'Content-Type': 'application/json'
        }
      });

      const json = await res.json().catch(() => ({ error: 'Parse Failed' }));
      diagnosticContext.push({
        id: idCandidate,
        status: res.status,
        payload: json
      });

      if (res.ok) {
        // [v6.4.0] Handle backend "config" wrapper
        const data = json.config || json;

        // 简单校验是否有效
        if (data && (data.storeName || data.taskConfig || data.selfHotel)) {
          console.log(`[Sync] ✅ 命中有效配置! ID: ${idCandidate}`);
          validConfig = data;
          break; // 成功退出循环
        }
      } else {
        console.warn(`[Sync] ⚠️ ID 变体 ${idCandidate} 失败 (Status: ${res.status})`);
      }
    } catch (e) {
      console.error(`[Sync] ❌ ID 变体 ${idCandidate} 异常:`, e);
      lastError = e;
    }
  }

  // 4. [v6.3.0] No more Silent Fallback. Fail clearly with diagnostic context.
  if (!validConfig) {
    console.error('[Sync] 🚨 所有 ID 探测均失败，无法获取配置。Context:', diagnosticContext);
    const error = new Error('未能从数据库获取到您的酒店配置信息');
    error.diagnostic = diagnosticContext;
    throw error;
  }

  const config = validConfig;
  const activeStoreId = config.storeId || config.id || storeId;

  // [v5.7.0] 强制复活调度器 (Ensures timer starts immediately)
  setupPrecisionAlarms();

  // [v6.6.9] ROOT CAUSE FIX: Fetch hotels from the dedicated endpoint
  // The 'config' endpoint often creates a stripped-down summary. 
  // We must hit the same endpoint the Web Frontend uses to guarantee URL presence.
  let allHotels = [];
  try {
    console.log(`[Sync] 📡 正在从全量接口获取酒店列表: /stores/${activeStoreId}/hotels`);
    const hotelsUrl = `${API_BASE_URL}/api/stores/${activeStoreId}/hotels`;
    const hotelRes = await fetch(hotelsUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (hotelRes.ok) {
      const hotelData = await hotelRes.json();
      if (hotelData.hotels && Array.isArray(hotelData.hotels)) {
        allHotels = hotelData.hotels.map(h => ({
          id: h.id,
          name: h.name,
          ctrip_url: h.ctrip_url, // Explicit Database Field
          url: h.ctrip_url,       // Legacy compat
          storeId: String(h.store_id),
          hotel_type: h.hotel_type, // 'self' or 'competitor'
          is_active: h.is_active
        }));
        console.log(`[Sync] ✅ 成功获取全量酒店数据: ${allHotels.length} 条`);
      }
    } else {
      console.warn(`[Sync] ⚠️ 全量接口请求失败 (${hotelRes.status})，回退到 Config 数据`);
      throw new Error('Hotels endpoint failed');
    }
  } catch (e) {
    console.warn('[Sync] ⚠️ 无法获取全量酒店，使用 Config 兜底:', e.message);
    // Fallback to original logic (using config object)
    const safeStoreId = String(activeStoreId);

    if (config?.selfHotel) {
      const hotel = { ...config.selfHotel };
      hotel.ctrip_url = hotel.ctrip_url || hotel.url || '';
      if (!hotel.ctrip_url && hotel.id) hotel.ctrip_url = `https://hotels.ctrip.com/hotels/${hotel.id}.html`;
      allHotels.push({ ...hotel, storeId: safeStoreId, hotel_type: 'self' });
    }

    if (config?.competitors) {
      config.competitors.forEach(h => {
        const hotel = { ...h };
        hotel.ctrip_url = hotel.ctrip_url || hotel.url || '';
        if (!hotel.ctrip_url && hotel.id) hotel.ctrip_url = `https://hotels.ctrip.com/hotels/${hotel.id}.html`;
        allHotels.push({ ...hotel, storeId: safeStoreId, hotel_type: 'competitor' });
      });
    }
  }

  // [v6.6.9.4] Use multi-key fallback for better compatibility
  const finalHotels = allHotels.map(h => ({
    ...h,
    ctrip_url: h.ctrip_url || h.ctripUrl || h.url || '',
    url: h.ctrip_url || h.ctripUrl || h.url || ''
  }));

  // Validate URLs one last time
  finalHotels.forEach(h => {
    // [v6.6.9.2] 增强补全逻辑：如果 ctrip_url 为空，根据 ID 暴力兜底
    const dbId = (h.ctrip_url || '').match(/\/hotels\/(\d+)\.html/)?.[1] || h.id;
    if (!h.ctrip_url || h.ctrip_url.length < 10) {
      h.ctrip_url = `https://hotels.ctrip.com/hotels/${dbId}.html`;
      h.url = h.ctrip_url;
      console.log(`[Sync] 🛠️ 补全 URL -> ${h.name}: ${h.ctrip_url}`);
    }
  });

  interval_hours: 1
};

// [v6.6.9.1] SELECTOR SYNC: Try to find a global or hotel-specific selector
let serverSelector = config.priceSelector || config.customPriceSelector || null;

// If not in root config, try to find in self hotel
if (!serverSelector && config.selfHotel?.price_selector) {
  serverSelector = config.selfHotel.price_selector;
}

if (serverSelector) {
  console.log(`[Sync] 🎯 发现云端选择器配置: ${serverSelector}`);
  await chrome.storage.local.set({ customPriceSelector: serverSelector });
}

// 3. 全量更新本地存储
await chrome.storage.local.set({
  storeId: activeStoreId,
  storeName: combinedName,
  hotels: allHotels,
  taskConfig: taskConfig,
  lastSync: Date.now()
});

console.log(`[background.js:同步] -> 💾 配置已落库，共 ${allHotels.length} 个监测对象`);
return { success: true, name: combinedName, count: allHotels.length, config: config };
}

// 2. 根据 URL 匹配酒店
async function getHotelByUrl(currentUrl) {
  const data = await chrome.storage.local.get(['hotels', 'storeId']);
  if (!data.hotels) return { hotelId: null };

  // 简单的 URL 包含匹配 (Production should use stricter normalization)
  // 比如: ctrip.com/hotels/12345.html
  const hotels = data.hotels || [];
  const matched = hotels.find(h => currentUrl.includes(h.ctrip_url));

  return {
    hotelId: matched?.id || null,
    storeId: data.storeId,
    hotelName: matched?.name
  };
}

// 3. 上报数据
async function uploadPrice(payload) {
  console.log(`[background.js:上传价格] -> 🚀 开始执行价格上传流程...`);
  console.log(`[background.js:上传价格] -> 收到的 payload:`, payload);

  try {
    const API_BASE = API_BASE_URL; // 统一使用顶层定义的地址

    // 获取 storeId 和匹配 hotelId
    const data = await chrome.storage.local.get(['storeId', 'hotels']);
    let storeId = data.storeId;

    console.log(`[background.js:上传价格] -> 当前本地 storeId: ${storeId}`);
    console.log(`[background.js:上传价格] -> 本地 hotels 列表长度: ${data.hotels?.length || 0}`);

    // 根据 URL 匹配酒店 (优化：提取酒店ID进行匹配)
    let hotelId = null;
    let matchedHotel = null;
    if (data.hotels && payload.url) {
      const hotelIdMatch = payload.url.match(/\/hotels\/(\d+)\.html/);
      const currentHotelId = hotelIdMatch ? hotelIdMatch[1] : null;

      console.log(`[background.js:上传价格] -> 当前页面 URL: ${payload.url}`);
      console.log(`[background.js:上传价格] -> 提取到的携程酒店 ID: ${currentHotelId}`);

      if (currentHotelId) {
        matchedHotel = data.hotels.find(h => {
          const ctripUrl = (h.ctrip_url || '').trim();
          const otherUrl = (h.url || '').trim();
          const dbHotelIdMatch = ctripUrl.match(/\/hotels\/(\d+)\.html/) || otherUrl.match(/\/hotels\/(\d+)\.html/);
          const dbHotelId = dbHotelIdMatch ? dbHotelIdMatch[1] : null;
          return dbHotelId === currentHotelId;
        });
      }

      if (!matchedHotel) {
        console.warn(`[background.js:上传价格] -> ⚠️ ID 匹配失败，尝试 URL 模糊匹配...`);
        matchedHotel = data.hotels.find(h => {
          const ctripUrl = (h.ctrip_url || '').trim();
          const otherUrl = (h.url || '').trim();
          return (ctripUrl && payload.url.includes(ctripUrl)) || (otherUrl && payload.url.includes(otherUrl));
        });
      }

      hotelId = matchedHotel?.id;

      // v4.16.3: Support dynamic storeId for multi-store plugins
      if (matchedHotel && matchedHotel.storeId) {
        storeId = matchedHotel.storeId;
        console.log(`[background.js:上传价格] -> ✅ 酒店匹配成功: ${matchedHotel.name} (ID: ${hotelId}) -> 路由到门店: ${storeId}`);
      } else if (matchedHotel) {
        console.log(`[background.js:上传价格] -> ✅ 酒店匹配成功: ${matchedHotel.name} (ID: ${hotelId})`);
      } else {
        console.warn(`[background.js:上传价格] -> ⚠️ 无法在本地库中匹配到该酒店，url: ${payload.url}`);
      }
    }

    if (payload.hotelId && payload.hotelId !== 'unknown') {
      hotelId = payload.hotelId;
      console.log(`[background.js:上传价格] -> 🛡️ 使用 Payload 自带的 Hotel ID: ${hotelId}`);
    }

    const apiPayload = {
      storeId: storeId,
      hotelId: hotelId || 'unknown',
      type: payload.fetchType || 'today',
      date: payload.targetDate || null,
      error: payload.error || null,
      prices: [{
        price: payload.price,
        roomType: payload.roomType || ''
      }]
    };

    const uploadKey = `${apiPayload.storeId}|${apiPayload.hotelId}|${apiPayload.date}|${apiPayload.prices[0].price}`;
    const now = Date.now();
    recentUploads.set(uploadKey, now);

    // 定期清理过期的缓存 (保留最近100条)
    if (recentUploads.size > 100) {
      const firstKey = recentUploads.keys().next().value;
      recentUploads.delete(firstKey);
    }

    console.log('[uploadPrice] 发送到后端:', apiPayload);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // [Defensive] 30s Network Timeout

    const res = await fetch(`${API_BASE}/api/plugin/prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiPayload),
      signal: controller.signal
    });

    clearTimeout(timeoutId); // Clear timeout on success

    console.log('[uploadPrice] HTTP 状态码:', res.status);

    const json = await res.json();

    if (json.success) {
      console.log('[uploadPrice] ✅ 上传成功:', json);
    } else {
      console.error('[uploadPrice] ❌ 上传失败:', json);
    }

    console.log('[uploadPrice] ===== 上传结束 =====');
    return json;
  } catch (err) {
    console.error('[uploadPrice] ❌ 网络异常:', err);
    return { success: false, error: err.message };
  }
}

// ==================== SCHEDULER & HELPERS ====================

// [v4.13.0] Precision Scheduler Implementation
// Ensures tasks run EXACTLY at HH:00:00 and 00:05:00

// [v6.6.6] Cleaned up legacy listener

chrome.runtime.onStartup.addListener(() => {
  setupPrecisionAlarms();
});

// Calculate and set up the alarms
async function setupPrecisionAlarms() {
  console.log('[Scheduler] Setting up Precision Alarms...');

  // Clear old "polling" alarms
  await chrome.alarms.clear('scheduler');
  await chrome.alarms.clear('hourly_job');
  await chrome.alarms.clear('daily_job');

  const now = new Date();

  // 1. Next Hourly Job (HH:00:00)
  // Calculate ms until next hour
  const nextHour = new Date(now);
  nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0); // Next top of hour

  // Create periodic alarm (starting from nextHour, repeating every 60 mins)
  chrome.alarms.create('hourly_job', {
    when: nextHour.getTime(),
    periodInMinutes: 60
  });
  console.log(`[Scheduler] Next Hourly Job set for: ${nextHour.toLocaleTimeString()}`);

  // 2. Next Daily Job (05:00:00)
  const nextDaily = new Date(now);
  if (now.getHours() < 5) {
    // If it's before 5:00, schedule for 05:00 today
    nextDaily.setHours(5, 0, 0, 0);
  } else {
    // Schedule for tomorrow 05:00
    nextDaily.setDate(nextDaily.getDate() + 1);
    nextDaily.setHours(5, 0, 0, 0);
  }

  chrome.alarms.create('daily_job', {
    when: nextDaily.getTime(),
    periodInMinutes: 1440 // 24 hours
  });
  console.log(`[Scheduler] Next Daily Job set for: ${nextDaily.toLocaleString()}`);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const triggerTime = new Date().toLocaleString();
  console.log(`[Alarm] 触发: ${alarm.name} at ${triggerTime}`);

  if (alarm.name === 'hourly_job') {
    console.log(`[Alarm Handler] ⏰ 处理 hourly_job...`);
    handleHourlyJob();
  } else if (alarm.name === 'RP_BATCH_KEEPALIVE') {
    // v4.15.0 Patch 8: Keep-Alive Heartbeat
    console.log('[KeepAlive] Heartbeat check...');
    if (batchQueue.isRunning) {
      if (batchQueue.processingTabs.size === 0 && batchQueue.activeTabs.size === 0) {
        console.warn('[KeepAlive] Queue stalled, restarting process...');
        batchQueue.process();
      }
      batchQueue.broadcastState();
    } else {
      chrome.alarms.clear('RP_BATCH_KEEPALIVE');
    }
  } else if (alarm.name === 'daily_job') {
    console.log(`[Alarm Handler] 🗓️ 处理 daily_job...`);
    handleDailyJob();
  } else if (alarm.name === 'config_sync' || alarm.name === 'AUTO_SYNC') {
    console.log(`[Alarm Handler] ⚙️ 处理 config_sync / AUTO_SYNC...`);
    chrome.storage.local.get(['storeId'], (d) => {
      if (d.storeId) {
        syncConfig(d.storeId);
      } else {
        console.warn('[Alarm Handler] config_sync/AUTO_SYNC: No storeId found, skipping sync.');
      }
    });
  }
  else if (alarm.name.startsWith('retry_')) {
    // [v4.13.6] Handle 5-minute retry
    const data = await chrome.storage.local.get(alarm.name);
    if (data[alarm.name]) {
      const task = data[alarm.name];
      chrome.storage.local.remove(alarm.name);
      console.log('[Scheduler] 🔄 执行重试任务:', task.hotelName);
      batchQueue.load([task]); // Load as a small single-task batch or push to current
    }
  }
});

async function handleHourlyJob() {
  const data = await chrome.storage.local.get(['taskConfig', 'hotels']);
  if (!data.taskConfig || !data.hotels || data.hotels.length === 0) return;

  const conf = data.taskConfig;
  const currentHour = new Date().getHours();

  // Active Hours Check
  // Active Hours Check - [Safety Defaults: 07:00 - 01:00]
  const DEFAULT_HOURS = '07,08,09,10,11,12,13,14,15,16,17,18,19,20,21,22,23,00,01';
  const activeHoursStr = conf.active_hours || conf.activeHours || DEFAULT_HOURS;
  const activeHours = activeHoursStr.split(',').map(Number).filter(n => !isNaN(n));

  if (activeHours.includes(currentHour)) {
    console.log(`[Scheduler] ⏰ 今日任务精准触发 (${currentHour}:00) -> 正在生成任务列表...`);
    // Filter active hotels
    const activeHotels = data.hotels.filter(h => h.is_active !== 0);
    console.log(`[Scheduler] 激活酒店数: ${activeHotels.length} / ${data.hotels.length}`);

    if (activeHotels.length === 0) {
      console.log('[Scheduler] No active hotels for hourly job. Skipping.');
      return;
    }

    const tasks = activeHotels.map(h => ({ ...h, type: 'today' }));
    batchQueue.load(tasks);
    chrome.storage.local.set({ lastTodayRun: Date.now() });
  } else {
    console.log(`[Scheduler] Skip Hourly Job: ${currentHour}:00 not in active hours`);
  }
}

async function handleDailyJob() {
  const data = await chrome.storage.local.get(['taskConfig', 'hotels']);
  if (!data.taskConfig || !data.hotels || data.hotels.length === 0) {
    console.warn('[Scheduler] Skipping Daily Job: No configuration or hotels found.');
    return;
  }

  console.log(`[Scheduler] ⏰ 未来任务精准触发 (05:00) -> 正在生成未来 30 天任务...`);
  const tasks = generateFutureTasks(data.hotels, data.taskConfig);
  batchQueue.load(tasks);
  chrome.storage.local.set({ lastFutureRun: Date.now() });
}

function isToday(date) {
  const now = new Date();
  return date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
}

function generateFutureTasks(hotels, config) {
  // v4.9.14 (Hotfix): 强制从明天(T+1)开始
  const minDays = Math.max(1, config.future_days_min || config.futureDaysMin || 1);
  const maxDays = config.future_days || config.futureScrapeDays || 7;

  console.log(`[TaskGen] 配置: minDays=${minDays}, maxDays=${maxDays}`);

  const tasks = [];
  const seenTaskKeys = new Set(); // Key: hotelId_date

  const formatDate = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const hotelsList = (hotels || []).filter(h => h.is_active !== 0);
  console.log(`[TaskGen] 激活酒店数: ${hotelsList.length} / ${hotels ? hotels.length : 0}`);

  hotelsList.forEach(hotel => {
    const base = hotel.ctrip_url || hotel.url;
    if (!base) {
      console.warn(`[TaskGen] 酒店 ${hotel.name} 无 URL，跳过`);
      return;
    }

    for (let i = minDays; i <= maxDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const checkIn = formatDate(d);

      const nextD = new Date(d);
      nextD.setDate(d.getDate() + 1);
      const checkOut = formatDate(nextD);

      const taskKey = `${hotel.id}_${checkIn}`;

      // 双重去重保护
      if (seenTaskKeys.has(taskKey)) continue;
      seenTaskKeys.add(taskKey);

      let cleanUrl = base;
      try {
        const urlObj = new URL(base);

        // v4.9.16 (Systemic Fix): 暴力重建 URL，丢弃所有原有参数，防止干扰
        // 只保留 origin (https://hotels.ctrip.com) 和 pathname (/hotels/123.html)
        // 然后强制附加我们的参数
        const params = new URLSearchParams();
        params.set('checkIn', checkIn);
        params.set('checkOut', checkOut);

        cleanUrl = `${urlObj.origin}${urlObj.pathname}?${params.toString()}`;

        if (i === minDays) { // Log first task for debug
          console.log(`[TaskGen] REBUILT URL for ${hotel.name}: ${cleanUrl}`);
        }
      } catch (e) {
        console.warn('Invalid Base URL:', base);
        continue;
      }

      tasks.push({
        ...hotel,
        url: cleanUrl, // 这是一个完全清洗并重建的 URL
        targetDate: checkIn,
        type: 'future'
      });
    }
  });

  return tasks;
}
