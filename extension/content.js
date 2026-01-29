// content.js - v6.6.9.4_20260127_1600 Smart Engine 
// 智能抓取引擎：Cloud Rules + Visual Heuristic + Calendar Automation

console.log('酒店收益管理系统 插件脚本(v6.6.9.4) 已加载');
console.log('[content.js:初始化] -> 🚀 智能引擎已就绪');

class SmartScraper {
  constructor() {
    this.config = null;
    this.storeId = null;
    this.lastRightClickedEl = null; // v3.4.0 Calibration
    // [Fix] Setup listeners IMMEDIATELY to catch PING from background
    this.setupListeners();
    this.init();
  }

  async init() {
    const data = await chrome.storage.local.get(['selectorRules', 'storeId']);
    this.config = data.selectorRules || null;
    this.storeId = data.storeId || null;

    console.log('[SmartScraper] v4.0 初始化完成. Store:', this.storeId);
    console.log('[SmartScraper] 配置:', this.config);

    console.log('[SmartScraper] v4.0 初始化完成. Store:', this.storeId);
    console.log('[SmartScraper] 配置:', this.config);

    this.setupContextMenuTracker();
  }

  setupContextMenuTracker() {
    // 右键菜单标定功能
    document.addEventListener('contextmenu', (e) => {
      this.lastRightClickedEl = e.target;
      // 视觉反馈
      e.target.classList.add('rp-context-target');
      setTimeout(() => e.target.classList.remove('rp-context-target'), 1000);
    }, true);
  }

  setupListeners() {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      console.log('[SmartScraper] 收到消息:', req.type);

      // v4.13.1: Login Status Check (Ctrip specific)
      if (req.type === 'CHECK_LOGIN') {
        const isLoggedIn = this.checkLoginStatus();
        const username = this.getCtripUsername();
        sendResponse({ loggedIn: isLoggedIn, username: username });
        return true;
      }

      // v3.4.0 Calibration Handler
      if (req.type === 'CALIBRATE_ELEMENT') {
        if (this.lastRightClickedEl) {
          const price = this.extractNumber(this.lastRightClickedEl.textContent);
          console.log('[Calibration] 标定价格:', price);
          this.reportLearning(this.lastRightClickedEl, price || 0);
        }
        return true;
      }

      // v4.9.4 Fix: Heartbeat Handler
      if (req.type === 'PING') {
        sendResponse({ status: 'pong' });
        return true;
      }

      // 手动选择模式启动
      if (req.type === 'ENABLE_SELECT_MODE') {
        this.enableSelectMode();
        return true;
      }

      if (req.type === 'START_SCRAPE_TODAY') {
        console.log('[SmartScraper] 开始抓取今日价格...');
        this.currentHotelId = req.hotelId;

        this.runScrape('today').then(price => {
          // [v4.15.0 Guard] Check result validity
          if (price === null || price === undefined || price === -1) {
            // If result is bad, check login status immediately
            if (!this.checkLoginStatus()) {
              console.warn('[Guard] 抓取失败且未登录 -> 弹出警告');
              this.showLoginWarning();
              // Do NOT upload failure yet, let user login. Or upload "0" to indicate failure?
              // Current logic: uploadPrice(null)
            }
          }

          if (price !== null && price !== undefined) {
            this.uploadPrice(price, 'today');
          } else {
            this.uploadPrice(null, 'today');
          }
        }).catch(err => {
          this.uploadPrice(null, 'today');
        });
        return true;
      }

      if (req.type === 'START_SCRAPE_FUTURE') {
        console.log('[SmartScraper] 开始抓取未来价格...');
        this.currentTargetDate = req.targetDate;
        this.currentHotelId = req.hotelId;

        this.runScrape('future').then(price => {
          // [v4.15.0 Guard] Check result validity
          if (price === null || price === undefined || price === -1) {
            if (!this.checkLoginStatus()) {
              console.warn('[Guard] 抓取失败且未登录 -> 弹出警告');
              this.showLoginWarning();
            }
          }

          if (price !== null && price !== undefined) {
            this.uploadPrice(price, 'future', req.targetDate);
          } else {
            this.uploadPrice(null, 'future', req.targetDate);
          }
        }).catch(err => {
          this.uploadPrice(null, 'future', req.targetDate);
        });
        return true;
      }
    });
  }

  /* 抓取逻辑 (Strict Mode) */
  async runScrape(mode) {
    console.log(`[SmartScraper] ===== 开始抓取 (${mode}) =====`);
    console.log(`[SmartScraper] 当前URL: ${window.location.href}`);

    // 0. 等待页面动态加载
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 1. 获取唯一指定的 Custom Selector
    let selector = null;
    try {
      const data = await chrome.storage.local.get('customPriceSelector');
      selector = data.customPriceSelector;
      console.log('[SmartScraper] 加载配置选择器:', selector);
    } catch (e) {
      console.error('[SmartScraper] 读取配置失败:', e);
    }

    if (!selector) {
      console.warn('[SmartScraper] ❌ 未配置价格选择器 (Strict Mode)');
      console.warn('[SmartScraper] 请先在插件中进行"选择价格元素"校准');
      return null;
    }

    // 2. 尝试使用选择器抓取
    try {
      // 智能等待元素出现 (Max 5s)
      await this.waitForElement(selector, 5000);

      // v4.16.0: Retry Logic
      let el = null;
      for (let i = 0; i < 10; i++) {
        el = document.querySelector(selector);
        if (el) break;
        if (i < 9) await new Promise(r => setTimeout(r, 500));
      }

      if (el) {
        const p = this.extractNumber(el.textContent);
        if (p) {
          console.log(`[SmartScraper] ✅ 抓取成功: ¥${p}`);
          // [Fix] 只返回价格，由调用方统一上传，避免重复调用
          return p;
        } else {
          console.warn('[SmartScraper] 元素存在但无法提取数字:', el.textContent);
        }
      } else {
        console.warn('[SmartScraper] 页面未找到选择器对应元素:', selector);
      }
    } catch (e) {
      console.error('[SmartScraper] 抓取过程异常:', e);
      // Fallthrough to Sold Out check
    }

    // 3. [v4.10.5] Aggressive Sold Out Logic (User Directive)
    // 用户指令: "判断逻辑简单粗暴一点，抓不到价格就显示满房"
    // 假设: 价格元素位置固定，如果消失，则意味着满房。
    if (!selector) {
      console.warn('[SmartScraper] 无选择器，无法判定');
      return null;
    }

    console.warn(`[SmartScraper] ⚠️ 无法提取价格 (Selector: ${selector}) -> 判定为满房 (Aggressive Mode)`);
    return -1; // Force Sold Out
  }

  // --- Layer 1 & 2 REMOVED as per Strict Mode Policy ---

  // 辅助函数
  isVisible(el) {
    return el.offsetParent !== null && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  isColorRed(colorStr) {
    const rgb = colorStr.match(/\d+/g);
    if (!rgb || rgb.length < 3) return false;
    const [r, g, b] = rgb.map(Number);
    return r > 150 && g < 100 && b < 100;
  }

  extractNumber(text) {
    if (!text) return null;
    const match = text.replace(/[,，]/g, '').match(/\d+(\.\d+)?/);
    const result = match ? parseFloat(match[0]) : null;
    console.log(`[extractNumber] 输入: "${text}", 输出: ${result}`);
    return result;
  }

  highlightSuccess(price) {
    const div = document.createElement('div');
    div.style.cssText = `
      position: fixed; top: 20px; right: 20px; z-index: 999999;
      background: ${price === -1 ? '#ef4444' : '#10b981'}; color: white; padding: 15px 25px;
      border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.3);
      font-size: 15px; font-weight: bold; border: 2px solid rgba(255,255,255,0.2);
      animation: rp-slide-in 0.3s ease-out;
    `;
    div.textContent = price === -1 ? `❌ 已满房 (Sold Out)` : `✅ 抓取成功: ¥${price}`;
    document.body.appendChild(div);
    setTimeout(() => {
      div.style.opacity = '0';
      div.style.transition = 'opacity 0.5s';
      setTimeout(() => div.remove(), 500);
    }, 3000);
  }

  // v4.13.3: Login Check & UI
  checkLoginStatus() {
    const html = document.documentElement.innerHTML;
    // Ctrip specific login indicators: existence of logout button or user info
    const loggedInIndicators = ['退出登录', 'logout', 'userInfo', '账号管理', '用户名'];
    const isLoginPage = window.location.href.includes('passport.ctrip.com') || window.location.href.includes('login');

    if (isLoginPage) return false;

    // Check for "Please Login" text which often appears when scraping fails
    const needsLoginText = ['请登录', '登录后查看', '请先登录'];
    for (const text of needsLoginText) {
      if (html.includes(text)) return false;
    }

    // Try to find common Ctrip E-Booking login elements
    return loggedInIndicators.some(ind => html.includes(ind));
  }

  // v4.16.0: Enhanced Login Detection Scope
  getCtripUsername() {
    try {
      // 1. URL Heuristics (Strongest Signal)
      // Identity: my.ctrip.com or passport.ctrip.com/user/member -> Definitely Logged In
      const currentUrl = window.location.href;
      if (currentUrl.includes('my.ctrip.com') ||
        currentUrl.includes('passport.ctrip.com/user/member') ||
        currentUrl.includes('ctrip.com/myinfo')) {

        // Try to find a name, but if not found, default to 'Ctrip User' because we ARE logged in
        const nameEl = document.querySelector('.current_user_name, .name strong, .user-name, .s-name, .account_name');
        return nameEl ? nameEl.textContent.trim() : '携程用户';
      }

      // 2. Common selectors for username in Ctrip E-Booking / Hotel List / Personal Center
      const selectors = [
        '.user_name',
        '.nav_login_user',
        '#user_name',
        '.login_info_name',
        '.account_name',
        // New selectors for Personal Center / other pages
        '.c-user-name',
        '.name strong',
        '.inf-name',
        '#lblUserName'
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          return el.textContent.trim();
        }
      }

      // Check for specific EBK patterns
      const ebkUser = document.querySelector('.ebk-user-name');
      if (ebkUser) return ebkUser.textContent.trim();

      return null;
    } catch (e) {
      console.warn('[SmartScraper] 提取用户名异常:', e);
      return null;
    }
  }

  showLoginWarning() {
    if (document.getElementById('rp-login-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'rp-login-modal';
    modal.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(15, 23, 42, 0.9); z-index: 1000000;
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(8px); font-family: sans-serif;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background: white; padding: 40px; border-radius: 24px;
      max-width: 450px; width: 90%; text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    `;

    card.innerHTML = `
      <div style="background:#fee2e2; width:80px; height:80px; border-radius:50%; display:flex; align-items:center; justify-content:center; margin: 0 auto 20px;">
        <svg style="width:40px; height:40px; color:#ef4444" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
      </div>
      <h2 style="margin:0 0 10px; color:#1e293b; font-size:22px; font-weight:800;">抓取失败：账号未登录</h2>
      <p style="color:#64748b; font-size:15px; line-height:1.6; margin-bottom:30px;">
        由于您的携程账号已自动退出，系统无法读取竞争对比价格。请重新登录后再进行采集任务。
      </p>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
        <button id="rp-btn-close" style="padding:12px; background:#f1f5f9; border:none; border-radius:12px; color:#475569; font-weight:600; cursor:pointer;">取消</button>
        <a href="https://hotels.ctrip.com/hotel/hotel-list" target="_blank" style="padding:12px; background:#2563eb; border:none; border-radius:12px; color:white; font-weight:600; text-decoration:none; display:flex; align-items:center; justify-content:center;">去登录后台</a>
      </div>
    `;

    modal.appendChild(card);
    document.body.appendChild(modal);

    document.getElementById('rp-btn-close').onclick = () => modal.remove();
  }

  uploadPrice(price, type = 'today', targetDate = null, error = null) {
    console.log('[uploadPrice] ===== 开始上传价格 =====');
    console.log('[uploadPrice] 价格:', price);
    console.log('[uploadPrice] 类型:', type);
    console.log('[uploadPrice] 目标日期:', targetDate);
    console.log('[uploadPrice] 当前URL:', window.location.href);

    // [v4.10.0] 满房(-1) 也是有效数据，或者正常价格验证
    const isValidPrice = (price === -1) || (price && price >= 50 && price <= 10000);

    if (!isValidPrice) {
      console.error('[uploadPrice] 价格异常，拒绝上传!', {
        价格: price,
        原因: !price ? '价格为空' : price < 50 ? '价格过低(< 50)' : '价格过高(> 10000)'
      });
      // 仍然发送消息通知 background 任务完成（虽然失败）
      chrome.runtime.sendMessage({
        type: 'UPLOAD_PRICE',
        payload: {
          price: 0, // Send 0 or null for failure
          url: window.location.href,
          roomType: '',
          fetchType: type,
          targetDate: targetDate, // Ensure targetDate is passed
          hotelId: this.currentHotelId,
          error: !price ? '价格为空' : '价格异常'
        }
      });
      return;
    }

    const payload = {
      price: price,
      url: window.location.href,
      roomType: '',
      fetchType: type,
      targetDate: targetDate,
      hotelId: this.currentHotelId // [Fix] 回传 hotelId
    };

    console.log('[uploadPrice] 上传数据:', payload);

    chrome.runtime.sendMessage({
      type: 'UPLOAD_PRICE',
      payload: payload
    }, (response) => {
      console.log('[uploadPrice] 上传结果:', response);
      if (response && response.success) {
        this.highlightSuccess(price);
      } else {
        console.error('[uploadPrice] 上传失败:', response);
      }
    });

    console.log('[uploadPrice] ===== 上传请求已发送 =====');
  }

  reportLearning(el, price) {
    const selector = this.generateSelector(el);
    console.log('[Learning] 生成选择器:', selector, '价格:', price);

    chrome.runtime.sendMessage({
      type: 'REPORT_LEARNING',
      payload: {
        selector: selector,
        price: price,
        url: window.location.href,
        domain: window.location.hostname
      }
    });
  }

  // 智能等待元素
  waitForElement(selector, timeout = 5000) {
    return new Promise(resolve => {
      if (document.querySelector(selector)) {
        return resolve(document.querySelector(selector));
      }
      const observer = new MutationObserver(mutations => {
        if (document.querySelector(selector)) {
          resolve(document.querySelector(selector));
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  // 满房检测
  detectFullRoom() {
    const fullRoomKeywords = ['已满房', '售罄', '不可预订', 'sold out', 'full', 'no rooms', '客满', '订完', '暂无价格', '仅剩0间'];
    const bodyText = document.body.innerText;
    for (const keyword of fullRoomKeywords) {
      if (bodyText.includes(keyword)) {
        return true;
      }
    }
    return false;
  }

  generateSelector(el) {
    if (el.id) return `#${el.id}`;
    if (el.className) {
      const classes = el.className.split(' ').filter(c => c && !c.match(/\d/));
      if (classes.length > 0) return `.${classes[0]}`;
    }
    return el.tagName.toLowerCase();
  }
  // 生成唯一 CSS 选择器
  getUniqueSelector(el) {
    if (!el) return null;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += `#${cur.id}`;
        parts.unshift(part);
        break;
      } else {
        const siblings = Array.from(cur.parentNode.children).filter(s => s.tagName === cur.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${index})`;
        }
        parts.unshift(part);
        cur = cur.parentElement;
      }
    }
    return parts.join(' > ');
  }

  // 手动选择模式实现
  enableSelectMode() {
    console.log('[SmartScraper] 启用手动选择模式');

    // 注入高亮样式
    const styleId = 'rp-highlight-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .rp-hover-target { box-shadow: 0 0 0 2px #ef4444 !important; background: rgba(239, 68, 68, 0.1) !important; cursor: crosshair !important; }
      `;
      document.head.appendChild(style);
    }

    const mouseOverHandler = (e) => {
      e.target.classList.add('rp-hover-target');
    };
    const mouseOutHandler = (e) => {
      e.target.classList.remove('rp-hover-target');
    };

    const clickHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const el = e.target;
      el.classList.remove('rp-hover-target');

      const textValue = el.textContent.trim();
      const price = this.extractNumber(textValue);
      const selector = this.getUniqueSelector(el);

      console.log(`[content.js:选择模式] -> 用户点击元素: ${selector} (文本: ${textValue})`);

      if (confirm(`确认要将此元素设为价格吗？\n\n提取价格: ¥${price || '未知'}\n选择器: ${selector}`)) {
        console.log('[SmartScraper] 用户确认选择器:', selector);

        chrome.runtime.sendMessage({ type: 'SAVE_SELECTOR', selector: selector }, (response) => {
          if (response && response.success) {
            alert('✅ 选择器已保存！下次抓取将优先使用此元素。');
          } else {
            alert('❌ 保存失败: ' + (response?.error || '未知错误'));
          }
        });
      }

      cleanup();
    };

    const cleanup = () => {
      document.removeEventListener('mouseover', mouseOverHandler, true);
      document.removeEventListener('mouseout', mouseOutHandler, true);
      document.removeEventListener('click', clickHandler, true);
      const style = document.getElementById(styleId);
      if (style) style.remove();
      clearTimeout(timeoutId);
    };

    document.addEventListener('mouseover', mouseOverHandler, true);
    document.addEventListener('mouseout', mouseOutHandler, true);
    document.addEventListener('click', clickHandler, true);

    const timeoutId = setTimeout(() => {
      console.warn('[SmartScraper] 手动选择超时，退出模式');
      cleanup();
    }, 60000); // 60s timeout
  }

}

// 初始化
const scraper = new SmartScraper();
