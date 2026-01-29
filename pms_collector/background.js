// PMS数据采集助手 - Background Service Worker
// v1.0.0 - 初始版本

console.log('PMS数据采集助手 Background Service Worker 已启动 v1.0.0');

// 全局状态
let pluginState = {
  isInitialized: false,
  config: null
};

// 监听来自content script或popup的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background 收到消息:', message);
  
  if (message.action === 'getConfig') {
    // 获取插件配置
    getConfig().then(sendResponse);
    return true;
  } else if (message.action === 'saveConfig') {
    // 保存插件配置
    saveConfig(message.config).then(sendResponse);
    return true;
  } else if (message.action === 'uploadData') {
    // 从后台触发数据上传
    if (sender.tab && sender.tab.id) {
      triggerUploadInTab(sender.tab.id).then(sendResponse);
    } else {
      sendResponse({ success: false, error: '无法获取当前标签页' });
    }
    return true;
  } else if (message.action === 'ping') {
    sendResponse({ success: true, message: 'pong' });
  }
  
  return true;
});

// 插件安装时初始化
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('插件已安装/更新:', details.reason);
  
  // 初始化配置
  await initializeConfig();
  
  // 创建右键菜单
  createContextMenus();
  
  pluginState.isInitialized = true;
  console.log('插件初始化完成');
});

// 初始化配置
async function initializeConfig() {
  try {
    const config = await getConfig();
    
    // 如果没有配置，设置默认值
    if (!config.apiBase) {
      await saveConfig({
        apiBase: 'https://revenuepilot.wangqihao520.workers.dev',
        storeId: '',
        version: '1.0.0'
      });
    }
  } catch (error) {
    console.error('初始化配置失败:', error);
  }
}

// 获取配置
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['pmsCollectorConfig'], (result) => {
      const config = result.pmsCollectorConfig || {
        apiBase: 'https://revenuepilot.wangqihao520.workers.dev',
        storeId: '',
        version: '1.0.0'
      };
      pluginState.config = config;
      resolve(config);
    });
  });
}

// 保存配置
async function saveConfig(config) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      pmsCollectorConfig: {
        ...pluginState.config,
        ...config
      }
    }, () => {
      pluginState.config = {
        ...pluginState.config,
        ...config
      };
      resolve({ success: true });
    });
  });
}

// 创建右键菜单
function createContextMenus() {
  try {
    // 移除现有菜单
    chrome.contextMenus.removeAll(() => {
      // 添加新菜单
      chrome.contextMenus.create({
        id: 'uploadPmsData',
        title: '📊 上传PMS数据',
        contexts: ['page'],
        documentUrlPatterns: [
          'https://cmsplus.zhuzher.com/datacenter/report/forward',
          'https://cmsplus.zhuzher.com/datacenter/report/operation/realtime'
        ]
      });
      
      console.log('✅ 已创建右键菜单');
    });
  } catch (error) {
    console.error('创建右键菜单失败:', error);
  }
}

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  console.log('右键菜单点击:', info.menuItemId, tab);
  
  if (info.menuItemId === 'uploadPmsData' && tab.id) {
    // 向当前标签页发送消息，触发数据上传
    triggerUploadInTab(tab.id).then(result => {
      console.log('上传结果:', result);
    });
  }
});

// 触发标签页中的数据上传
async function triggerUploadInTab(tabId) {
  return new Promise((resolve) => {
    // 确保content script已注入
    ensureContentScript(tabId).then(() => {
      // 发送上传消息
      chrome.tabs.sendMessage(tabId, {
        action: 'uploadData'
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('发送消息失败:', chrome.runtime.lastError);
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else if (response) {
          resolve(response);
        } else {
          resolve({ success: false, error: '无响应' });
        }
      });
    }).catch(error => {
      console.error('确保content script失败:', error);
      resolve({ success: false, error: error.message });
    });
  });
}

// 确保content script已注入
async function ensureContentScript(tabId) {
  try {
    // 尝试ping content script
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (response && response.success) {
      console.log('Content script 已就绪');
      return true;
    }
  } catch (error) {
    console.log('Content script 未就绪，尝试注入...');
  }
  
  // 如果没有响应，手动注入
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    
    // 等待一下让脚本初始化
    await sleep(500);
    
    console.log('Content script 注入成功');
    return true;
  } catch (error) {
    console.error('注入 content script 失败:', error);
    throw error;
  }
}

// 工具函数：延迟
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 监听标签页关闭事件
chrome.tabs.onRemoved.addListener((tabId) => {
  // 可以在这里清理与标签页相关的状态
  console.log('标签页已关闭:', tabId);
});