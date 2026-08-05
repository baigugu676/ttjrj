/**
 * 初始化云函数（微信云开发）
 * 部署后在开发者工具中手动运行一次：
 *   1. 创建全部数据集合（已存在则跳过）
 *   2. 预置测试账号（admin/admin123、zhangsan、lisi、repairer1、repairer2，密码均 123456）
 *   3. 预置 5 个故障点位
 *
 * 返回：{ code: 0, data: { collections_created: [...], users: 'seeded'|'skipped', locations: ... } }
 */
const cloud = require('wx-server-sdk');
const bcrypt = require('bcryptjs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = [
  'users',
  'locations',
  'work_orders',
  'order_images',
  'repair_records',
  'acceptance_records',
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

async function seedUsers() {
  const count = await db.collection('users').count();
  if (count.total > 0) return 'skipped';
  const users = [
    { username: 'admin', password: 'admin123', real_name: '管理员A', role: 'admin', phone: '13800000001' },
    { username: 'zhangsan', password: '123456', real_name: '张三', role: 'user', phone: '13800000002' },
    { username: 'lisi', password: '123456', real_name: '李四', role: 'user', phone: '13800000003' },
    { username: 'repairer1', password: '123456', real_name: '维修员小刘', role: 'repairer', phone: '13800000004' },
    { username: 'repairer2', password: '123456', real_name: '维修员老陈', role: 'repairer', phone: '13800000005' }
  ];
  for (const u of users) {
    await db.collection('users').add({
      data: {
        username: u.username,
        password_hash: await bcrypt.hash(u.password, 10),
        openid: '',
        real_name: u.real_name,
        role: u.role,
        phone: u.phone,
        avatar_url: '',
        status: 'active',
        created_at: db.serverDate(),
        updated_at: db.serverDate()
      }
    });
  }
  return 'seeded';
}

async function seedLocations() {
  const count = await db.collection('locations').count();
  if (count.total > 0) return 'skipped';
  const locations = [
    { name: '3号楼道摄像头-01', area: '3号楼', device_type: '摄像头', sort_order: 1, status: 'active' },
    { name: '大门入口摄像头-03', area: '大门', device_type: '摄像头', sort_order: 2, status: 'active' },
    { name: '停车场摄像头-02', area: '停车场', device_type: '摄像头', sort_order: 3, status: 'active' },
    { name: '2号楼道摄像头-01', area: '2号楼', device_type: '摄像头', sort_order: 4, status: 'active' },
    { name: '围墙报警器-05', area: '围墙', device_type: '报警器', sort_order: 5, status: 'active' }
  ];
  for (const l of locations) {
    await db.collection('locations').add({
      data: { ...l, created_at: db.serverDate() }
    });
  }
  return 'seeded';
}

exports.main = async () => {
  const created = [];
  for (const name of COLLECTIONS) {
    if (await ensureCollection(name)) created.push(name);
  }
  const users = await seedUsers();
  const locations = await seedLocations();
  return {
    code: 0,
    message: 'success',
    data: {
      collections_created: created,
      users,
      locations,
      tip: '初始化完成。建议在云开发控制台为 work_orders.status / work_orders.created_at / order_images.order_id 等常用查询字段创建索引。'
    }
  };
};
