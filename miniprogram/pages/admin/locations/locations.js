// 点位管理（管理员）：点位列表 + 添加/编辑（弹窗）+ 删除
const api = require('../../../utils/api.js');

Page({
  data: {
    list: [],
    keyword: '',
    loading: false,
    showModal: false,
    modalTitle: '添加点位',
    saving: false,
    form: { id: '', name: '', area: '', device_type: '' }
  },

  onLoad() {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅管理员可访问
    if (app.getRole() !== 'admin') {
      wx.showToast({ title: '仅管理员可访问', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1000);
      return;
    }
    this._initialLoad = true;
    this.loadList();
  },

  onShow() {
    // 跳过首次加载（onLoad 已触发），仅从其他页面返回时刷新
    if (this._initialLoad) {
      this._initialLoad = false;
      return;
    }
    if (getApp().getRole() === 'admin') {
      this.loadList();
    }
  },

  onPullDownRefresh() {
    this.loadList().finally(() => wx.stopPullDownRefresh());
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.loadList();
  },

  loadList() {
    this.setData({ loading: true });
    return api.get('/locations', {
      keyword: this.data.keyword.trim()
    }, { loading: false }).then((res) => {
      const list = Array.isArray(res) ? res : ((res && res.list) || []);
      this.setData({ list, loading: false });
    }).catch((err) => {
      console.error('[locations] 加载点位列表失败:', err);
      this.setData({ loading: false });
    });
  },

  // ===== 弹窗：添加/编辑 =====
  openAdd() {
    this.setData({
      showModal: true,
      modalTitle: '添加点位',
      form: { id: '', name: '', area: '', device_type: '' }
    });
  },

  editLocation(e) {
    const id = e.currentTarget.dataset.id;
    const loc = this.data.list.find((l) => l.id === id);
    if (!loc) return;
    this.setData({
      showModal: true,
      modalTitle: '编辑点位',
      form: {
        id: loc.id,
        name: loc.name || '',
        area: loc.area || '',
        device_type: loc.device_type || ''
      }
    });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: e.detail.value });
  },

  closeModal() {
    this.setData({ showModal: false });
  },

  // 保存（添加 POST /locations，编辑 PUT /locations/:id）
  saveLocation() {
    const form = this.data.form;
    if (this.data.saving) return;
    if (!form.name.trim()) {
      wx.showToast({ title: '请输入点位名称', icon: 'none' });
      return;
    }
    const data = {
      name: form.name.trim(),
      area: form.area.trim(),
      device_type: form.device_type.trim()
    };
    this.setData({ saving: true });
    const req = form.id
      ? api.put('/locations/' + form.id, data, { silent: true })
      : api.post('/locations', data, { silent: true });
    req.then(() => {
      this.setData({ saving: false, showModal: false });
      wx.showToast({ title: '保存成功', icon: 'success' });
      this.loadList();
    }).catch((err) => {
      this.setData({ saving: false });
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    });
  },

  // 删除点位：DELETE /locations/:id
  deleteLocation(e) {
    const id = e.currentTarget.dataset.id;
    const loc = this.data.list.find((l) => l.id === id);
    if (!loc) return;
    wx.showModal({
      title: '删除点位',
      content: '确认删除点位「' + loc.name + '」？删除后不可恢复',
      confirmText: '删除',
      confirmColor: '#FA5151',
      success: (res) => {
        if (!res.confirm) return;
        api.del('/locations/' + id).then(() => {
          wx.showToast({ title: '删除成功', icon: 'success' });
          this.loadList();
        }).catch((err) => { console.error('[locations] 删除点位失败:', err); });
      }
    });
  }
});
