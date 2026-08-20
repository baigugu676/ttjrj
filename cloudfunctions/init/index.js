/**
 * 初始化云函数（微信云开发）
 * 部署后在开发者工具中手动运行一次：
 *   1. 创建全部数据集合（已存在则跳过）
 *   2. 用户数据请通过后台创建，避免在代码库中保存凭据
 *   3. 预置 300 个监控点位
 *
 * 返回：{ code: 0, data: { collections_created: [...], locations: ... } }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = [
  'users',
  'locations',
  'work_orders',
  'order_images',
  'repair_records',
  'acceptance_records',
  'transfer_records',
  'notifications'
];

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return true;
  } catch (e) {
    return false;
  }
}

async function seedLocations() {
  const locations = [
    { name: '3号楼道摄像头-01', area: '3号楼', device_type: '摄像头', sort_order: 1, status: 'active' },
    { name: '大门入口摄像头-03', area: '大门', device_type: '摄像头', sort_order: 2, status: 'active' },
    { name: '停车场摄像头-02', area: '停车场', device_type: '摄像头', sort_order: 3, status: 'active' },
    { name: '2号楼道摄像头-01', area: '2号楼', device_type: '摄像头', sort_order: 4, status: 'active' },
    { name: '围墙报警器-05', area: '围墙', device_type: '报警器', sort_order: 5, status: 'active' }
  ];
  for (let i = 6; i <= 300; i += 1) {
    locations.push({
      name: `监控点位-${String(i).padStart(3, '0')}`,
      area: `区域${((i - 1) % 10) + 1}`,
      device_type: '摄像头',
      sort_order: i,
      status: 'active'
    });
  }
  const existingNames = new Set();
  for (let skip = 0; ; skip += 1000) {
    const existing = await db.collection('locations').field({ name: true }).skip(skip).limit(1000).get();
    (existing.data || []).forEach((l) => existingNames.add(l.name));
    if ((existing.data || []).length < 1000) break;
  }
  const missing = locations.filter((l) => !existingNames.has(l.name));
  for (let i = 0; i < missing.length; i += 20) {
    await Promise.all(missing.slice(i, i + 20).map((l) => db.collection('locations').add({
      data: { ...l, created_at: db.serverDate() }
    })));
  }
  return missing.length ? 'seeded' : 'skipped';
}

exports.main = async (event) => {
  // 系统已存在用户时仅管理员可触发初始化；首次部署（无任何用户）时允许直接初始化
  try {
    const usersCount = await db.collection('users').count();
    if ((usersCount.total || 0) > 0) {
      const token = event && event._token ? String(event._token) : '';
      if (!token) {
        return { code: 1, message: '仅管理员可执行初始化' };
      }
      const res = await db.collection('users').doc(token).get();
      const u = res.data;
      if (!u || u.role !== 'admin' || u.status !== 'active') {
        return { code: 1, message: '仅管理员可执行初始化' };
      }
    }
  } catch (err) {
    // 仅「users 集合不存在」视为首次初始化并放行；其他错误（如临时故障）不得绕过管理员校验
    const msg = (err && (err.message || err.errMsg || String(err))) || '';
    if (!/not exist|不存在|DATABASE_COLLECTION_NOT_EXIST/i.test(msg)) {
      return { code: 1, message: `初始化前校验失败：${msg || '未知错误'}` };
    }
  }
  const created = [];
  for (const name of COLLECTIONS) {
    if (await ensureCollection(name)) created.push(name);
  }
  const locations = await seedLocations();
  return {
    code: 0,
    message: 'success',
    data: {
      collections_created: created,
      locations,
      tip: '初始化完成。用户账号请通过管理后台创建。'
    }
  };
};
