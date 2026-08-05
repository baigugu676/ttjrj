// API 封装（微信云开发版）
// 将原先基于 wx.request 的 HTTP 调用，统一改为 wx.cloud.callFunction 云函数调用。
// 对外保留与原版一致的接口：api.get / api.post / api.put / api.del / api.upload，
// 因此各页面无需改动。请求地址如 '/orders' 会在此处映射为对应的云函数 + action。
const { CLOUD_ENV } = require('./config.js');

// 云开发初始化（模块加载时执行一次）
const cloudConfig = {};
if (CLOUD_ENV) cloudConfig.env = CLOUD_ENV;
wx.cloud.init(Object.assign({ traceUser: true }, cloudConfig));

// 兼容保留：原版用于拼接图片绝对地址，云存储 fileID 无需前缀，置空即可
const SERVER_BASE = '';
const BASE_URL = '';

/**
 * 云函数调用统一入口
 * @param {String} name      云函数名（login/users/locations/orders/statistics/notifications）
 * @param {Object} data      云函数入参
 * @param {Object} options   { loading, loadingText, silent }
 */
function callCloud(name, data = {}, options = {}) {
  const { loading = true, loadingText = '加载中...', silent = false } = options;
  return new Promise((resolve, reject) => {
    if (loading) {
      wx.showLoading({ title: loadingText, mask: true });
    }
    let settled = false;
    // 超时兜底：云函数默认 3s 超时，留 5s 余量防止冷启动延迟
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (loading) wx.hideLoading();
      const msg = '请求超时，请重试';
      if (!silent) wx.showToast({ title: msg, icon: 'none' });
      reject(new Error(msg));
    }, 10000);
    wx.cloud.callFunction({
      name,
      data,
      success: (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = res && res.result;
        if (result && typeof result === 'object' && 'code' in result && result.code !== 0) {
          const msg = result.message || '请求失败';
          if (!silent) wx.showToast({ title: msg, icon: 'none' });
          reject(new Error(msg));
        } else if (result === undefined || result === null) {
          const msg = '云函数调用失败，请稍后重试';
          if (!silent) wx.showToast({ title: msg, icon: 'none' });
          reject(new Error(msg));
        } else {
          // 统一解包 { code, data, message } 中的 data，与原有返回语义保持一致
          const payload = result && typeof result === 'object' && 'data' in result ? result.data : result;
          resolve(payload);
        }
      },
      fail: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (loading) wx.hideLoading();
        const msg = (err && err.errMsg) || '网络异常，请检查网络后重试';
        if (!silent) wx.showToast({ title: msg, icon: 'none' });
        reject(new Error(msg));
      },
      complete: () => {
        // complete 总是最后执行，用于兜底清理 loading
        if (loading && !settled) wx.hideLoading();
      }
    });
  });
}

/**
 * 将原 HTTP 方法 + 路径 + 参数，映射为 云函数名 + 入参
 */
function resolveTarget(method, url, data) {
  const segs = url.split('?')[0].split('/').filter(Boolean);
  const first = segs[0];

  // /auth/login —— 账号密码登录 或 微信一键登录
  if (first === 'auth' && segs[1] === 'login' && method === 'POST') {
    if (data && data.username && data.password) {
      return { name: 'login', data: { action: 'password', username: data.username, password: data.password } };
    }
    return {
      name: 'login',
      data: { action: 'wechat', nickname: (data && data.nickname) || '', avatar: (data && data.avatar) || '' }
    };
  }

  // /orders...
  if (first === 'orders') {
    const id = segs[1];
    const sub = segs[2];
    if (!id) {
      if (method === 'POST') return { name: 'orders', data: Object.assign({ action: 'create' }, data) };
      if (method === 'GET') return { name: 'orders', data: Object.assign({ action: 'list' }, data) };
    }
    if (method === 'GET') return { name: 'orders', data: Object.assign({ action: 'detail', id }, data) };
    if (method === 'DELETE') return { name: 'orders', data: { action: 'delete', id } };
    if (sub === 'review') {
      // 避免 data.action 覆盖路由的 action：将原 action 重命名为 review_action
      const merged = { action: 'review', id };
      if (data && data.action) { merged.review_action = data.action; delete data.action; }
      return { name: 'orders', data: Object.assign(merged, data) };
    }
    if (sub === 'accept') {
      const merged = { action: 'accept', id };
      if (data && data.action) { merged.accept_action = data.action; delete data.action; }
      return { name: 'orders', data: Object.assign(merged, data) };
    }
    if (sub === 'accept-repair') return { name: 'orders', data: { action: 'acceptRepair', id } };
    if (sub === 'repair') return { name: 'orders', data: Object.assign({ action: 'repair', id }, data) };
  }

  // /locations...
  if (first === 'locations') {
    const id = segs[1];
    if (!id) {
      if (method === 'GET') return { name: 'locations', data: { action: 'list' } };
      if (method === 'POST') return { name: 'locations', data: Object.assign({ action: 'create' }, data) };
    }
    if (method === 'PUT') return { name: 'locations', data: Object.assign({ action: 'update', id }, data) };
    if (method === 'DELETE') return { name: 'locations', data: { action: 'delete', id } };
  }

  // /users...
  if (first === 'users') {
    const id = segs[1];
    const sub = segs[2];
    if (!id) {
      if (method === 'GET') return { name: 'users', data: Object.assign({ action: 'list' }, data) };
      if (method === 'POST') return { name: 'users', data: Object.assign({ action: 'create' }, data) };
    }
    if (sub === 'status') return { name: 'users', data: Object.assign({ action: 'status', id }, data) };
    if (method === 'PUT') return { name: 'users', data: Object.assign({ action: 'update', id }, data) };
    if (method === 'DELETE') return { name: 'users', data: { action: 'delete', id } };
  }

  // /statistics/...
  if (first === 'statistics') {
    const actionMap = {
      'overview': 'overview',
      'status-distribution': 'statusDistribution',
      'trend': 'trend',
      'location-ranking': 'locationRanking',
      'repairer-workload': 'repairerWorkload'
    };
    const act = actionMap[segs[1]];
    if (act) return { name: 'statistics', data: { action: act } };
  }

  // /notifications...
  if (first === 'notifications') {
    const id = segs[1];
    const sub = segs[2];
    if (!id && method === 'GET') return { name: 'notifications', data: Object.assign({ action: 'list' }, data) };
    if (sub === 'read') return { name: 'notifications', data: Object.assign({ action: 'read', id }, data) };
    if (sub === 'read-all') return { name: 'notifications', data: { action: 'readAll' } };
    if (sub === 'unread-count') return { name: 'notifications', data: { action: 'unreadCount' } };
  }

  throw new Error('未匹配到云函数接口：' + method + ' ' + url);
}

/**
 * 通用请求方法（映射到云函数）
 * @param {String} method  原 HTTP 方法（仅用于路径匹配）
 * @param {String} url     接口路径（如 /orders、/orders/12/review）
 * @param {Object} data    参数
 * @param {Object} options 配置项：{ loading, loadingText, silent }
 */
function request(method, url, data = {}, options = {}) {
  let target;
  try {
    target = resolveTarget(method, url, data);
  } catch (e) {
    return Promise.reject(e);
  }
  return callCloud(target.name, target.data, options);
}

/**
 * 图片上传（云存储版）
 * 1. wx.cloud.uploadFile 上传到云存储，得到 cloud:// fileID
 * 2. 调用 orders.addImage 将图片记录写入 order_images 集合
 * @param {String} filePath 本地文件路径
 * @param {Object} formData { order_id, image_type }
 * @param {Object} options  { loading, silent }
 */
function upload(filePath, formData = {}, options = {}) {
  const { loading = true, silent = false } = options;
  return new Promise((resolve, reject) => {
    if (loading) {
      wx.showLoading({ title: '上传中...', mask: true });
    }
    const orderId = formData.order_id || 'unknown';
    const extMatch = /\.(\w+)$/.exec(filePath || '');
    const ext = extMatch ? extMatch[1] : 'jpg';
    const cloudPath = 'order_images/' + orderId + '/' + Date.now() + '-' + Math.round(Math.random() * 1e6) + '.' + ext;

    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (res) => {
        const fileID = res.fileID;
        // 记录到 order_images；即使记录失败也不影响图片已上传
        callCloud('orders', {
          action: 'addImage',
          order_id: formData.order_id,
          image_url: fileID,
          image_type: formData.image_type || 'report'
        }, { loading: false, silent: true }).then((result) => {
          resolve({ url: fileID, fileID, order_image_id: result && result.order_image_id });
        }).catch(() => {
          resolve({ url: fileID, fileID, order_image_id: null });
        });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '网络异常，上传失败';
        if (!silent) wx.showToast({ title: msg, icon: 'none' });
        reject(new Error(msg));
      },
      complete: () => {
        if (loading) wx.hideLoading();
      }
    });
  });
}

module.exports = {
  SERVER_BASE,
  BASE_URL,
  callCloud,
  get(url, params, options) {
    return request('GET', url, params, options);
  },
  post(url, data, options) {
    return request('POST', url, data, options);
  },
  put(url, data, options) {
    return request('PUT', url, data, options);
  },
  del(url, options) {
    return request('DELETE', url, {}, options);
  },
  upload
};
