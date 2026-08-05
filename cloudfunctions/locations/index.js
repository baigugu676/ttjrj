/**
 * 点位管理云函数（微信云开发）
 * GET 列表所有登录角色可访问；增删改仅管理员。
 *
 * 入参（action）：
 *   list                          点位列表
 *   create  { name, area?, device_type?, sort_order?, status? }
 *   update  { id, name?, area?, device_type?, sort_order?, status? }
 *   delete  { id }
 *
 * 返回统一格式：{ code: 0, data, message: 'success' }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function ok(data) {
  return { code: 0, message: 'success', data };
}

function fail(message, code = 1) {
  return { code, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return true;
  } catch (err) {
    const msg = (err && (err.message || err.errMsg || String(err))) || '';
    if (/already exists|已存在|ResourceExist|Collection already exists/i.test(msg)) return true;
    return false;
  }
}

async function getCurrentUser() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const res = await db.collection('users').where({ openid: OPENID }).limit(1).get();
  return res.data[0] || null;
}

exports.main = async (event) => {
  try {
    const colOk = await ensureCollection('locations');
    if (!colOk) return fail('数据库集合初始化失败，请先运行 init 云函数');
    const user = await getCurrentUser();
    if (!user) return fail('未登录或 token 缺失');

    const { action } = event || {};

    if (action === 'list') {
      let res = await db.collection('locations')
        .orderBy('sort_order', 'asc')
        .orderBy('created_at', 'asc')
        .limit(1000)
        .get();

      // 首次使用：集合为空则自动填充预设点位
      if (!res.data.length) {
        const presets = [
           { name: '3号楼道摄像头-01', area: '3号楼', device_type: '摄像头', sort_order: 1, status: 'active' },
          { name: '大门入口摄像头-03', area: '大门', device_type: '摄像头', sort_order: 2, status: 'active' },
          { name: '停车场摄像头-02', area: '停车场', device_type: '摄像头', sort_order: 3, status: 'active' },
          { name: '2号楼道摄像头-01', area: '2号楼', device_type: '摄像头', sort_order: 4, status: 'active' },
          { name: '围墙报警器-05', area: '围墙', device_type: '报警器', sort_order: 5, status: 'active' }
        ];
        for (const l of presets) {
          await db.collection('locations').add({
            data: { ...l, created_at: db.serverDate() }
          });
        }
        res = await db.collection('locations')
          .orderBy('sort_order', 'asc')
          .orderBy('created_at', 'asc')
          .limit(1000)
          .get();
      }

      return ok(res.data.map((l) => ({ ...l, id: l._id })));
    }

    // 以下操作仅管理员
    if (user.role !== 'admin') return fail('无权限执行该操作');

    if (action === 'create') {
      const { name, area = '', device_type = '', sort_order = 0, status = 'active' } = event;
      const locName = name ? String(name).trim() : '';
      if (!locName) return fail('点位名称不能为空');
      if (!['active', 'inactive'].includes(status)) return fail('状态不合法（active/inactive）');
      const exists = await db.collection('locations').where({ name: locName }).limit(1).get();
      if (exists.data.length) return fail('点位名称已存在');
      const add = await db.collection('locations').add({
        data: {
          name: locName,
          area,
          device_type,
          sort_order: Number(sort_order) || 0,
          status,
          created_at: db.serverDate()
        }
      });
      return ok({ id: add._id });
    }

    if (action === 'update') {
      const { id } = event;
      const data = {};
      if (event.name !== undefined) {
        const n = String(event.name).trim();
        if (!n) return fail('点位名称不能为空');
        data.name = n;
      }
      if (event.area !== undefined) data.area = event.area;
      if (event.device_type !== undefined) data.device_type = event.device_type;
      if (event.sort_order !== undefined) data.sort_order = Number(event.sort_order) || 0;
      if (event.status !== undefined) {
        if (!['active', 'inactive'].includes(event.status)) return fail('状态不合法（active/inactive）');
        data.status = event.status;
      }
      if (!Object.keys(data).length) return fail('没有需要更新的字段');
      try {
        await db.collection('locations').doc(id).update({ data });
      } catch (e) {
        return fail('点位不存在');
      }
      return ok(null);
    }

    if (action === 'delete') {
      const { id } = event;
      const linked = await db.collection('work_orders').where({ location_id: id }).limit(1).get();
      if (linked.data.length) return fail('该点位下存在关联工单，无法删除');
      try {
        await db.collection('locations').doc(id).remove();
      } catch (e) {
        return fail('点位不存在');
      }
      return ok(null);
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
