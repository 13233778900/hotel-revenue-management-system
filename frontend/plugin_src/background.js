const API_BASE_URL = 'https://revenuepilot.wangqihao520.workers.dev';

// 初始化
const INJECTED_STORE_ID = '__STORE_ID__'; // 将由 PluginManager 在下载时替换

chrome.runtime.onInstalled.addListener(async () => {
    console.log(`[background.js:初始化] -> ✅ 酒店收益管理系统 扩展已安装/更新 (v4.16.5)`);

    // 创建右键菜单 (容错性：如果失败不阻塞后续流程)
    try {
        chrome.contextMenus.create({
            id: "rp-calibrate",
            title: "👉 设为价格元素 (RevenuePilot)",
            contexts: ["all"]
        });
        console.log(`[background.js:初始化] -> ✅ 右键菜单创建成功`);
    } catch (e) {
        console.warn(`[background.js:初始化] -> ⚠️ 右键菜单创建失败 (可忽略):`, e.message);
    }

    // 零配置初始化：保存 Store ID 并强制同步
    if (INJECTED_STORE_ID && !INJECTED_STORE_ID.startsWith('__')) {
        await chrome.storage.local.set({ storeId: INJECTED_STORE_ID });
        console.log(`[background.js:初始化] -> ✅ 自动载入门店 ID: ${INJECTED_STORE_ID}`);
        // 立即同步
        await forceSync();
    } else {
        console.warn(`[background.js:初始化] -> ⚠️ 未检测到有效的 Store ID，可能需要手动配置`);
    }
});

chrome.runtime.onStartup.addListener(() => {
    console.log(`[background.js:启动] -> 🚀 扩展已就绪`);
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
    console.warn(`[background.js:右键处理] -> ⚠️ 注册失败:`, e.message);
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
        this.queue = [];
        this.activeTabs = new Map();
        this.processingTabs = new Set();
        this.results = [];
        this.isRunning = false;
        this.isPaused = false;
        this.total = 0;
        this.concurrency = 1;
        this.batchId = 0;
        this.consecutiveFailures = 0;
        this.hydrate();
    }

    async hydrate() {
        try {
            const data = await chrome.storage.local.get(['batchState', 'batchQueue', 'multiStoreConfigs', 'activeStores']);
            if (data.batchQueue && data.batchQueue.length > 0) {
                this.queue = data.batchQueue;
                this.total = this.queue.length;
                this.batchId = (data.batchState && data.batchState.batchId) ? data.batchState.batchId : Date.now();
                console.log(`[background.js:任务队列] -> 📦 恢复了 ${this.queue.length} 个历史抓取任务`);
                this.broadcastState();
            }
            if (data.multiStoreConfigs && !data.activeStores) {
                const allIds = data.multiStoreConfigs.map(c => c.storeId);
                chrome.storage.local.set({ activeStores: allIds });
            }
        } catch (e) {
            console.error(`[background.js:任务队列] -> ❌ 恢复状态失败: ${e.message}`);
        }
    }

    broadcastState() {
        // implementation...
    }
}

// 2. 根据 URL 匹配酒店 (面包屑日志注入)
async function getHotelByUrl(currentUrl) {
    console.log(`[background.js:匹配酒店] -> 🔎 正在查找 URL 匹配: ${currentUrl}`);
    const data = await chrome.storage.local.get(['hotels', 'storeId']);
    if (!data.hotels) {
        console.warn(`[background.js:匹配酒店] -> ⚠️ 酒店库为空，无法匹配`);
        return { hotelId: null };
    }

    const matched = data.hotels.find(h => currentUrl.includes(h.ctrip_url));
    if (matched) {
        console.log(`[background.js:匹配酒店] -> ✅ 找到匹配: ${matched.name} (ID: ${matched.id})`);
    } else {
        console.warn(`[background.js:匹配酒店] -> ⚠️ 未找到匹配的酒店配置`);
    }

    return {
        hotelId: matched?.id || null,
        storeId: data.storeId,
        hotelName: matched?.name
    };
}

// 3. 上报数据 (核心加固版)
async function uploadPrice(payload) {
    console.log(`[background.js:上传价格] -> 🚀 开始执行价格上传流程...`);
    console.log(`[background.js:上传价格] -> 收到的原始 Payload:`, payload);

    try {
        const API_BASE = API_BASE_URL;

        // 获取 storeId 和匹配 hotelId
        const data = await chrome.storage.local.get(['storeId', 'hotels']);
        let storeId = data.storeId;

        console.log(`[background.js:上传价格] -> 1. 数据校验: 默认 storeId [${storeId}], hotels 库大小: ${data.hotels?.length || 0}`);

        // 根据 URL 匹配酒店
        let hotelId = null;
        let matchedHotel = null;
        if (data.hotels && payload.url) {
            const hotelIdMatch = payload.url.match(/\/hotels\/(\d+)\.html/);
            const currentHotelId = hotelIdMatch ? hotelIdMatch[1] : null;

            console.log(`[background.js:上传价格] -> 2. URL 提取: 识别到页面酒店 ID [${currentHotelId}]`);

            if (currentHotelId) {
                matchedHotel = data.hotels.find(h => {
                    const ctripUrl = (h.ctrip_url || '').trim();
                    const otherUrl = (h.url || '').trim();
                    const dbHotelIdMatch = ctripUrl.match(/\/hotels\/(\d+)\.html/) || otherUrl.match(/\/hotels\/(\d+)\.html/);
                    const dbId = dbHotelIdMatch ? dbHotelIdMatch[1] : null;
                    return dbId === currentHotelId;
                });
            }

            if (!matchedHotel) {
                console.warn(`[background.js:上传价格] -> ⚠️ ID 匹配失败，尝试模糊匹配...`);
                matchedHotel = data.hotels.find(h => {
                    const ctripUrl = (h.ctrip_url || '').trim();
                    const otherUrl = (h.url || '').trim();
                    return (ctripUrl && payload.url.includes(ctripUrl)) || (otherUrl && payload.url.includes(otherUrl));
                });
            }

            hotelId = matchedHotel?.id;

            if (matchedHotel && matchedHotel.storeId) {
                storeId = matchedHotel.storeId;
                console.log(`[background.js:上传价格] -> 3. 路由重定向: 匹配到门店 [${storeId}]`);
            }
        }

        if (payload.hotelId && payload.hotelId !== 'unknown') {
            hotelId = payload.hotelId;
            console.log(`[background.js:上传价格] -> 4. 强制覆盖: 使用 Payload 自带的 ID [${hotelId}]`);
        }

        const apiPayload = {
            storeId: storeId,
            hotelId: hotelId || 'unknown',
            type: payload.fetchType || 'today',
            date: payload.targetDate || null,
            error: payload.error || null,
            prices: [{ price: payload.price, roomType: payload.roomType || '' }]
        };

        // 重复校验
        const uploadKey = `${apiPayload.storeId}|${apiPayload.hotelId}|${apiPayload.date}|${apiPayload.prices[0].price}`;
        const now = Date.now();
        if (recentUploads.has(uploadKey)) {
            const lastTime = recentUploads.get(uploadKey);
            if (now - lastTime < 15000) {
                console.warn(`[background.js:上传价格] -> 🛑 拦截最近上报过的完全重复数据`);
                return { success: true, message: 'Duplicate blocked' };
            }
        }
        recentUploads.set(uploadKey, now);

        // 发送请求
        console.log(`[background.js:上传价格] -> 📡 正在发送请求到: ${API_BASE}/api/plugin/prices`);
        const res = await fetch(`${API_BASE}/api/plugin/prices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(apiPayload)
        });

        const json = await res.json();
        if (json.success) {
            console.log(`[background.js:上传价格] -> ✅ 后端接收成功! `, json);
        } else {
            console.error(`[background.js:上传价格] -> ❌ 后端拒绝上报:`, json);
        }
        return json;

    } catch (err) {
        console.error(`[background.js:上传价格] -> ❌ 上传发生严重错误:`, err.stack);
        return { success: false, error: err.message };
    }
}

async function syncConfig(id) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/stores/${id}/config`);
        return await res.json();
    } catch (e) {
        return { success: false, error: e.message };
    }
}
