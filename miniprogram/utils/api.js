// API 请求封装：统一 baseURL、自动携带 token、统一 loading 与错误处理
// 后端接口地址配置
const BASE_URL = 'http://101.245.109.239:3000/api';

/**
 * 基础请求方法
 * @param {String} method  请求方法 GET/POST/PUT/DELETE
 * @param {String} url     接口路径（不含 baseURL，如 /orders）
 * @param {Object} data    请求参数
 * @param {Object} options 配置项：{ loading: 是否显示loading, loadingText: loading文案, silent: 失败时是否静默 }
 */
function request(method, url, data = {}, options = {}) {
  const { loading = true, loadingText = '加载中...', silent = false } = options;
  return new Promise((resolve, reject) => {
    if (loading) {
      wx.showLoading({ title: loadingText, mask: true });
    }
    // 自动携带 token
    const token = wx.getStorageSync('token');
    wx.request({
      url: BASE_URL + url,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        'Authorization': token ? 'Bearer ' + token : ''
      },
      success: (res) => {
        // 401：token 过期或未登录，清空本地登录态并跳转登录页
        if (res.statusCode === 401) {
          wx.removeStorageSync('token');
          wx.removeStorageSync('userInfo');
          const app = getApp();
          if (app && app.globalData) {
            app.globalData.token = '';
            app.globalData.userInfo = null;
          }
          wx.reLaunch({ url: '/pages/login/login' });
          reject(new Error('登录已过期，请重新登录'));
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const body = res.data;
          // 兼容两种返回格式：{ code, data, message } 或 直接返回数据
          if (body && typeof body === 'object' && 'code' in body && body.code !== 0) {
            const msg = body.message || '请求失败';
            if (!silent) wx.showToast({ title: msg, icon: 'none' });
            reject(new Error(msg));
          } else {
            const result = body && typeof body === 'object' && 'data' in body ? body.data : body;
            resolve(result);
          }
        } else {
          const msg = (res.data && (res.data.message || res.data.msg)) || '请求失败，请重试';
          if (!silent) wx.showToast({ title: msg, icon: 'none' });
          reject(new Error(msg));
        }
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '网络异常，请检查网络后重试';
        if (!silent) wx.showToast({ title: msg, icon: 'none' });
        reject(new Error(msg));
      },
      complete: () => {
        if (loading) wx.hideLoading();
      }
    });
  });
}

/**
 * 文件上传（自动携带 token）
 * @param {String} filePath 本地文件路径
 * @param {Object} formData 附带表单字段
 * @param {Object} options  配置项：{ loading, silent }
 */
function upload(filePath, formData = {}, options = {}) {
  const { loading = true, silent = false } = options;
  return new Promise((resolve, reject) => {
    if (loading) {
      wx.showLoading({ title: '上传中...', mask: true });
    }
    const token = wx.getStorageSync('token');
    wx.uploadFile({
      url: BASE_URL + '/upload',
      filePath,
      name: 'file',
      formData,
      header: {
        'Authorization': token ? 'Bearer ' + token : ''
      },
      success: (res) => {
        if (res.statusCode === 401) {
          wx.removeStorageSync('token');
          wx.removeStorageSync('userInfo');
          wx.reLaunch({ url: '/pages/login/login' });
          reject(new Error('登录已过期，请重新登录'));
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let body = {};
          try {
            body = JSON.parse(res.data || '{}');
          } catch (e) {
            // 后端返回非 JSON，按原始字符串处理
            body = res.data;
          }
          if (body && typeof body === 'object' && 'code' in body && body.code !== 0) {
            if (!silent) wx.showToast({ title: body.message || '上传失败', icon: 'none' });
            reject(new Error(body.message || '上传失败'));
          } else {
            // 上传成功返回文件 URL 或 { data: url }
            resolve(body && typeof body === 'object' && 'data' in body ? body.data : body);
          }
        } else {
          if (!silent) wx.showToast({ title: '上传失败，请重试', icon: 'none' });
          reject(new Error('上传失败'));
        }
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
  BASE_URL,
  // GET 请求
  get(url, params, options) {
    return request('GET', url, params, options);
  },
  // POST 请求
  post(url, data, options) {
    return request('POST', url, data, options);
  },
  // PUT 请求
  put(url, data, options) {
    return request('PUT', url, data, options);
  },
  // DELETE 请求
  del(url, options) {
    return request('DELETE', url, {}, options);
  },
  // 上传文件
  upload
};
