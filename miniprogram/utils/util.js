// 工具函数：日期格式化、状态/角色映射、时间线构建、图片拆分与预览等

// 工单状态映射（后端状态为字符串枚举，见分工文档 §5 状态流转规则）
const STATUS_MAP = {
  pending_review:  { text: '待审核', color: '#FF9500' },   // 橙色
  pending_repair:  { text: '待维修', color: '#1677FF' },   // 蓝色
  repairing:       { text: '维修中', color: '#10AEFF' },   // 青色
  pending_accept:  { text: '待验收', color: '#8A6FF8' },   // 紫色
  completed:       { text: '已完成', color: '#07C160' },   // 绿色
  rejected:        { text: '已驳回', color: '#FA5151' },   // 红色
  repair_returned: { text: '退回维修', color: '#FA5151' }  // 红色
};

// 角色映射（维修人员角色为 repairer）
const ROLE_MAP = {
  admin: '管理员',
  user: '报修用户',
  repairer: '维修人员'
};

// 数字补零
function formatNumber(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * 日期格式化
 * @param {Date|Number|String} input 日期（Date 对象、时间戳、可解析字符串）
 * @param {String} fmt 格式，默认 YYYY-MM-DD HH:mm，支持 YYYY MM DD HH mm ss
 */
function formatTime(input, fmt) {
  if (!input && input !== 0) return '';
  const f = fmt || 'YYYY-MM-DD HH:mm';
  let d = null;
  if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'number') {
    d = new Date(input);
  } else if (typeof input === 'string') {
    // iOS 不支持 "YYYY-MM-DD HH:mm:ss" 直接 new Date，需替换为 "/"
    d = new Date(String(input).replace(/-/g, '/'));
  }
  if (!d || isNaN(d.getTime())) return input; // 解析失败则原样返回
  const o = {
    'YYYY': d.getFullYear(),
    'MM': formatNumber(d.getMonth() + 1),
    'DD': formatNumber(d.getDate()),
    'HH': formatNumber(d.getHours()),
    'mm': formatNumber(d.getMinutes()),
    'ss': formatNumber(d.getSeconds())
  };
  return f.replace(/YYYY|MM|DD|HH|mm|ss/g, (k) => o[k]);
}

// 状态码转中文
function getStatusText(status) {
  const info = STATUS_MAP[status];
  return info ? info.text : '未知状态';
}

// 状态对应的颜色
function getStatusColor(status) {
  const info = STATUS_MAP[status];
  return info ? info.color : '#999999';
}

// 角色转中文
function getRoleText(role) {
  return ROLE_MAP[role] || role || '未知';
}

/**
 * 拆分工单图片（详情接口返回的 images 可能为字符串数组或对象数组）
 * 返回 { report: [], before: [], after: [] }
 */
function splitImages(order) {
  const report = [];
  const before = [];
  const after = [];
  const list = (order && (order.images || order.order_images)) || [];
  list.forEach((item) => {
    if (typeof item === 'string') {
      report.push(item);
      return;
    }
    const url = (item && (item.image_url || item.url)) || '';
    if (!url) return;
    if (item.image_type === 'repair_before') {
      before.push(url);
    } else if (item.image_type === 'repair_after') {
      after.push(url);
    } else {
      report.push(url);
    }
  });
  return { report, before, after };
}

/**
 * 根据工单状态与各环节时间构建时间线步骤
 * 流转：提交 → 审核 → 接单 → 维修 → 验收
 * 每项：{ title, time, status: done|current|todo|reject, active, desc }
 * active 兼容分工文档中 steps=[{title, time, active}] 的约定
 */
function buildTimelineSteps(order) {
  if (!order) return [];
  const s = order.status;
  const t = (v) => formatTime(v);
  const repair = order.repair_record || order.repairRecord || {};
  const accept = order.acceptance_record || order.acceptanceRecord || {};
  const steps = [];

  // 1. 提交报修
  steps.push({
    title: '提交报修',
    time: t(order.created_at || order.createdAt),
    status: 'done',
    active: false,
    desc: order.order_no ? '工单号：' + order.order_no : ''
  });

  // 2. 审核环节
  const reviewDone = ['pending_repair', 'repairing', 'pending_accept', 'completed'].indexOf(s) >= 0;
  if (s === 'rejected') {
    // 审核驳回，流程终止
    steps.push({
      title: '审核驳回',
      time: t(order.reviewed_at),
      status: 'reject',
      active: false,
      desc: order.reject_reason || ''
    });
    return steps;
  }
  steps.push({
    title: '审核通过',
    time: t(order.reviewed_at),
    status: reviewDone ? 'done' : 'current',
    active: s === 'pending_review'
  });

  // 3. 接单环节
  const acceptDone = ['repairing', 'pending_accept', 'completed'].indexOf(s) >= 0;
  steps.push({
    title: '维修接单',
    time: t(repair.created_at || repair.start_time),
    status: acceptDone ? 'done' : (s === 'pending_repair' ? 'current' : 'todo'),
    active: s === 'pending_repair'
  });

  // 4. 维修环节
  const repairDone = ['pending_accept', 'completed'].indexOf(s) >= 0;
  steps.push({
    title: '维修完成',
    time: t(repair.end_time || repair.updated_at),
    status: repairDone ? 'done' : (s === 'repairing' ? 'current' : 'todo'),
    active: s === 'repairing',
    desc: repair.repair_action || ''
  });

  // 5. 验收环节
  if (s === 'repair_returned') {
    steps.push({
      title: '验收退回',
      time: t(accept.accepted_at),
      status: 'reject',
      active: false,
      desc: accept.return_reason || ''
    });
  } else if (s === 'completed') {
    steps.push({
      title: '验收通过',
      time: t(accept.accepted_at),
      status: 'done',
      active: false
    });
  } else {
    steps.push({
      title: '验收通过',
      time: t(accept.accepted_at),
      status: s === 'pending_accept' ? 'current' : 'todo',
      active: s === 'pending_accept'
    });
  }
  return steps;
}

/**
 * 图片预览
 * @param {Array} urls 图片地址数组
 * @param {Number|String} current 当前图片下标或地址
 */
function previewImages(urls, current) {
  if (!urls || !urls.length) return;
  let cur = current;
  if (typeof current === 'number') {
    cur = urls[current] || urls[0];
  }
  if (!cur) cur = urls[0];
  wx.previewImage({ urls, current: cur });
}

module.exports = {
  STATUS_MAP,
  ROLE_MAP,
  formatTime,
  getStatusText,
  getStatusColor,
  getRoleText,
  splitImages,
  buildTimelineSteps,
  previewImages
};
