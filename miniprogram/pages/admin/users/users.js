// 用户管理（管理员）：角色筛选、列表、添加/编辑（弹窗表单）、禁用/启用
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    roleTabs: [
      { label: '全部', value: '' },
      { label: '报修用户', value: 'user' },
      { label: '维修人员', value: 'repairer' },
      { label: '管理员', value: 'admin' }
    ],
    roleFilter: '',
    list: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    // 弹窗
    showModal: false,
    modalTitle: '添加用户',
    saving: false,
    roleOptions: [
      { value: 'user', label: '报修用户' },
      { value: 'repairer', label: '维修人员' },
      { value: 'admin', label: '管理员' }
    ],
    form: { id: '', username: '', password: '', real_name: '', phone: '', roleIndex: 0 }
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
    this.loadList(true);
  },

  onShow() {
    if (getApp().getRole() === 'admin') {
      this.loadList(true);
    }
  },

  onRoleFilter(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.roleFilter) return;
    this.setData({ roleFilter: value });
    this.loadList(true);
  },

  loadList(reset) {
    const { page, pageSize, hasMore, loading } = this.data;
    if (!reset && (!hasMore || loading)) return;
    const target = reset ? 1 : page + 1;
    this.setData({ loading: true });
    api.get('/users', {
      role: this.data.roleFilter,
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = this.decorate(this.extractList(res));
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch(() => {
      this.setData({ loading: false });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 补充角色中文
  decorate(rows) {
    return rows.map((u) => Object.assign({}, u, {
      role_text: util.getRoleText(u.role)
    }));
  },

  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  },

  onPullDownRefresh() {
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  // ===== 弹窗：添加/编辑 =====
  openAdd() {
    this.setData({
      showModal: true,
      modalTitle: '添加用户',
      form: { id: '', username: '', password: '', real_name: '', phone: '', roleIndex: 0 }
    });
  },

  editUser(e) {
    const id = e.currentTarget.dataset.id;
    const user = this.data.list.find((u) => u.id === id);
    if (!user) return;
    const roleIndex = Math.max(0, this.data.roleOptions.findIndex((r) => r.value === user.role));
    this.setData({
      showModal: true,
      modalTitle: '编辑用户',
      form: {
        id: user.id,
        username: user.username || '',
        password: '',
        real_name: user.real_name || '',
        phone: user.phone || '',
        roleIndex
      }
    });
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: e.detail.value });
  },

  onRoleChange(e) {
    this.setData({ 'form.roleIndex': Number(e.detail.value) });
  },

  closeModal() {
    this.setData({ showModal: false });
  },

  // 保存（添加 POST /users，编辑 PUT /users/:id）
  saveUser() {
    const form = this.data.form;
    if (this.data.saving) return;
    if (!form.username.trim()) {
      wx.showToast({ title: '请输入用户名', icon: 'none' });
      return;
    }
    if (!form.id && !form.password) {
      wx.showToast({ title: '请输入密码', icon: 'none' });
      return;
    }
    if (!form.real_name.trim()) {
      wx.showToast({ title: '请输入姓名', icon: 'none' });
      return;
    }
    const role = this.data.roleOptions[form.roleIndex].value;
    const data = {
      username: form.username.trim(),
      real_name: form.real_name.trim(),
      phone: form.phone.trim(),
      role
    };
    // 编辑时密码留空表示不修改
    if (form.password) data.password = form.password;

    this.setData({ saving: true });
    const req = form.id
      ? api.put('/users/' + form.id, data, { silent: true })
      : api.post('/users', data, { silent: true });
    req.then(() => {
      this.setData({ saving: false, showModal: false });
      wx.showToast({ title: '保存成功', icon: 'success' });
      this.loadList(true);
    }).catch((err) => {
      this.setData({ saving: false });
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    });
  },

  // 禁用/启用：PUT /users/:id/status
  toggleStatus(e) {
    const id = e.currentTarget.dataset.id;
    const user = this.data.list.find((u) => u.id === id);
    if (!user) return;
    const toDisabled = user.status !== 'disabled';
    wx.showModal({
      title: toDisabled ? '禁用用户' : '启用用户',
      content: '确认' + (toDisabled ? '禁用' : '启用') + '用户「' + (user.real_name || user.username) + '」？',
      confirmColor: toDisabled ? '#FA5151' : '#07C160',
      success: (res) => {
        if (!res.confirm) return;
        api.put('/users/' + id + '/status', {
          status: toDisabled ? 'disabled' : 'active'
        }).then(() => {
          wx.showToast({ title: '操作成功', icon: 'success' });
          this.loadList(true);
        }).catch(() => {});
      }
    });
  }
});
