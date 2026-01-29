// PMS数据采集助手 - Content Script
// v1.0.0 - 初始版本

console.log('PMS数据采集助手 Content Script 已加载 v1.0.0');

// PMS识别配置
const PMS_CONFIG = {
  targetUrls: [
    'https://cmsplus.zhuzher.com/datacenter/report/forward',
    'https://cmsplus.zhuzher.com/datacenter/report/operation/realtime'
  ],
  indicators: {
    '平均房价': ['平均房价', 'ADR', 'Avg. Rate'],
    '入住率': ['入住率', 'Occ.', 'Occupancy'],
    'RevPAR': ['RevPAR', '每间可售房收入'],
    'GMV': ['GMV', '总收入', 'Revenue', '总营收'],
    '远期出租率': ['远期出租率', 'Forward Occ.'],
    '预定进度': ['预定进度', 'Booking Pace']
  }
};

// 页面状态
let pageState = {
  isTargetPage: false,
  isReportPage: false,
  extractedData: null,
  uploadButton: null,
  previewPanel: null
};

// 页面加载完成后检查
window.addEventListener('load', () => {
  console.log('页面加载完成，检查是否为目标PMS页面');
  checkTargetPage();
});

// 监听来自后台的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content Script 收到消息:', message);
  
  if (message.action === 'extractData') {
    extractData().then(sendResponse);
    return true;
  } else if (message.action === 'uploadData') {
    uploadData().then(sendResponse);
    return true;
  } else if (message.action === 'ping') {
    sendResponse({ success: true, message: 'pong' });
  }
  
  return true;
});

// 检查当前页面是否为目标PMS页面
function checkTargetPage() {
  try {
    const currentUrl = window.location.href;
    console.log('当前URL:', currentUrl);
    
    // 检查是否匹配目标URL
    pageState.isTargetPage = PMS_CONFIG.targetUrls.some(url => {
      return currentUrl.startsWith(url);
    });
    
    if (pageState.isTargetPage) {
      console.log('✅ 识别为目标PMS页面');
      
      // 检查是否为报表页面
      checkIfReportPage();
    } else {
      console.log('❌ 不是目标PMS页面');
    }
  } catch (error) {
    console.error('检查目标页面失败:', error);
  }
}

// 检查是否为报表页面
function checkIfReportPage() {
  try {
    // 查找页面中的表格元素
    const tables = document.querySelectorAll('table');
    console.log('找到表格数量:', tables.length);
    
    if (tables.length > 0) {
      pageState.isReportPage = true;
      console.log('✅ 识别为报表页面，开始提取数据');
      
      // 提取数据
      extractData().then(data => {
        if (data && Object.keys(data).length > 0) {
          console.log('✅ 成功提取PMS数据:', data);
          pageState.extractedData = data;
          createUploadButton();
        } else {
          console.log('❌ 未能提取有效数据');
        }
      });
    }
  } catch (error) {
    console.error('检查报表页面失败:', error);
  }
}

// 提取数据
async function extractData() {
  try {
    const tables = document.querySelectorAll('table');
    
    // 遍历所有表格，尝试提取数据
    for (const table of tables) {
      const data = extractDataFromTable(table);
      if (data && Object.keys(data).length > 0) {
        return data;
      }
    }
    
    return null;
  } catch (error) {
    console.error('提取数据失败:', error);
    return null;
  }
}

// 从表格中提取数据
function extractDataFromTable(table) {
  try {
    const rows = table.querySelectorAll('tr');
    if (rows.length < 2) return null;
    
    const headers = [];
    const data = {};
    
    // 提取表头
    const headerRow = rows[0];
    const headerCells = headerRow.querySelectorAll('th, td');
    headerCells.forEach(cell => {
      const text = cell.textContent.trim();
      if (text) {
        headers.push(text);
      }
    });
    
    console.log('提取到表头:', headers);
    
    // 提取数据行
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td');
      if (cells.length !== headers.length) continue;
      
      // 检查每行数据
      for (let j = 0; j < cells.length; j++) {
        const header = headers[j];
        const cellText = cells[j].textContent.trim();
        
        // 匹配关键指标
        for (const [indicator, aliases] of Object.entries(PMS_CONFIG.indicators)) {
          if (aliases.some(alias => header.includes(alias) || cellText.includes(alias))) {
            // 提取数值
            const value = extractNumericValue(cellText);
            if (value !== null) {
              data[indicator] = value;
            }
            break;
          }
        }
      }
    }
    
    return data;
  } catch (error) {
    console.error('从表格提取数据失败:', error);
    return null;
  }
}

// 提取数值
function extractNumericValue(text) {
  try {
    // 移除所有非数字和小数点
    let cleanText = text.replace(/[^\d.]/g, '');
    
    // 处理百分比
    if (text.includes('%')) {
      const num = parseFloat(cleanText);
      return num / 100; // 转换为小数
    }
    
    const num = parseFloat(cleanText);
    return isNaN(num) ? null : num;
  } catch (error) {
    console.error('提取数值失败:', error);
    return null;
  }
}

// 创建一键上传按钮
function createUploadButton() {
  try {
    // 检查按钮是否已存在
    if (pageState.uploadButton) {
      return;
    }
    
    // 创建按钮
    const button = document.createElement('button');
    button.className = 'pms-upload-button';
    button.innerHTML = `
      <span>📊 一键上传PMS数据</span>
    `;
    
    // 添加点击事件
    button.addEventListener('click', handleUploadClick);
    
    // 添加到页面
    document.body.appendChild(button);
    pageState.uploadButton = button;
    
    console.log('✅ 创建一键上传按钮');
  } catch (error) {
    console.error('创建上传按钮失败:', error);
  }
}

// 处理上传按钮点击
async function handleUploadClick() {
  try {
    const button = pageState.uploadButton;
    button.innerHTML = `
      <span class="pms-status-indicator"></span>
      <span>上传中...</span>
    `;
    button.classList.add('loading');
    
    // 提取数据
    let data = pageState.extractedData;
    if (!data || Object.keys(data).length === 0) {
      data = await extractData();
      if (!data || Object.keys(data).length === 0) {
        showMessage('❌ 未能提取数据', 'error');
        resetButton();
        return;
      }
      pageState.extractedData = data;
    }
    
    // 上传数据
    const result = await uploadData();
    
    if (result.success) {
      button.innerHTML = `
        <span class="pms-icon">✅</span>
        <span>上传成功</span>
      `;
      button.classList.remove('loading');
      button.classList.add('success');
      showMessage('✅ 数据上传成功', 'success');
      
      // 3秒后恢复按钮
      setTimeout(() => {
        resetButton();
      }, 3000);
    } else {
      button.innerHTML = `
        <span class="pms-icon">❌</span>
        <span>上传失败</span>
      `;
      button.classList.remove('loading');
      button.classList.add('error');
      showMessage(`❌ 上传失败: ${result.error}`, 'error');
      
      // 3秒后恢复按钮
      setTimeout(() => {
        resetButton();
      }, 3000);
    }
  } catch (error) {
    console.error('处理上传点击失败:', error);
    showMessage(`❌ 上传失败: ${error.message}`, 'error');
    resetButton();
  }
}

// 重置按钮状态
function resetButton() {
  if (pageState.uploadButton) {
    pageState.uploadButton.innerHTML = `
      <span>📊 一键上传PMS数据</span>
    `;
    pageState.uploadButton.classList.remove('loading', 'success', 'error');
  }
}

// 显示消息
function showMessage(text, type = 'info') {
  try {
    // 创建消息元素
    const message = document.createElement('div');
    message.className = `pms-message ${type}`;
    message.textContent = text;
    
    // 添加到页面
    document.body.appendChild(message);
    
    // 3秒后移除
    setTimeout(() => {
      message.remove();
    }, 3000);
  } catch (error) {
    console.error('显示消息失败:', error);
  }
}

// 上传数据到服务器
async function uploadData() {
  try {
    let data = pageState.extractedData;
    if (!data || Object.keys(data).length === 0) {
      data = await extractData();
      if (!data || Object.keys(data).length === 0) {
        return { success: false, error: '未能提取有效数据' };
      }
      pageState.extractedData = data;
    }
    
    console.log('准备上传数据:', data);
    
    // 获取配置
    const config = await getConfig();
    const apiBase = config.apiBase || 'https://revenuepilot.wangqihao520.workers.dev';
    const storeId = config.storeId;
    
    if (!storeId) {
      return { success: false, error: '未配置门店ID' };
    }
    
    // 构建请求数据
    const requestData = {
      storeId: storeId,
      data: data,
      date: new Date().toISOString().split('T')[0],
      source: 'pms_collector_plugin',
      pageUrl: window.location.href
    };
    
    // 发送请求
    const response = await fetch(`${apiBase}/api/daily-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(requestData)
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log('✅ 数据上传成功:', result);
      return { success: true, result: result };
    } else {
      const errorText = await response.text();
      console.error('❌ 数据上传失败:', response.status, errorText);
      return { success: false, error: `${response.status}: ${errorText}` };
    }
  } catch (error) {
    console.error('❌ 数据上传失败:', error);
    return { success: false, error: error.message };
  }
}

// 获取配置
function getConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: 'getConfig'
    }, (response) => {
      resolve(response || {});
    });
  });
}