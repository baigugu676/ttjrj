// 新建报修页：点位选择 + 故障描述 + 照片上传（最多9张）+ 维修要求
// 提交逻辑（与后端接口对齐）：
//   1. 先 POST /api/orders 创建工单，拿到工单 id
//   2. 再逐张上传照片（image_type=report，携带 order_id），由后端写入 order_images 表
//   3. 全部完成 → 跳转列表页
// 免审核规则：admin 报修需当场选择维修人员；repairer 报修自动指派本人；
//            二者提交后工单直接进入待维修（跳过审核）。
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    role: '',             // 当前角色（user/repairer/admin）
    isAdmin: false,       // 管理员：需选择指派维修人员
    isRepairer: false,    // 维修人员：免审核，自动指派本人
    repairers: [],        // 可指派的维修人员列表（仅 admin 使用）
    repairerNames: [],    // 维修人员姓名（picker 展示用）
    repairerIndex: -1,    // 选中维修人员下标
    locations: [],        // 点位列表（来自 /api/locations）
    filteredLocations: [], // 当前搜索结果
    locationKeyword: '',  // 点位搜索关键词
    locationNames: [],    // 点位名称（picker 展示用）
    locationIndex: -1,    // 当前选中点位下标
    locationId: '',       // 选中点位 id
    description: '',      // 故障描述
    requirements: '',     // 维修要求（选填）
    images: [],           // 已选图片 [{ tempPath }]
    submitting: false,    // 是否正在提交
    uploadProgress: 0
  },

  onLoad() {
    const app = getApp();
    if (!app.checkLogin()) return;
    const role = (app.getUserInfo() && app.getUserInfo().role) || 'user';
    this.setData({
      role,
      isAdmin: role === 'admin',
      isRepairer: role === 'repairer'
    });
    this.loadLocations();
    if (role === 'admin') this.loadRepairers();
  },

  onPullDownRefresh() {
    this.loadLocations();
    wx.stopPullDownRefresh();
  },

  // 获取点位列表
  loadLocations() {
    api.get('/locations', {}, { loading: false }).then((list) => {
      const locations = Array.isArray(list) ? list : [];
      this.setData({
        locations,
        filteredLocations: locations,
        locationNames: locations.map((l) => this.getLocationLabel(l))
      });
    }).catch((err) => {
      console.error('[create] 加载点位列表失败:', err);
      wx.showToast({ title: '点位列表加载失败，请下拉页面后重试', icon: 'none' });
    });
  },

  // 加载维修人员列表（管理员报修免审核，提交时需当场指派）
  loadRepairers() {
    api.get('/users', { role: 'repairer', page: 1, pageSize: 100 }, { loading: false }).then((res) => {
      const list = Array.isArray(res) ? res : ((res && res.list) || []);
      this.setData({
        repairers: list,
        repairerNames: list.map((u) => u.real_name || u.username || ('维修员' + u.id))
      });
    }).catch((err) => { console.error('[create] 加载维修人员列表失败:', err); });
  },

  onRepairerChange(e) {
    this.setData({ repairerIndex: Number(e.detail.value) });
  },

  onLocationChange(e) {
    const index = Number(e.detail.value);
    const location = this.data.filteredLocations[index];
    this.setData({
      locationIndex: index,
      locationId: location ? location.id : ''
    });
  },

  getLocationLabel(location) {
    const name = (location && location.name) || '';
    const area = (location && location.area) || '';
    const type = (location && location.device_type) || '';
    return [name, area, type].filter(Boolean).join(' - ');
  },

  onLocationSearch(e) {
    const locationKeyword = (e.detail.value || '').trim();
    const keyword = locationKeyword.toLowerCase();
    const filteredLocations = this.data.locations.filter((location) => {
      const text = [location.name, location.area, location.device_type]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return !keyword || text.includes(keyword);
    });
    this.setData({
      locationKeyword,
      filteredLocations,
      locationNames: filteredLocations.map((location) => this.getLocationLabel(location)),
      locationIndex: -1,
      locationId: ''
    });
  },

  onDescInput(e) {
    this.setData({ description: e.detail.value });
  },

  onReqInput(e) {
    this.setData({ requirements: e.detail.value });
  },

  // 选择图片（拍照 + 相册），仅暂存本地路径，提交时统一上传
  onChooseImage() {
    const remain = 9 - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多上传9张图片', icon: 'none' });
      return;
    }
    // wx.chooseMedia 替代已废弃的 wx.chooseImage
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newItems = (res.tempFiles || []).map((f) => ({ tempPath: f.tempFilePath })).filter((it) => it.tempPath);
        this.setData({ images: this.data.images.concat(newItems) });
      }
    });
  },

  // 删除图片
  onDeleteImage(e) {
    const { index } = e.currentTarget.dataset;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  // 预览图片
  onPreview(e) {
    const { index } = e.currentTarget.dataset;
    util.previewImages(this.data.images.map((it) => it.tempPath), index);
  },

  // 提交报修：先建工单，再传照片
  onSubmit() {
    const { locationId, locationIndex, description, requirements, images, submitting } = this.data;
    if (submitting) return;
    if (locationIndex < 0) {
      wx.showToast({ title: '请选择故障点位', icon: 'none' });
      return;
    }
    if (!description.trim()) {
      wx.showToast({ title: '请填写故障描述', icon: 'none' });
      return;
    }
    // 与服务端一致：故障描述至少 5 个字（前端先行校验，避免提交后才报错）
    if (description.trim().length < 5) {
      wx.showToast({ title: '故障描述至少 5 个字', icon: 'none' });
      return;
    }

    // 管理员报修免审核：必须当场指派维修人员
    const payload = {
      location_id: locationId,
      fault_description: description.trim(),
      repair_requirements: requirements.trim() || null
    };
    if (this.data.isAdmin) {
      if (this.data.repairerIndex < 0) {
        wx.showToast({ title: '请选择指派的维修人员', icon: 'none' });
        return;
      }
      payload.assigned_repairer_id = this.data.repairers[this.data.repairerIndex].id;
    }

    this.setData({ submitting: true, uploadProgress: 0 });
    wx.showLoading({ title: '正在提交...', mask: true });

    api.post('/orders', payload, { loading: false, silent: true }).then((res) => {
      const orderId = res && (res.id || res.order_id);
      if (!orderId) {
        throw new Error('创建工单失败');
      }
      // 先上传照片（成功后自动写入 order_images），统计失败张数
      return this.uploadImages(orderId, images).then((failedCount) => ({ orderId, failedCount }));
    }).then(({ orderId, failedCount }) => {
      wx.hideLoading();
      if (failedCount > 0) {
        // 工单已创建成功，但部分照片丢失：明确告知用户，可稍后在详情页补充
        wx.showModal({
          title: '报修已提交',
          content: failedCount + ' 张照片上传失败。工单已创建成功，您可稍后在工单详情中补充现场照片。',
          showCancel: false,
          confirmText: '知道了',
          success: () => {
            wx.setStorageSync('listStatus', this.skipReviewStatus());
            wx.switchTab({ url: '/pages/report/list/list' });
          }
        });
        return;
      }
      wx.showToast({ title: this.data.isAdmin || this.data.isRepairer ? '已生成维修任务' : '报修提交成功', icon: 'success' });
      setTimeout(() => {
        wx.setStorageSync('listStatus', this.skipReviewStatus());
        wx.switchTab({ url: '/pages/report/list/list' });
      }, 1200);
    }).catch((err) => {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: (err && err.message) || '提交失败，请重试', icon: 'none' });
    });
  },

  // 提交成功后工单列表的预设筛选状态（仅报修用户消费；admin/repairer 走工单tab重定向，不留残余参数）
  skipReviewStatus() {
    return this.data.isAdmin || this.data.isRepairer ? '' : 'pending_review';
  },

  // 上传全部照片（携带 order_id 与 image_type=report），返回失败张数（不阻断工单提交流程）
  uploadImages(orderId, images) {
    if (!images || !images.length) return Promise.resolve(0);
    let completed = 0;
    let failedCount = 0;
    const tasks = images.map((item) =>
      api.upload(item.tempPath, { order_id: orderId, image_type: 'report' }, { silent: true, loading: false })
        .catch((err) => {
          console.error('[create] 照片上传失败:', err);
          failedCount += 1;
        }).finally(() => {
          completed += 1;
          this.setData({ uploadProgress: Math.round(completed * 100 / images.length) });
        })
    );
    return Promise.all(tasks).then(() => failedCount);
  }
});
