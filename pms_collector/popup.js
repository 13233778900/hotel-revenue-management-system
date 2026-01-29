// PMS数据采集助手 - Popup脚本
// v1.0.0 - 初始版本

console.log('PMS数据采集助手 Popup 已加载 v1.0.0');

// DOM元素
const apiBaseInput = document.getElementById('apiBase');
const storeIdInput = document.getElementById('storeId');
const saveBtn = document.getElementById('saveBtn');
const statusDiv = document.getElementById('status');
const versionDiv = document.getElementById('version');

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Popup DOM已加载，初始化配置');
  await loadConfig();
  
  // 添加事件监听
  saveBtn.addEventListener('click', saveConfig);
  
  console.log('Popup初始化完成');
});

// 加载配置
async function loadConfig() {
  try {
    const config = await getConfig();
    
    // 填充表单
    apiBaseInput.value = config.apiBase || '';
    storeIdInput.value = config.storeId || '';
    
    // 更新版本信息
    versionDiv.textContent = `v${config.version || '1.0.0'}`;
    
    console.log('配置加载成功:', config);
  } catch (error) {
    console.error('加载配置失败:', error);
    showStatus('加载配置失败', 'error');
  }
}

// 保存配置
async function saveConfig() {
  try {
    // 获取表单数据
    const config = {
      apiBase: apiBaseInput.value.trim(),
      storeId: storeIdInput.value.trim(),
      version: '1.0.0'
    };
    
    // 验证必填项
    if (!config.apiBase) {
      showStatus('API地址不能为空', 'error');
      return;
    }
    
    // 保存配置
    const result = await chrome.runtime.sendMessage({
      action: 'saveConfig',
      config: config
    });
    
    if (result && result.success) {
      showStatus('配置保存成功', 'success');
      console.log('配置保存成功:', config);
    } else {
      showStatus('配置保存失败', 'error');
      console.error('配置保存失败:', result);
    }
  } catch (error) {
    console.error('保存配置失败:', error);
    showStatus('配置保存失败', 'error');
  }
}

// 获取配置
async function getConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: 'getConfig'
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('获取配置失败:', chrome.runtime.lastError);
        resolve({});
      } else {
        resolve(response || {});
      }
    });
  });
}

// 显示状态消息
function showStatus(message, type = 'info') {
  statusDiv.textContent = message;
  statusDiv.className = `pms-status ${type}`;
  
  // 3秒后清除消息
  setTimeout(() => {
    statusDiv.textContent = '';
    statusDiv.className = 'pms-status';
  }, 3000);
}