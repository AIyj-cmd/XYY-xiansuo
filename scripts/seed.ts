// 种子数据脚本：生成 2 个业务员账号 + 20 条假线索 + 若干跟进记录
import { DatabaseSync } from 'node:sqlite';
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const scryptAsync = promisify(scrypt);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.join(__dirname, '..', 'server', 'data', 'app.db');
const seedMemberPassword = process.env.SEED_MEMBER_PASSWORD;

async function hashPwd(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}$${hash.toString('hex')}`;
}

const SOURCES = ['小红书', '抖音', '视频号', '知乎', '微信公众号', 'B站', '百度', '官网', '转介绍', '其他'];
const STATUS = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'];
const INDUSTRIES = ['女装', '男装', '童装', '鞋类', '内衣', '其他'];
const INTENTS = ['高', '中', '低', '未知'];
const FOLLOW_TYPES = ['电话', '微信', '拜访', '其他'];
const CONTACTS = ['张伟', '李芳', '王磊', '赵静', '陈敏', '刘洋', '周强', '吴丽', '孙燕', '郑浩', '冯雪', '蒋成', '韩梅', '秦悦', '曹宇', '彭恩', '楚晓', '魏天', '苗雨', '叶思'];
const COMPANIES = ['优衣库旗舰店', '李宁运动', '安踏童装', '迪卡侬上海', '波司登棉服', '海澜之家', '九牧王', '太平鸟', null, null, '红蜻蜓鞋业', '百丽时尚', null, '拉夏贝尔', '森马服饰', null, '报喜鸟', '雅戈尔', null, '七匹狼'];

function randItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function daysLater(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

async function main() {
  if (!seedMemberPassword || seedMemberPassword.length < 12) {
    throw new Error('SEED_MEMBER_PASSWORD 必须设置且至少 12 位；种子脚本不提供固定共享密码');
  }
  const db = new DatabaseSync(DB_PATH);

  // 检查 admin 是否存在
  const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as any;
  if (!admin) {
    console.error('请先启动服务器初始化数据库！');
    process.exit(1);
  }

  // 创建业务员
  const memberHash1 = await hashPwd(seedMemberPassword);
  const memberHash2 = await hashPwd(seedMemberPassword);

  let user1 = db.prepare("SELECT id FROM users WHERE username = 'zhangsan'").get() as any;
  if (!user1) {
    const r = db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)").run('zhangsan', '张三', memberHash1, 'member');
    user1 = { id: r.lastInsertRowid };
  }

  let user2 = db.prepare("SELECT id FROM users WHERE username = 'lisi'").get() as any;
  if (!user2) {
    const r = db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)").run('lisi', '李四', memberHash2, 'member');
    user2 = { id: r.lastInsertRowid };
  }

  const owners = [admin.id, user1.id, user2.id];
  console.log('业务员账号创建完成：zhangsan, lisi（密码来自 SEED_MEMBER_PASSWORD）');

  // 生成 20 条线索（覆盖各状态/来源/逾期情形）
  const scenarios = [
    { status: '新线索', lead_date: daysAgo(1), next_follow_at: daysLater(2) },
    { status: '跟进中', lead_date: daysAgo(3), next_follow_at: daysLater(1) },
    { status: '已报价', lead_date: daysAgo(7), next_follow_at: daysLater(3) },
    { status: '已成交', lead_date: daysAgo(14), next_follow_at: null },
    { status: '已流失', lead_date: daysAgo(20), next_follow_at: null },
    { status: '暂搁置', lead_date: daysAgo(5), next_follow_at: daysLater(7) },
    // 逾期场景
    { status: '跟进中', lead_date: daysAgo(10), next_follow_at: daysAgo(3) },
    { status: '新线索', lead_date: daysAgo(8), next_follow_at: daysAgo(2) },
    { status: '跟进中', lead_date: daysAgo(15), next_follow_at: daysAgo(7) },
    // 今日待跟进
    { status: '跟进中', lead_date: daysAgo(5), next_follow_at: daysAgo(0) },
    { status: '跟进中', lead_date: daysAgo(4), next_follow_at: daysAgo(0) },
    // 其他
    { status: '新线索', lead_date: daysAgo(2), next_follow_at: null },
    { status: '跟进中', lead_date: daysAgo(6), next_follow_at: daysLater(4) },
    { status: '已报价', lead_date: daysAgo(9), next_follow_at: daysLater(2) },
    { status: '已成交', lead_date: daysAgo(30), next_follow_at: null },
    { status: '新线索', lead_date: daysAgo(1), next_follow_at: daysLater(5) },
    { status: '跟进中', lead_date: daysAgo(12), next_follow_at: daysAgo(1) },
    { status: '已流失', lead_date: daysAgo(25), next_follow_at: null },
    { status: '暂搁置', lead_date: daysAgo(3), next_follow_at: daysLater(14) },
    { status: '已报价', lead_date: daysAgo(4), next_follow_at: daysLater(1) },
  ];

  let created = 0;
  for (let i = 0; i < 20; i++) {
    const phone = `138${String(i + 1).padStart(8, '0')}`;
    const exists = db.prepare('SELECT id FROM leads WHERE phone = ?').get(phone);
    if (exists) { console.log(`手机号 ${phone} 已存在，跳过`); continue; }

    const sc = scenarios[i];
    const ownerId = randItem(owners);
    const contact = CONTACTS[i];
    const company = COMPANIES[i];
    const source = randItem(SOURCES);
    const industry = randItem(INDUSTRIES);
    const intent = randItem(INTENTS);

    const res = db.prepare(`
      INSERT INTO leads (contact_name, phone, company_name, industry, source, intent_level, status, owner_id, lead_date, next_follow_at, created_by, last_follow_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(contact, phone, company, industry, source, intent, sc.status, ownerId, sc.lead_date, sc.next_follow_at, ownerId, sc.lead_date + ' 10:00:00');

    const leadId = res.lastInsertRowid;

    // 生成1-2条跟进记录
    if (sc.status !== '新线索') {
      db.prepare(`INSERT INTO follow_ups (lead_id, user_id, type, content, result, next_follow_at) VALUES (?,?,?,?,?,?)`)
        .run(leadId, ownerId, randItem(FOLLOW_TYPES), `已与${contact}沟通，对方了解了我们的服务，表示${sc.intent_level === '高' ? '很感兴趣' : '需要考虑'}。`, '等待回复', sc.next_follow_at);
    }

    if (['已报价', '已成交'].includes(sc.status)) {
      db.prepare(`INSERT INTO follow_ups (lead_id, user_id, type, content, result, next_follow_at) VALUES (?,?,?,?,?,?)`)
        .run(leadId, ownerId, '电话', `跟进报价情况，对方表示${sc.status === '已成交' ? '已决定合作' : '还在对比同行'}。`, sc.status === '已成交' ? '已签约' : '继续跟进', null);

      // 更新 last_follow_at
      db.prepare('UPDATE leads SET last_follow_at = ? WHERE id = ?').run(daysAgo(1) + ' 14:00:00', leadId);
    }

    created++;
  }

  console.log(`种子数据生成完成：共创建 ${created} 条线索`);
  db.close();
}

main().catch(console.error);
