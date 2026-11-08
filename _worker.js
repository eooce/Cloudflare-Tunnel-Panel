// Cloudflare Worker: Cloudflare Tunnel 管理面板
// 环境变量 (Settings → Variables and Secrets):
//   CF_ACCOUNT_ID    账户 ID，创建token时显示
//   CF_API_TOKEN     API 令牌, 权限: 
//        整个账户：DNS & Zone → Account DNS Settings → Read & Edit；DNS View → Read & Edit;
//                 Argo Tunnel → Read & Edit；
//        所有域名：DNS & Zone → DNS → Read & Edit;Zone → Read & Edit;Zone DNS Settings → Read & Edit;Zone Settings → Read & Edit;

//   PASSWORD         登录密码 (必填), 至少 6 位
//   SESSION_SECRET   会话签名密钥 (可选), 推荐设置一串随机字符，否则自动由 PASSWORD 派生 (改密码后所有人需重新登录)
//   DEFAULT_SERVICE  本地服务默认地址, 如 http://localhost:8001 (可选)
//   TG_BOT_TOKEN     Telegram 机器人 Token (可选), 如 123456:ABC...
//   TG_CHAT_ID       Telegram 接收提醒的 chat_id (可选), 群组为负数
//
// 访问方式: 打开 https://你的域名 , 输入 PASSWORD 登录后进入管理面板。
//
// 提醒逻辑: 每次打开列表时比对隧道在线状态, 与上次相比发生变化才提醒 (上/下线各一次)
// 首次记录不发提醒。比较的结果保存在 D1 或 KV 中 (二选一):
//   推荐 D1: Settings → Bindings → D1 Database, 变量名 TUNNEL_DB
//            首次使用前执行: CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
//   或 KV:   Settings → Bindings → KV Namespace, 变量名 TUNNEL_STATE
// 未绑定存储时不会发送提醒。如需定时在后台检查 (即使没人打开面板), 可在
// Triggers → Cron 中添加 * /5 * * * * , 并在 Worker 入口加一个 scheduled 处理

// ============================ 配置填写区 ============================
// 推荐用 Dashboard → Settings → Secrets 配置。
// 注意: D1/KV 是运行时绑定, 需在 Dashboard → Settings → Bindings 里绑定 (D1 优先于 KV)。
const CONFIG_DEFAULTS = {
  CF_API_TOKEN:    "", // [必填] API 令牌, 权限参考上述说明
  CF_ACCOUNT_ID:   "", // [必填] Cloudflare 账户 ID,创建token时会提示
  PASSWORD:        "", // [必填] 面板登录密码, 至少 6 位
  SESSION_SECRET:  "8a50ef48974d4dc9ac7094c23382c57d", // [可选] 会话签名密钥, 填一串随机字符; 留空则自动由 PASSWORD 派生
  DEFAULT_SERVICE: "http://localhost:8001", // [可选] 新建/编辑隧道的默认本地服务地址, 默认 http://localhost:8001
  TG_BOT_TOKEN:    "", // [可选] Telegram 机器人 Token; 也可在面板"Telegram 配置"里保存到 D1
  TG_CHAT_ID:      "", // [可选] Telegram 接收者 chat_id: 私聊填自己的正数 ID, 群组填负数
};
// ====================================================================

// 参数处理
function applyConfig(env) {
  const out = Object.assign({}, env);
  for (const k of Object.keys(CONFIG_DEFAULTS)) {
    const v = String(CONFIG_DEFAULTS[k] || "").trim();
    if (v) out[k] = v;
  }
  return out;
}
// 全局api
const API = "https://api.cloudflare.com/client/v4";

// 辅助函数
const ZH_ERRORS = [
  [/already have a tunnel with this name/i, "已存在同名隧道,请删除原隧道或换一个名称"],
  [/authentication error|valid user-level authentication|invalid api token|unauthorized/i,
    "API 令牌无效或权限不足,请确认已授予:帐户 Cloudflare Tunnel 编辑、区域 DNS 编辑、区域 区域 读取"],
  [/invalid format for authorization header|invalid request headers/i,
    "API 令牌格式不正确,请检查 CF_API_TOKEN 是否复制完整"],
  [/could not route|object identifier is invalid/i, "账户 ID 或区域 ID 不正确,请检查 CF_ACCOUNT_ID"],
  [/record with that host already exists/i, "该域名已存在其他 DNS 记录,请先到 DNS 页面删除后再试"],
  [/rate limit|too many requests/i, "请求过于频繁,请稍后再试"],
  [/active connections|cannot delete tunnel/i, "隧道仍有活跃连接,请先停止 cloudflared 再删除"],
  [/tunnel.*not found/i, "隧道不存在或已被删除"],
];

function zhError(errors) {
  if (!Array.isArray(errors) || !errors.length) return "Cloudflare 返回了未知错误";
  return errors
    .map((e) => {
      const msg = String((e && e.message) || "");
      for (const [re, zh] of ZH_ERRORS) if (re.test(msg)) return zh;
      return "Cloudflare 返回错误" + (e && e.code ? " (" + e.code + ")" : "") + ": " + msg;
    })
    .join(";");
}

async function cf(env, path, method = "GET", body) {
  // env.cfToken/cfAcc 由 handleApi 根据当前所选账号写入 (默认回落到 env 配置)
  const token = env.cfToken || env.CF_API_TOKEN;
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j;
  try {
    j = await r.json();
  } catch (e) {
    throw new Error("Cloudflare 返回了无法解析的响应 (HTTP " + r.status + ")");
  }
  if (!j.success) throw new Error(zhError(j.errors));
  return j.result;
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function listZones(env) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const r = await cf(env, `/zones?per_page=50&page=${page}&status=active`);
    all.push(...r.map((z) => ({ id: z.id, name: z.name })));
    if (r.length < 50) break;
  }
  return all;
}

// 删除隧道后,清理指向该隧道的 DNS 记录 (只删 content 等于 <id>.cfargotunnel.com 的 CNAME)
async function cleanDns(env, tunnelId, hosts) {
  let dns = 0;
  let dnsFailed = false;
  let dnsErr = "";
  if (!hosts.length) return { dns, dnsFailed, dnsErr };
  try {
    const zones = await listZones(env);
    const target = tunnelId + ".cfargotunnel.com";
    for (const h of new Set(hosts)) {
      const zone = zoneForHost(zones, h);
      if (!zone) continue;
      const recs = await cf(env, `/zones/${zone.id}/dns_records?type=CNAME&name=${encodeURIComponent(h)}`);
      for (const r of recs) {
        if (r.content === target) {
          await cf(env, `/zones/${zone.id}/dns_records/${r.id}`, "DELETE");
          dns++;
        }
      }
    }
  } catch (e) {
    dnsFailed = true;
    dnsErr = String((e && e.message) || e); // 通常是当前账号的 Token 缺 Zone→DNS→Edit 权限
  }
  return { dns, dnsFailed, dnsErr };
}

// 检查域名上已有的 DNS 记录: 只允许"不存在"或"已指向本隧道", 其他任何记录一律报错, 绝不覆盖
// 返回 true 表示已有指向本隧道的 CNAME (无需再建)
async function checkHost(env, zoneId, hostname, tunnelId) {
  const exist = await cf(env, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  const target = tunnelId ? tunnelId + ".cfargotunnel.com" : "";
  const others = exist.filter((r) => !(target && r.type === "CNAME" && r.content === target));
  if (others.length) {
    const desc = others
      .map((r) => r.type + (/\.cfargotunnel\.com$/.test(r.content) ? " (其他隧道)" : " → " + r.content))
      .join(", ");
    throw new Error(`域名 ${hostname} 已有 DNS 记录: ${desc}。为避免覆盖已停止,请先到 DNS 页面删除或换一个子域名`);
  }
  return exist.length > 0;
}

// 创建指向隧道的 CNAME (已有其他记录时报错, 不覆盖)
async function upsertCname(env, zoneId, hostname, tunnelId) {
  if (await checkHost(env, zoneId, hostname, tunnelId)) return;
  await cf(env, `/zones/${zoneId}/dns_records`, "POST", {
    type: "CNAME",
    name: hostname,
    content: tunnelId + ".cfargotunnel.com",
    proxied: true,
  });
}

// 根据完整域名找到所属 Zone (取最长匹配)
function zoneForHost(zones, host) {
  return zones
    .filter((z) => host === z.name || host.endsWith("." + z.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

// 读取隧道当前的入口规则 (取第一条带域名的规则)
async function getRules(env, base, id) {
  const c = await cf(env, `${base}/${id}/configurations`);
  const config = (c && c.config) || {};
  return { config, ingress: (config.ingress || []).slice() };
}

async function createTunnel(env, { name, zoneId, sub, path, service }) {
  // 多账号: 用当前所选账号 (cfAcc/cfToken 由 handleApi 注入), 而不是环境变量的默认账号
  const acc = env.cfAcc || env.CF_ACCOUNT_ID;
  const zone = await cf(env, `/zones/${zoneId}`);
  const hostname = sub ? `${sub}.${zone.name}` : zone.name;
  await checkHost(env, zoneId, hostname, ""); // 先查 DNS, 有冲突就不建隧道, 避免留下孤儿隧道

  const secret = b64(crypto.getRandomValues(new Uint8Array(32)));
  const tunnel = await cf(env, `/accounts/${acc}/cfd_tunnel`, "POST", {
    name,
    tunnel_secret: secret,
    config_src: "cloudflare",
  });

  const rule = { hostname, service };
  if (path) rule.path = path;
  try {
    await cf(env, `/accounts/${acc}/cfd_tunnel/${tunnel.id}/configurations`, "PUT", {
      config: { ingress: [rule, { service: "http_status:404" }] },
    });
    await upsertCname(env, zoneId, hostname, tunnel.id);
  } catch (e) {
    // 任一步失败就删掉刚建的隧道, 避免留下孤儿隧道导致"同名已存在"
    await cf(env, `/accounts/${acc}/cfd_tunnel/${tunnel.id}`, "DELETE").catch(() => {});
    throw e;
  }

  return {
    id: tunnel.id,
    name,
    hostname,
    path: path || "",
    service,
    token: btoa(JSON.stringify({ a: acc, t: tunnel.id, s: secret })),
  };
}

// ---- PWA: 图标 / manifest / service worker (让手机可"安装应用"并显示图标) ----
const ICON192 = "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";
const ICON512 = "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";
const bin = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function pwaResponse(path) {
  if (path === "/icon-192.png" || path === "/icon-512.png")
    return new Response(bin(path === "/icon-192.png" ? ICON192 : ICON512), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
    });
  if (path === "/manifest.json")
    return new Response(
      JSON.stringify({
        name: "CF 隧道管理",
        short_name: "CF隧道",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f6821f",
        theme_color: "#f6821f",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      }),
      { headers: { "Content-Type": "application/manifest+json" } }
    );
  if (path === "/sw.js")
    return new Response("self.addEventListener('fetch',function(){});", {
      headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" },
    });
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_RE = /^(https?|tcp|udp|ssh|rdp|smb|unix|unix\+tls):\/\/\S+$|^http_status:\d{3}$|^hello_world$/i;
const str = (v) => String(v == null ? "" : v).trim();

async function listTunnels(env, base) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const r = await cf(env, `${base}?is_deleted=false&per_page=100&page=${page}`);
    all.push(...r);
    if (r.length < 100) break;
  }
  return all;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const htmlRes = (body) =>
  new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

// ---- 登录会话: Cookie = base64url(payload).hmac, 签名密钥由 SESSION_SECRET 或 PASSWORD 派生 ----
const SESSION_TTL = 7 * 24 * 3600; // 登录有效期 7 天
const MIN_GAP_MS = 20 * 1000;      // 面板连续刷新时两次状态检查的最小间隔, 防止连点造成重复提醒

let keyCache = { src: "", key: null };
async function sessionKey(env) {
  const src = "cf-tunnel-session:" + (str(env.SESSION_SECRET) || str(env.PASSWORD));
  if (keyCache.src !== src || !keyCache.key) {
    keyCache = {
      src,
      key: await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(src),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      ),
    };
  }
  return keyCache.key;
}

const b64u = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hmac(env, text) {
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), new TextEncoder().encode(text));
  let s = "";
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);
  return b64u(s);
}

async function makeSession(env) {
  const raw = b64u(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL }));
  return raw + "." + (await hmac(env, "sid:" + raw));
}

async function checkSession(env, value) {
  const i = String(value || "").indexOf(".");
  if (i < 0) return false;
  const raw = value.slice(0, i);
  const sig = value.slice(i + 1);
  let exp = 0;
  try {
    exp = Number(JSON.parse(unb64u(raw)).exp) || 0;
  } catch (e) {
    return false;
  }
  if (!exp || exp * 1000 < Date.now()) return false;
  const want = await hmac(env, "sid:" + raw);
  let diff = want.length ^ sig.length;
  for (let k = 0; k < sig.length; k++) diff |= (sig.charCodeAt(k) || 0) ^ (want.charCodeAt(k) || 0);
  return diff === 0;
}

function cookieValue(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

// 固定时间比较, 避免按字符逐位试探
function sameSecret(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function rawAt(url, init) {
  try {
    const r = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(12000) });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: String((e && e.message) || e) };
  }
}

const tgErr = (t) =>
  /chat not found/i.test(t) ? "找不到该 chat_id: 接收者是“谁收消息”而不是机器人本身; 私聊请先把机器人打开并发送 /start, 再填你自己的正数 ID; 群组请填负数群 ID (通常 -100 开头) 并把机器人拉进群"
  : /unauthorized/i.test(t) || /not found/i.test(t) ? "机器人 Token 无效, 请检查 TG_BOT_TOKEN"
  : /chat_id is empty|chat member/i.test(t) ? "chat_id 无效"
  : str(t).slice(0, 160) || "未知错误";

async function tgSend(env, chat, text, kvToken) {
  const token = env.TG_BOT_TOKEN || kvToken;
  if (!token) return { ok: false, error: "未配置机器人 Token (环境变量 TG_BOT_TOKEN 或在 Telegram 配置里保存)" };
  if (!chat) return { ok: false, error: "未配置接收提醒的 chat_id" };
  const r = await rawAt("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  let j = null;
  try {
    j = JSON.parse(r.text);
  } catch (e) {}
  if (j && j.ok) return { ok: true };
  return { ok: false, error: "Telegram: " + tgErr(String((j && j.description) || r.text)) };
}

// ---- Telegram 接收者 ----
// chat_id 指"谁来接收消息", 不是机器人的 ID: 私聊填本人正数 ID (需先给机器人发过 /start),
// 群组/频道填负数 ID (群组需先把机器人拉进群), 也可填公开群组/频道的 @username。
// 正负号由用户按 Telegram 给出的格式原样填写, 不做自动补负号 (旧版自动补 - 会把私聊 ID 当群组)。
// @username 在添加/测试时解析成真实 chat_id 存进 KV, 之后发提醒不再依赖解析。
const stripAt = (c) => str(c).replace(/^@/, "");
const isChatId = (s) => /^-?\d+$/.test(str(s));
const cleanChat = (c) => str(c).replace(/[\s,;]+/g, "");

async function tgResolve(env, name, kvToken) {
  const token = env.TG_BOT_TOKEN || kvToken;
  if (!token) return { ok: false, error: "未配置机器人 Token" };
  const r = await rawAt(
    "https://api.telegram.org/bot" + token + "/getChat?chat_id=@" + encodeURIComponent(stripAt(name))
  );
  let j = null;
  try {
    j = JSON.parse(r.text);
  } catch (e) {}
  if (!j || !j.ok) return { ok: false, error: tgErr(String((j && j.description) || r.text)) };
  return { ok: true, id: String(j.result.id) };
}

// 常见误填拦截: 把机器人自己的 ID 填成了接收者 (机器人不能给自己发消息)。
// 只需查正数 ID; 负数是群组/频道, 不可能是机器人 ID。查不到时放行, 交给发送步骤报错。
async function botSelfErr(env, token, id) {
  if (!token || !/^\d+$/.test(String(id || ""))) return "";
  const r = await rawAt("https://api.telegram.org/bot" + token + "/getMe");
  let j = null;
  try {
    j = JSON.parse(r.text);
  } catch (e) {}
  return j && j.ok && String(j.result.id) === String(id)
    ? "这是机器人自己的 ID, 机器人不能给自己发消息。私聊收提醒请填你自己的正数用户 ID (问 @userinfobot 可得), Bot Token 才填机器人的"
    : "";
}

const chatKey = async (env, name) => "chat:" + (await hmac(env, "chat:" + name)).slice(0, 20);

const META_KEY = "meta:settings";

// ---- 存储抽象层: D1 优先, 未绑定 D1 时回退 KV ----
// 两种后端同一个键值语义: get(key)->json|null, put(key,json), del(key)
// D1 表: CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
// 绑定名: D1 数据库用 TUNNEL_DB (Settings → Bindings → D1 Database), KV 仍用 TUNNEL_STATE。
// D1 无 KV 的最终一致性延迟问题 (同连接读写一致), 更适合本面板频繁读写状态的模式。
const store = (env) => env.TUNNEL_DB || env.TUNNEL_STATE || null;
const isD1 = (b) => !!b && typeof b.prepare === "function" && typeof b.batch === "function";

async function storeGet(env, key) {
  const b = store(env);
  if (!b) return null;
  if (isD1(b)) {
    try {
      const r = await b.prepare("SELECT v FROM state WHERE k = ?1").bind(key).first();
      if (!r) return null;
      return JSON.parse(r.v);
    } catch (e) {
      return null; // 表不存在等异常按"无数据"处理, 与 KV 未写入一致
    }
  }
  return await b.get(key, "json");
}

async function storePut(env, key, val) {
  const b = store(env);
  if (!b) return;
  const v = JSON.stringify(val);
  if (isD1(b)) {
    await b.prepare("INSERT INTO state (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2").bind(key, v).run();
    return;
  }
  return await b.put(key, v);
}

async function storeDel(env, key) {
  const b = store(env);
  if (!b) return;
  if (isD1(b)) {
    await b.prepare("DELETE FROM state WHERE k = ?1").bind(key).run();
    return;
  }
  return await b.delete(key);
}

async function getMeta(env) {
  const meta = { chats: [], alerts: {}, botToken: "", paused: null, accounts: [], curAcc: "" };
  if (!store(env)) return meta;
  const saved = (await storeGet(env, META_KEY)) || {};
  meta.alerts = (saved && saved.alerts) || {};
  // 一次性迁移: 旧版本"提醒默认开"曾为每个隧道写入 {on:true}, 这里统一清回默认关。
  // 之后 saveMeta 总会写 alertsV2 标记, 保证只清一次, 不影响用户之后手动开启的开关
  if (saved && !saved.alertsV2 && Object.keys(meta.alerts).length) {
    meta.alerts = {};
    await storePut(env, META_KEY, { ...saved, alerts: {}, alertsV2: true });
  }
  meta.botToken = str(saved && saved.botToken);
  meta.paused = (saved && saved.paused) || null;
  meta.accounts = Array.isArray(saved && saved.accounts) ? saved.accounts : [];
  meta.curAcc = str(saved && saved.curAcc);
  for (const raw of (saved && saved.chats) || []) {
    const name = str(raw);
    const resolved = isChatId(name) ? "" : str((await storeGet(env, await chatKey(env, name)) || ""));
    meta.chats.push({ name, id: isChatId(name) ? name : resolved, ok: isChatId(name) || isChatId(resolved) });
  }
  return meta;
}

async function saveMeta(env, meta) {
  if (!store(env)) return;
  await storePut(env, META_KEY, {
    chats: meta.chats.map((c) => c.name),
    alerts: meta.alerts,
    alertsV2: true, // 已完成"提醒默认关"迁移的标记 (见 getMeta)
    botToken: meta.botToken || "",
    paused: meta.paused || null,
    accounts: meta.accounts || [],
    curAcc: meta.curAcc || "",
  });
}

// ---- 多账号 ----
// accounts: [{name, token, acc}] 保存到 D1/KV; env 里的 CF_API_TOKEN/CF_ACCOUNT_ID 永远作为
// 名为"默认账号"的隐式账号存在 (不可删除), 未选账号或存储不可用时回退到它。
// 提醒 (alerts/watch/隧道状态) 按账号隔离: 键里带账号 ID, 互不串扰。
function accountList(meta, env) {
  const list = [];
  if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID) list.push({ name: "默认账号", token: "", acc: env.CF_ACCOUNT_ID, builtin: true });
  for (const a of (meta && meta.accounts) || [])
    if (a && str(a.acc)) list.push({ name: str(a.name) || str(a.acc), token: str(a.token), acc: str(a.acc) });
  return list;
}
function pickAccount(meta, env, sel) {
  const list = accountList(meta, env);
  return list.find((a) => a.acc === str(sel)) || list[0] || null;
}

const chatTargets = (env, meta) => {
  const out = meta.chats.filter((c) => isChatId(c.id)).map((c) => c.id);
  if (out.length) return out;
  const fallback = cleanChat(env.TG_CHAT_ID);
  return isChatId(fallback) ? [fallback] : [];
};

const alertsPayload = (env, meta, now = Date.now()) => ({
  kv: !!store(env),
  bot: !!env.TG_BOT_TOKEN || !!meta.botToken,
  chats: meta.chats.map((c) => ({ name: c.name, id: c.id, ok: c.ok })),
  targets: chatTargets(env, meta).length,
  alerts: meta.alerts,
  // until:0 表示手动暂停 (无期限), until>now 表示限时暂停
  paused: !!meta.paused,
  pausedUntil: (meta.paused && meta.paused.until > now ? meta.paused.until : 0) || 0,
  hasToken: !!(meta.botToken || env.TG_BOT_TOKEN),
  tokenMask: meta.botToken ? meta.botToken.slice(0, 6) + "…****" : (env.TG_BOT_TOKEN ? "env:TG_BOT_TOKEN" : ""),
});

function requireKv(env) {
  if (!store(env))
    throw new Error("未绑定存储: 请绑定 D1 数据库 TUNNEL_DB 或 KV 命名空间 TUNNEL_STATE (Settings → Bindings)");
}

// ---- 在线状态与提醒 ----
// 存储键 (D1 表 state 的 k 列 / KV 键, 语义相同):
//   meta:settings            { chats: [...], alerts: { [tunnelId]: { on: false } }, accounts: [...], curAcc }
//   tunnel:state:<acc>:<id>  { on: 上次记录的状态, at: 时间 } (按账号隔离)
//   watch:<签名>              { at: 上次检查时间 }
// 与上次记录相比发生变化才提醒; 提醒前先写入新状态, 所以同一次变化只会提醒一次。
const isUp = (t) => t.status === "healthy";
const ST_TEXT = { healthy: "在线", degraded: "降级", down: "离线", inactive: "未启用" };

const fmtT = (ms, tz = 8) => {
  const d = new Date(ms + tz * 3600 * 1000);
  const z = (n) => String(n).padStart(2, "0");
  return z(d.getUTCMonth() + 1) + "-" + z(d.getUTCDate()) + " " + z(d.getUTCHours()) + ":" + z(d.getUTCMinutes());
};

async function readState(env, key) {
  if (!store(env)) return null;
  try {
    return await storeGet(env, key);
  } catch (e) {
    return null;
  }
}

// 最近活动记录 (按账号): 新数组放最前, 最多保留 24 条; 失败静默 (不影响主流程)
async function logAct(env, acc, kind, name, detail) {
  if (!store(env)) return;
  try {
    const key = "activity:" + acc;
    const list = (await storeGet(env, key)) || [];
    list.unshift({ t: Date.now(), k: kind, n: String(name || "").slice(0, 60), d: String(detail || "").slice(0, 80) });
    await storePut(env, key, list.slice(0, 24));
  } catch (e) {}
}

async function runChecks(env, list) {
  const kv = store(env);
  const now = Date.now();
  // 提醒状态按账号隔离 (多账号互不串扰)
  const accScope = env.cfAcc || env.CF_ACCOUNT_ID || "";
  // conns_active_at: 隧道建立首条到 Cloudflare 边缘连接的时间 (官方"运行时间"同源), 空=从未连接
  const tunnels = list.map((t) => ({ id: t.id, name: t.name, status: t.status, up: isUp(t), since: Date.parse(t.conns_active_at || "") || 0 }));
  const result = {
    tunnels,
    total: tunnels.length,
    online: tunnels.filter((t) => t.up).length,
    offline: tunnels.filter((t) => !t.up).length,
    kv: !!kv,
    alertOn: {},
    alert: { sent: 0, error: "", last: 0, paused: false },
  };
  if (!kv) return result; // 没有 KV/D1 就只展示状态, 不发提醒

  // 最近活动 (仪表板右栏): 无论是否在防抖窗口内都返回, 读取代价很小
  result.activity = (await readState(env, "activity:" + accScope)) || [];

  const meta = await getMeta(env);
  // 提醒默认关: 只有 meta.alerts[id].on === true 才发
  for (const t of tunnels) result.alertOn[t.id] = !!(meta.alerts[t.id] && meta.alerts[t.id].on === true);
  // 推送暂停状态
  // until:0 = 手动暂停; until>now = 限时暂停
  result.alert.paused = !!meta.paused;
  result.alert.pausedUntil = (meta.paused && meta.paused.until > now ? meta.paused.until : 0) || 0;
  const watchKey = "watch:" + (await hmac(env, "watch:" + accScope));
  const watch = await readState(env, watchKey);
  result.alert.last = (watch && watch.at) || 0;

  // 距离上次检查不足 20 秒就不重复比对, 避免反复刷新把一次抖动看成多次
  if (watch && now - watch.at < MIN_GAP_MS) return result;

  const prev = await Promise.all(tunnels.map((t) => readState(env, "tunnel:state:" + accScope + ":" + t.id)));
  const changed = tunnels.filter((t, i) => prev[i] && !!prev[i].on !== t.up && result.alertOn[t.id]);
  // 最近活动: 所有上下线变化都记录 (无论该隧道是否开了提醒)
  const changedAll = tunnels.filter((t, i) => prev[i] && !!prev[i].on !== t.up);

  // 先写状态再发消息: 并发请求下同一次变化也只提醒一次
  await Promise.all(
    tunnels.map((t) => storePut(env, "tunnel:state:" + accScope + ":" + t.id, { on: t.up, at: now }))
  );
  await storePut(env, watchKey, { at: now });

  if (changedAll.length)
    await Promise.all(changedAll.map((t) => logAct(env, accScope, t.up ? "on" : "off", t.name)));

  if (!changed.length) return result;
  if (result.alert.paused) {
    result.alert.error = "推送已暂停" + (meta.paused.until ? ", 至 " + fmtT(meta.paused.until) : "");
    return result;
  }
  const targets = chatTargets(env, meta);
  if (!targets.length) {
    result.alert.error = "没有可用的 Telegram 接收者";
    return result;
  }
  // 消息样式: 标题行 + 空行 + 每条变化一行 + 时间行
  const text = "📣 Argo Control 通知\n\n" +
    changed.map((t) => (t.up ? "🟢 隧道恢复: " : "🔴 隧道离线: ") + t.name).join("\n") +
    "\n🕒 " + fmtT(now);
  for (const id of targets) {
    const r = await tgSend(env, id, text, meta.botToken);
    if (r.ok) result.alert.sent++;
    else result.alert.error = r.error;
  }
  return result;
}

// ---- 路由 ----
const COOKIE = "cf_tunnel_sid";
// 关闭标志: 清 Cookie 时不需要 Secure 前缀也能生效
const setCookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${value ? "; Secure" : ""}; Max-Age=${maxAge}`;

// ---- API ----
async function handleApi(request, env, path) {
  const d = await request.json().catch(() => ({}));
  const uuid = (v) => UUID_RE.test(str(v));
  // 前端在所有请求里带 acc (当前所选账号); 32 位 hex 才作为有效选择
  if (/^[0-9a-f]{32}$/i.test(str(d.acc))) env.cfAcc = str(d.acc).toLowerCase();

  // 登录 / 退出 (不需要已登录)
  if (path === "/api/login") {
    if (!sameSecret(str(d.password), String(env.PASSWORD))) {
      await new Promise((r) => setTimeout(r, 500)); // 放慢暴力尝试
      return json({ error: "密码错误" }, 401);
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": setCookie(await makeSession(env), SESSION_TTL) },
    });
  }
  if (path === "/api/logout")
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json", "Set-Cookie": setCookie("", 0) },
    });

  // 以下接口都需要登录
  if (!(await checkSession(env, cookieValue(request, COOKIE)))) return json({ error: "请先登录" }, 401);

  if (path === "/api/tg") {
    const meta = await getMeta(env);
    if (str(d.action) === "save") {
      // 保存 bot token + 接收者, 两者都写入 KV
      requireKv(env);
      const token = str(d.token);
      if (token && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token))
        return json({ error: "Bot Token 格式不正确, 应为 123456789:AbC... 形式" }, 400);
      const raw = str(d.chat);
      let id = "";
      let name = "";
      if (raw) {
        const isName = /^@?[A-Za-z][A-Za-z0-9_]{4,}$/.test(raw) && !/^-/.test(raw);
        if (isName) {
          const r = await tgResolve(env, raw, token || meta.botToken);
          if (!r.ok) return json({ error: r.error }, 400);
          id = r.id;
          name = "@" + stripAt(raw);
        } else {
          id = cleanChat(raw);
          if (!isChatId(id)) return json({ error: "请输入数字 chat_id 或 @频道用户名" }, 400);
          name = id;
        }
      }
      if (id) {
        const bad = await botSelfErr(env, token || meta.botToken, id);
        if (bad) return json({ error: bad }, 400);
      }
      if (token) meta.botToken = token;
      if (name) {
        if (!isChatId(name) && id) await storePut(env, await chatKey(env, name), id);
        if (!meta.chats.some((c) => c.name === name)) meta.chats.push({ name, id, ok: true });
      }
      if (!meta.botToken) return json({ error: "请填写 Bot Token (或配置环境变量 TG_BOT_TOKEN)" }, 400);
      if (!meta.chats.length) return json({ error: "请填写接收提醒的 chat_id" }, 400);
      await saveMeta(env, meta);
      return json(alertsPayload(env, meta));
    }
    if (str(d.action) === "pause") {
      requireKv(env);
      const mins = Number(d.minutes) || 0;
      meta.paused = mins > 0 ? { until: Date.now() + mins * 60000 } : { until: 0 }; // 0 = 手动暂停, 不自动恢复
      await saveMeta(env, meta);
      return json(alertsPayload(env, meta));
    }
    if (str(d.action) === "resume") {
      requireKv(env);
      meta.paused = null;
      await saveMeta(env, meta);
      return json(alertsPayload(env, meta));
    }
    if (str(d.action) === "add" || str(d.action) === "test") {
      // 测试时优先用页面填写的 token, 其次 KV / 环境变量
      const token = str(d.token) || env.TG_BOT_TOKEN || meta.botToken;
      if (!token) return json({ error: "未配置机器人 Token (环境变量 TG_BOT_TOKEN 或 Telegram 配置)" }, 400);
      const raw = str(d.chat);
      const isName = /^@?[A-Za-z][A-Za-z0-9_]{4,}$/.test(raw) && !/^-/.test(raw);
      let id = "";
      let name = raw;
      if (isName) {
        const r = await tgResolve(env, raw, token);
        if (!r.ok) return json({ error: r.error }, 400);
        id = r.id;
        name = "@" + stripAt(raw);
      } else if (raw) {
        id = cleanChat(raw);
        if (!isChatId(id)) return json({ error: "请输入数字 chat_id 或 @频道用户名" }, 400);
        name = id;
      } else {
        // 测试发送未填接收者: 使用已保存的第一个接收者 (没有则提示先配置)
        const saved = chatTargets(env, meta);
        if (!saved.length) return json({ error: "请先填写通知配置" }, 400);
        id = saved[0];
        name = id;
      }
      const bad = await botSelfErr(env, token, id);
      if (bad) return json({ error: bad }, 400);
      // 先真正发一条消息确认可用, 成功了再保存
      const sent = await tgSend(env, id, "✅ Cloudflare 隧道管理: 提醒已连通", str(d.token) || meta.botToken);
      if (!sent.ok) return json({ error: sent.error }, 400);
      if (!store(env)) return json(alertsPayload(env, meta));
      if (!isChatId(name)) await storePut(env, await chatKey(env, name), id);
      if (!meta.chats.some((c) => c.name === name)) meta.chats.push({ name, id, ok: true });
      await saveMeta(env, meta);
      return json({ ...alertsPayload(env, meta), added: name });
    }
    if (str(d.action) === "remove") {
      const name = str(d.chat);
      meta.chats = meta.chats.filter((c) => c.name !== name);
      if (store(env)) {
        await storeDel(env, await chatKey(env, name));
        await saveMeta(env, meta);
      }
      return json(alertsPayload(env, meta));
    }
    return json(alertsPayload(env, meta));
  }

  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID)
    return json({ error: "未配置环境变量 CF_API_TOKEN / CF_ACCOUNT_ID" }, 500);

  // ---- 多账号解析: env.cfAcc 是前端本次请求选择的账号 ID ----
  // 无 KV / 未选 / 选择不存在时, 回退到 env 配置的默认账号 (cf() 里 token 同理)
  const meta0 = store(env) ? await getMeta(env) : { accounts: [] };
  const actx = pickAccount(meta0, env, env.cfAcc);
  if (!actx) return json({ error: "未配置任何 Cloudflare 账号 (环境变量或面板多账号管理)" }, 500);
  env.cfToken = actx.token || env.CF_API_TOKEN; // 该账号专属 API Token (默认账号用 env)
  env.cfAcc = actx.acc;

  const acc = env.cfAcc;
  const base = `/accounts/${acc}/cfd_tunnel`;

  if (["/api/token", "/api/detail", "/api/update", "/api/delete", "/api/alert", "/api/route", "/api/uptime"].includes(path) && !uuid(d.id))
    return json({ error: "隧道 ID 无效" }, 400);

  const svcErr = (s) =>
    SERVICE_RE.test(s) ? "" : "本地服务地址格式不正确, 例如 http://localhost:8001、tcp://localhost:22";

  // ---- 多账号管理 ----
  if (path === "/api/acc") {
    // list/switch 不强制要求存储: 未绑 KV/D1 时只有环境变量默认账号, 面板照常可用;
    // add/del 需要持久化, 才要求绑定存储
    const meta = await getMeta(env);
    const action = str(d.action);
    if (action === "list") {
      return json({
        accounts: accountList(meta, env).map((a) => ({ name: a.name, acc: a.acc, builtin: !!a.builtin })),
        cur: acc,
        persistent: !!store(env),
      });
    }
    if (action === "add") {
      requireKv(env);
      const name = str(d.name).trim().slice(0, 64);
      const token = str(d.token);
      const accId = str(d.acc);
      // 名称规则: 1-64 字符, 允许中文/英文字母/数字/空格/@._-+ 等; 至少含一个文字(字母/汉字/数字),
      // 不能全是标点符号 (防止只填 "..." 或 "---" 这种无法辨认的名字)
      if (!name || !/[\p{L}\p{N}]/u.test(name))
        return json({ error: "账号名称不能为空, 且需至少包含一个文字或数字 (不能全是标点符号)" }, 400);
      if (!/^[0-9a-f]{32}$/i.test(accId) || !token)
        return json({ error: "请填写 32 位账户 ID 和该账户的 API Token" }, 400);
      if (accountList(meta, env).some((a) => a.acc === accId)) return json({ error: "该账户 ID 已存在" }, 400);
      // 先验证: 直接用该 Token 请求此账户的隧道列表 (面板核心操作), 通得过才保存。
      // 注意: /accounts/{id} (账户详情) 需要 "Account Settings Read" 这类账户级权限,
      // 面板权限集里没有, 用它验证会误报权限不足; 隧道列表才是真实需要的能力。
      try {
        await cf({ cfToken: token, CF_API_TOKEN: token }, `/accounts/${accId}/cfd_tunnel?per_page=1`);
      } catch (e) {
        return json({ error: "账号验证失败: " + (e && e.message) }, 400);
      }
      meta.accounts.push({ name, token, acc: accId });
      await saveMeta(env, meta);
      return json({ ok: true, accounts: accountList(meta, env).map((a) => ({ name: a.name, acc: a.acc, builtin: !!a.builtin })) });
    }
    if (action === "edit") {
      requireKv(env);
      const accId = str(d.acc);
      const row = meta.accounts.find((a) => str(a.acc) === accId);
      if (!row) return json({ error: "账号不存在或为环境变量默认账号 (不可编辑)" }, 400);
      const newName = str(d.name).trim().slice(0, 64);
      const newAcc = str(d.newAcc);
      const newToken = str(d.token);
      // 名称: 填了就校验并更新; 留空保持原值
      if (newName) {
        if (!/[\p{L}\p{N}]/u.test(newName))
          return json({ error: "账号名称需至少包含一个文字或数字 (不能全是标点符号)" }, 400);
        row.name = newName;
      }
      // 账户 ID: 填了才改, 且不能与其他账号重复
      if (newAcc) {
        if (!/^[0-9a-f]{32}$/i.test(newAcc)) return json({ error: "账户 ID 需为 32 位十六进制" }, 400);
        if (accountList(meta, env).some((a) => a.acc === newAcc && a.acc !== accId))
          return json({ error: "该账户 ID 已存在" }, 400);
      }
      // Token: 填了才轮换; ID 或 Token 任一变更都要用(新)凭据验证
      if (newAcc || newToken) {
        const testAcc = newAcc || accId;
        const testToken = newToken || row.token;
        try {
          await cf({ cfToken: testToken, CF_API_TOKEN: testToken }, `/accounts/${testAcc}/cfd_tunnel?per_page=1`);
        } catch (e) {
          return json({ error: "账号验证失败: " + (e && e.message) }, 400);
        }
        if (newToken) row.token = newToken;
        if (newAcc) {
          row.acc = newAcc;
          if (meta.curAcc === accId) meta.curAcc = newAcc;
        }
      }
      await saveMeta(env, meta);
      return json({ ok: true, accounts: accountList(meta, env).map((a) => ({ name: a.name, acc: a.acc, builtin: !!a.builtin })) });
    }
    if (action === "del") {
      requireKv(env);
      const accId = str(d.acc);
      const builtin = accountList(meta, env).find((a) => a.acc === accId && a.builtin);
      if (builtin) return json({ error: "环境变量配置的默认账号不能删除" }, 400);
      meta.accounts = meta.accounts.filter((a) => str(a.acc) !== accId);
      if (meta.curAcc === accId) meta.curAcc = "";
      await saveMeta(env, meta);
      return json({ ok: true, accounts: accountList(meta, env).map((a) => ({ name: a.name, acc: a.acc, builtin: !!a.builtin })) });
    }
    if (action === "switch") {
      const accId = str(d.acc);
      if (!accountList(meta, env).some((a) => a.acc === accId)) return json({ error: "账号不存在" }, 400);
      if (store(env)) {
        meta.curAcc = accId; // 记住上次选择, 下次打开面板默认用它
        await saveMeta(env, meta);
      }
      return json({ ok: true, cur: accId });
    }
    return json({ error: "未知操作" }, 400);
  }

  if (path === "/api/init") {
    // 域名分布 (仪表板): 按账户统计托管域名数 (Zone→Read 权限, 每账户 1 次列表调用)。
    // 10 分钟存储缓存; 当前账户直接复用下方 zones 结果; 单账户失败回退旧缓存值
    const accList = accountList(meta0, env);
    const zones = await listZones(env);
    let dist = null;
    if (store(env)) {
      dist = await Promise.all(
        accList.map(async (a) => {
          const ck = "zdist:" + a.acc;
          const cached = (await storeGet(env, ck)) || null;
          if (a.acc === acc) {
            await storePut(env, ck, { n: zones.length, at: Date.now() });
            return { name: a.name, n: zones.length };
          }
          if (cached && Date.now() - cached.at < 600000) return { name: a.name, n: cached.n || 0 };
          try {
            const zs = await listZones({ ...env, cfToken: a.token || env.CF_API_TOKEN });
            await storePut(env, ck, { n: zs.length, at: Date.now() });
            return { name: a.name, n: zs.length };
          } catch (e) {
            return { name: a.name, n: (cached && cached.n) || 0 };
          }
        })
      );
    }
    return json({ zones, service: env.DEFAULT_SERVICE || "", cur: acc, envAcc: env.CF_ACCOUNT_ID || "", dist });
  }

  if (path === "/api/create") {
    const name = str(d.name), service = str(d.service);
    if (!name || !d.zoneId || !service) return json({ error: "请填写隧道名称和本地服务地址" }, 400);
    if (svcErr(service)) return json({ error: svcErr(service) }, 400);
    const created = await createTunnel(env, {
      name,
      zoneId: str(d.zoneId),
      sub: str(d.sub).replace(/\.$/, ""),
      path: str(d.path),
      service,
    });
    await logAct(env, acc, "add", name, created.hostname || "");
    return json(created);
  }
  if (path === "/api/list") return json(await runChecks(env, await listTunnels(env, base)));

  if (path === "/api/alert") {
    requireKv(env);
    const meta = await getMeta(env);
    const id = str(d.id);
    if (d.action === "toggle") {
      // 默认关: toggle=true 时写入 on:true, false 时移除 (回到默认关)
      if (d.on === true || d.on === "1") meta.alerts[id] = { on: true };
      else delete meta.alerts[id];
      await saveMeta(env, meta);
    } else if (d.action === "skip") {
      // 把上次记录改成当前状态, 等于吞掉这一次变化 (带账号作用域, 与 runChecks 一致)
      await storePut(env, "tunnel:state:" + acc + ":" + id, { on: !!d.up, at: Date.now() });
    } else if (d.action !== "get") return json({ error: "未知操作" }, 400);
    return json({ ...alertsPayload(env, meta), id, on: !!(meta.alerts[id] && meta.alerts[id].on === true) });
  }

  if (path === "/api/token") {
    if (d.rotate) {
      // 轮换 Token (请求体与官方后台完全一致): PATCH 隧道, 带 name(隧道名称) + 新的 tunnel_secret
      // (后台密钥格式: 两个 UUID 串接后 Base64), 响应的 result.token 就是新 Token
      // 旧 Token 立即失效, 服务器上的 cloudflared 需改用新 Token 重启
      let name = str(d.name);
      if (!name) {
        const tunnel = await cf(env, `${base}/${d.id}`);
        name = (tunnel && tunnel.name) || "";
      }
      const secret = btoa(crypto.randomUUID() + crypto.randomUUID());
      const rotated = await cf(env, `${base}/${d.id}`, "PATCH", { name: name, tunnel_secret: secret });
      const token = (rotated && (rotated.token || rotated.Token)) || "";
      if (token) return json({ token });
      // 兜底: 响应未带 token 时再单独取一次
      const fresh = await cf(env, `${base}/${d.id}/token`, "GET");
      const t2 = typeof fresh === "string" ? fresh : (fresh && (fresh.token || fresh.Token)) || "";
      return json({ token: t2 });
    }
    const result = await cf(env, `${base}/${d.id}/token`, "GET");
    const token = typeof result === "string" ? result : (result && (result.token || result.Token)) || "";
    return json({ token });
  }

  // 单隧道连接器运行时长: 取各连接器 run_at (连接建立时间) 的最早一条; 列表徽章无需调此接口
  if (path === "/api/uptime") {
    const conns = await cf(env, `${base}/${d.id}/connections`).catch(() => []);
    let since = 0;
    for (const c of Array.isArray(conns) ? conns : []) {
      const ts = Date.parse(c.run_at || c.create_time || c.CreateTime || "");
      if (ts && (!since || ts < since)) since = ts;
    }
    return json({ since, ms: since ? Date.now() - since : 0 });
  }

  // 新增/删除路由: 在已有隧道上追加一条 ingress 规则 (域名 + 可选路径 + 服务), 并自动配置 DNS
  if (path === "/api/route") {
    const action = str(d.action) || "add";
    const { config, ingress } = await getRules(env, base, d.id);
    const hostRules = () => ingress.filter((r) => r.hostname).map((r) => ({ hostname: r.hostname, path: r.path || "", service: r.service || "" }));

    if (action === "add") {
      const service = str(d.service);
      if (!d.zoneId || !service) return json({ error: "请选择域名并填写本地服务地址" }, 400);
      if (svcErr(service)) return json({ error: svcErr(service) }, 400);
      const sub = str(d.sub).replace(/\.$/, "");
      const p = str(d.path);
      const zone = await cf(env, `/zones/${d.zoneId}`);
      const hostname = sub ? `${sub}.${zone.name}` : zone.name;
      // 同隧道内同域名+同路径视为重复
      if (ingress.some((r) => r.hostname === hostname && (r.path || "") === p))
        return json({ error: "该域名+路径已存在于当前隧道" }, 400);
      if (ingress.length >= 60) return json({ error: "该隧道路由数量已达上限 (60)" }, 400);
      await checkHost(env, d.zoneId, hostname, d.id); // DNS 冲突就报错, 不覆盖
      const rule = { hostname, service };
      if (p) rule.path = p;
      const tail = ingress.findIndex((r) => !r.hostname && !r.path); // http_status:404 那条
      if (tail >= 0) ingress.splice(tail, 0, rule);
      else ingress.push(rule);
      await upsertCname(env, d.zoneId, hostname, d.id);
      try {
        await cf(env, `${base}/${d.id}/configurations`, "PUT", { config: { ...config, ingress } });
      } catch (e) {
        await cleanDns(env, d.id, [hostname]); // 写入失败撤掉刚建的 DNS
        throw e;
      }
      return json({ ok: true, rules: hostRules() });
    }

    if (action === "del") {
      const hostname = str(d.hostname);
      const p = str(d.path);
      const idx = ingress.findIndex((r) => r.hostname === hostname && (r.path || "") === p);
      if (idx < 0) return json({ error: "路由不存在" }, 404);
      ingress.splice(idx, 1);
      if (ingress.some((r) => r.hostname) && !ingress.some((r) => !r.hostname && !r.path))
        ingress.push({ service: "http_status:404" });
      await cf(env, `${base}/${d.id}/configurations`, "PUT", { config: { ...config, ingress } });
      // 只有这条路由还在用该域名时才清理 DNS
      const clean = ingress.some((r) => r.hostname === hostname) ? { dns: 0, dnsFailed: false } : await cleanDns(env, d.id, [hostname]);
      return json({ ok: true, rules: hostRules(), ...clean });
    }

    return json({ rules: hostRules() });
  }

  if (path === "/api/detail") {
    const [{ ingress }, zones] = await Promise.all([getRules(env, base, d.id), listZones(env)]);
    const rule = ingress.find((r) => r.hostname) || {};
    let zoneId = "";
    let sub = "";
    if (rule.hostname) {
      const z = zoneForHost(zones, rule.hostname);
      if (z) {
        zoneId = z.id;
        sub = rule.hostname === z.name ? "" : rule.hostname.slice(0, -(z.name.length + 1));
      }
    }
    return json({
      hostname: rule.hostname || "",
      zoneId,
      sub,
      path: rule.path || "",
      service: rule.service || "",
      others: ingress.filter((r) => r.hostname && r !== rule).length,
      // zoneId/sub 逐条给出, 供前端编辑弹窗按所选路由回填域名下拉与子域名
      rules: ingress
        .filter((r) => r.hostname)
        .map((rule) => {
          const z = zoneForHost(zones, rule.hostname);
          return {
            hostname: rule.hostname,
            path: rule.path || "",
            service: rule.service || "",
            zoneId: z ? z.id : "",
            sub: z && rule.hostname !== z.name ? rule.hostname.slice(0, -(z.name.length + 1)) : "",
          };
        }),
    });
  }

  if (path === "/api/update") {
    const service = str(d.service);
    if (!d.zoneId || !service) return json({ error: "请填写本地服务地址" }, 400);
    if (svcErr(service)) return json({ error: svcErr(service) }, 400);
    const sub = str(d.sub).replace(/\.$/, "");
    const p = str(d.path);
    const zone = await cf(env, `/zones/${d.zoneId}`);
    const hostname = sub ? `${sub}.${zone.name}` : zone.name;

    const { config, ingress } = await getRules(env, base, d.id);
    // 多条路由时: 前端带"原域名(host)+原路径(oldPath)"定位要编辑的规则; 未带则回退旧行为编辑第一条
    const oldHost = str(d.host);
    const oldPath = str(d.oldPath);
    let idx;
    if (oldHost) {
      idx = ingress.findIndex((r) => r.hostname === oldHost && (r.path || "") === oldPath);
      if (idx < 0) return json({ error: "要编辑的路由已不存在, 请刷新列表后重试" }, 400);
    } else {
      idx = ingress.findIndex((r) => r.hostname);
    }
    const rule = idx >= 0 ? { ...ingress[idx] } : {};
    rule.hostname = hostname;
    rule.service = service;
    if (p) rule.path = p;
    else delete rule.path;
    if (idx >= 0) ingress[idx] = rule;
    else ingress.unshift(rule);
    if (!ingress.some((r) => !r.hostname && !r.path)) ingress.push({ service: "http_status:404" });

    if (hostname !== oldHost) await checkHost(env, d.zoneId, hostname, d.id); // 先查冲突, 再动任何东西
    // 顺序: 改名 → 新 DNS → 写入规则 → 清理旧 DNS (越容易失败的越靠前)
    if (str(d.name)) await cf(env, `${base}/${d.id}`, "PATCH", { name: str(d.name) });
    const newDns = hostname !== oldHost;
    if (newDns) await upsertCname(env, d.zoneId, hostname, d.id);
    try {
      await cf(env, `${base}/${d.id}/configurations`, "PUT", { config: { ...config, ingress } });
    } catch (e) {
      if (newDns) await cleanDns(env, d.id, [hostname]); // 规则写入失败, 撤掉刚建的 DNS
      throw e;
    }

    let clean = { dns: 0, dnsFailed: false };
    if (oldHost && hostname !== oldHost && !ingress.some((r) => r.hostname === oldHost))
      clean = await cleanDns(env, d.id, [oldHost]);
    return json({ ok: true, hostname, ...clean });
  }

  if (path === "/api/delete") {
    // 先读出入口规则里的域名和隧道名 (隧道删除后就读不到了)
    let hosts = [];
    let tname = "";
    try {
      const t = await cf(env, `${base}/${d.id}`);
      tname = t.name || "";
    } catch (e) {}
    try {
      const c = await cf(env, `${base}/${d.id}/configurations`);
      hosts = ((c && c.config && c.config.ingress) || []).map((r) => r.hostname).filter(Boolean);
    } catch (e) {}
    try {
      await cf(env, `${base}/${d.id}/connections`, "DELETE");
    } catch (e) {}
    await cf(env, `${base}/${d.id}`, "DELETE");
    const clean = await cleanDns(env, d.id, hosts);
    if (store(env)) {
      await storeDel(env, "tunnel:state:" + acc + ":" + d.id).catch(() => {});
      const meta = await getMeta(env);
      if (meta.alerts[d.id]) {
        delete meta.alerts[d.id];
        await saveMeta(env, meta);
      }
    }
    await logAct(env, acc, "del", tname, hosts[0] || "");
    return json({ ok: true, ...clean });
  }

  return json({ error: "未知接口" }, 404);
}

export default {
  // Cron 定时检查: 必须作为 default 导出的属性, Cloudflare 才会调用 (独立具名导出无效)
  async scheduled(event, env, ctx) {
    env = applyConfig(env); // 顶部"配置填写区"优先
    if (!store(env)) return;
    // Cron 检查遍历所有账号 (env 默认账号 + 面板添加的账号), 各自独立提醒
    const meta = await getMeta(env);
    for (const a of accountList(meta, env)) {
      try {
        await runChecks({ ...env, cfToken: a.token || env.CF_API_TOKEN, cfAcc: a.acc },
          await listTunnels({ ...env, cfToken: a.token || env.CF_API_TOKEN, cfAcc: a.acc },
            `/accounts/${a.acc}/cfd_tunnel`));
      } catch (e) {}
    }
  },
  async fetch(request, env) {
    env = applyConfig(env); // 顶部"配置填写区"优先
    if (!env.PASSWORD) return new Response("请先配置环境变量 PASSWORD", { status: 500 });
    if (String(env.PASSWORD).length < 6) return new Response("PASSWORD 至少 6 位", { status: 500 });

    const url = new URL(request.url);
    const path = url.pathname;
    const isApi = path.startsWith("/api/");

    if (request.method === "POST" && isApi) {
      try {
        return await handleApi(request, env, path);
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 500);
      }
    }

    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method Not Allowed", { status: 405 });

    const loggedIn = await checkSession(env, cookieValue(request, COOKIE));
    const pwa = pwaResponse(path);
    if (pwa) return pwa;

    if (!loggedIn) return htmlRes(LOGIN_HTML);
    if (path === "/" || path === "/index.html") return htmlRes(HTML);
    return new Response("Not Found", { status: 404 });
  },
};

const CF_LOGO = '<svg width="100%" height="100%" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><circle cx="512" cy="512" r="512" style="fill:#f38020"/><path d="M608.2 592.4c3.1-10.8 1.9-20.7-3.3-28.1-4.8-6.7-12.9-10.6-22.6-11.1l-184.7-2.4c-1.1 0-2.2-.6-2.8-1.5-.6-.9-.7-2.1-.4-3.3.6-1.8 2.4-3.2 4.3-3.3l186.4-2.4c22.1-1 46.1-18.9 54.5-40.8l10.6-27.8c.5-1.2.6-2.4.3-3.6-12-54.3-60.5-94.8-118.4-94.8-53.4 0-98.7 34.5-114.9 82.4-10.5-7.8-23.9-12-38.3-10.6-25.7 2.5-46.2 23.1-48.8 48.8-.6 6.6-.1 13.1 1.4 19.1-41.9 1.2-75.3 35.4-75.3 77.6 0 3.7.3 7.5.8 11.2.3 1.8 1.8 3.1 3.6 3.1h340.9c1.9 0 3.8-1.4 4.3-3.3l2.4-9.2zM667 473.7c-1.6 0-3.4 0-5.1.2-1.2 0-2.2.9-2.7 2.1l-7.2 25c-3.1 10.8-2 20.7 3.3 28.1 4.8 6.7 12.9 10.6 22.7 11.1l39.3 2.4c1.2 0 2.3.6 2.8 1.5.6.9.7 2.3.5 3.3-.6 1.8-2.4 3.2-4.4 3.3l-41 2.4c-22.2 1-46 18.9-54.5 40.8l-3 7.6c-.6 1.5.5 3 2.1 3h140.8c1.6 0 3.1-1 3.6-2.7 2.4-8.7 3.7-17.9 3.7-27.3 0-55.5-45.3-100.8-101-100.8" style="fill:#fff"/></svg>';

const LOGIN_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f6821f">
<title>登录 · Cloudflare Argo Control</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;margin:0;padding:0}
body{min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#e8eaee;
background:#0c0e13;
background-image:
  radial-gradient(900px 480px at 18% -8%,rgba(246,130,31,.16),transparent 60%),
  radial-gradient(760px 420px at 88% 108%,rgba(246,130,31,.10),transparent 60%),
  linear-gradient(180deg,#12151c 0%,#0c0e13 100%);
background-attachment:fixed}
.wrap{width:100%;max-width:380px}
.card{background:rgba(26,29,35,.88);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
border:1px solid rgba(255,255,255,.08);border-radius:22px;padding:36px 30px 30px;text-align:center;
box-shadow:0 24px 70px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05)}
.logo{width:72px;height:72px;margin:0 auto 18px;filter:drop-shadow(0 8px 22px rgba(243,128,32,.35));transition:transform .25s}
.logo:hover{transform:translateY(-3px) scale(1.03)}
.logo svg{display:block;width:100%;height:100%}
h1{font-size:20px;font-weight:700;letter-spacing:.3px}
p.sub{margin:7px 0 26px;font-size:13px;color:#8b93a0}
.field{position:relative;text-align:left}
.field .li{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:#8b93a0;pointer-events:none;display:flex;align-items:center}
.field .li svg{width:15px;height:15px}
.field .eye{position:absolute;right:10px;top:50%;transform:translateY(-50%);width:auto;margin-top:0;border:0;background:none;color:#8b93a0;cursor:pointer;padding:5px;display:flex;align-items:center;justify-content:center;border-radius:8px;transition:color .15s,background .15s}
.field .eye:hover{color:#e8eaee;background:rgba(255,255,255,.06)}
.field .eye svg{width:18px;height:18px;display:block}
input{width:100%;padding:14px 44px 14px 42px;font-size:15px;color:#e8eaee;background:#12151a;
border:1px solid #2a2e36;border-radius:13px;outline:none;transition:border-color .15s,box-shadow .15s,background .15s;font-family:inherit}
input:hover{border-color:#3a404c}
input::placeholder{color:#5b6270}
input:focus{border-color:#f6821f;box-shadow:0 0 0 3px rgba(246,130,31,.18)}
button{width:100%;margin-top:18px;padding:14px;border:0;border-radius:13px;font-size:15px;font-weight:700;color:#fff;letter-spacing:2px;
background:linear-gradient(135deg,#f6821f,#ff9d4a);cursor:pointer;
box-shadow:0 8px 24px rgba(246,130,31,.32);transition:transform .12s,box-shadow .15s,opacity .15s;font-family:inherit}
button:hover{box-shadow:0 10px 30px rgba(246,130,31,.45)}
button:active{transform:scale(.98)}
button:disabled{opacity:.6;pointer-events:none}
button.oks{opacity:1;background:linear-gradient(135deg,#17a35f,#2ecc7d);box-shadow:0 8px 24px rgba(34,160,107,.35)}
.err{display:flex;align-items:center;justify-content:center;gap:6px;min-height:20px;margin-top:14px;color:#e05252;font-size:13px}
.foot{margin-top:22px;font-size:11.5px;display:flex;align-items:center;justify-content:center}
.foot a{color:#5b6270;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:color .15s}
.foot a:hover{color:#8b93a0}
.foot svg{width:14px;height:14px;opacity:.55}
@media(prefers-color-scheme:light){
  body{background-image:radial-gradient(900px 480px at 18% -8%,rgba(246,130,31,.14),transparent 60%),radial-gradient(760px 420px at 88% 108%,rgba(246,130,31,.08),transparent 60%),linear-gradient(180deg,#f7f4ef 0%,#eef0f4 100%)}
  .card{background:rgba(255,255,255,.9);border-color:rgba(0,0,0,.06);box-shadow:0 24px 70px rgba(30,34,40,.14)}
  h1{color:#1d2129}
  input{background:#f4f5f7;color:#1d2129;border-color:#e3e6ea}
}
</style></head><body>
<div class="wrap">
  <form class="card" id="f" novalidate>
    <div class="logo">${CF_LOGO}</div>
    <h1>Cloudflare Argo Control</h1>
    <p class="sub">Tunnel 管理与 Telegram 上下线提醒</p>
    <div class="field">
      <span class="li"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>
      <input id="pw" type="password" name="password" placeholder="请输入访问密码" autocomplete="current-password" autofocus>
      <button type="button" class="eye" id="eye" aria-label="显示或隐藏密码" title="显示/隐藏密码"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button>
    </div>
    <button id="go" type="submit">登 录</button>
    <div class="err" id="err"></div>
    <div class="foot"><a href="https://github.com/eooce/cloudflare-tunnel-panel" target="_blank" rel="noopener noreferrer">${CF_LOGO} Cloudflare Tunnel Panel</a></div>
  </form>
</div>
<script>
var f=document.getElementById('f'),pw=document.getElementById('pw'),go=document.getElementById('go'),err=document.getElementById('err');
var EYE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
var EYE_OFF='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.5 10.5 0 0 1 12 19c-6.5 0-10-7-10-7a19 19 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m3 3 18 18"/></svg>';
document.getElementById('eye').addEventListener('click',function(){
  var show=pw.type==='password';
  pw.type=show?'text':'password';
  this.innerHTML=show?EYE_OFF:EYE;
  this.setAttribute('aria-label',show?'隐藏密码':'显示密码');
  pw.focus();
});
f.addEventListener('submit',async function(e){
  e.preventDefault();
  if(!pw.value){err.textContent='⚠ 请输入密码';pw.focus();return}
  go.disabled=true;go.textContent='登录中...';err.textContent='';
  try{
    var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});
    var d=await r.json().catch(function(){return {}});
    if(!r.ok)throw new Error(d.error||'登录失败');
    go.textContent='✓ 登录成功';go.classList.add('oks');
    location.replace('/');
  }catch(ex){
    err.textContent='⚠ '+(ex.message||'登录失败');go.disabled=false;go.textContent='登 录';pw.select();
  }
});
</script></body></html>`;

const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f6821f">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/png" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Cloudflare 隧道管理面板</title>
<script>
// 防闪白: 页面渲染前先把已保存的主题写到 html 根元素 (跟随系统 = 不设置 data-theme)
(function(){try{
  var t=localStorage.getItem('theme');
  if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);
}catch(e){}})();
</script>
<style>
/* 设计变量: 颜色 + 三级圆角/阴影体系 */
:root{--bg:#f4f5f7;--card:#fff;--text:#1d2129;--sub:#7a828e;--line:#e3e6ea;--brand:#f6821f;--brand2:#ff9d4a;--ok:#22a06b;--bad:#d93f3f;--warn:#e8a317;--code:#16181d;--codet:#d7dae0;--side:#1b1e24;--side2:#2a2f38;--sideText:#c9cfd8;--in:#f4f5f7;
--r-sm:8px;--r-md:12px;--r-lg:16px;
--sh-sm:0 1px 2px rgba(16,20,26,.05),0 1px 6px rgba(16,20,26,.04);
--sh-md:0 2px 8px rgba(16,20,26,.06),0 8px 24px rgba(16,20,26,.07);
--sh-lg:0 12px 40px rgba(16,20,26,.16),0 2px 10px rgba(16,20,26,.08);
--focus:0 0 0 3px rgba(246,130,31,.16)}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#1a1d23;--text:#e8eaee;--sub:#8b93a0;--line:#2a2e36;--code:#0a0b0e;--codet:#c9ccd3;--side:#15181d;--side2:#262b33;--in:#12151a;
--sh-sm:0 1px 2px rgba(0,0,0,.25),0 1px 6px rgba(0,0,0,.2);
--sh-md:0 2px 8px rgba(0,0,0,.28),0 8px 24px rgba(0,0,0,.25);
--sh-lg:0 12px 40px rgba(0,0,0,.5),0 2px 10px rgba(0,0,0,.3)}}
/* 手动主题: html[data-theme=light] 恒为亮色, [data-theme=dark] 恒为暗色; 未设置时跟随系统 */
/* 侧栏不再恒为深色: 亮色=浅侧栏, 暗色=深侧栏, 切换时肉眼可见 */
html[data-theme="light"]{--bg:#f4f5f7;--card:#fff;--text:#1d2129;--sub:#7a828e;--line:#e3e6ea;--code:#0f5849;--codet:#d7dae0;--side:#eef0f4;--side2:#dfe3e9;--sideText:#3d4450;--in:#f4f5f7;
--sh-sm:0 1px 2px rgba(16,20,26,.05),0 1px 6px rgba(16,20,26,.04);
--sh-md:0 2px 8px rgba(16,20,26,.06),0 8px 24px rgba(16,20,26,.07);
--sh-lg:0 12px 40px rgba(16,20,26,.16),0 2px 10px rgba(16,20,26,.08)}
html[data-theme="dark"]{--bg:#0f1115;--card:#1a1d23;--text:#e8eaee;--sub:#8b93a0;--line:#2a2e36;--code:#0a0b0e;--codet:#c9ccd3;--side:#15181d;--side2:#262b33;--sideText:#c9cfd8;--in:#12151a;
--sh-sm:0 1px 2px rgba(0,0,0,.25),0 1px 6px rgba(0,0,0,.2);
--sh-md:0 2px 8px rgba(0,0,0,.28),0 8px 24px rgba(0,0,0,.25);
--sh-lg:0 12px 40px rgba(0,0,0,.5),0 2px 10px rgba(0,0,0,.3)}
html[data-theme="light"] body{background-image:radial-gradient(900px 480px at 18% -8%,rgba(246,130,31,.14),transparent 60%),radial-gradient(760px 420px at 88% 108%,rgba(246,130,31,.08),transparent 60%),linear-gradient(180deg,#f7f4ef 0%,#eef0f4 100%)}
html[data-theme="dark"] body{background-image:none}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);font-size:14px;-webkit-font-smoothing:antialiased}
/* 细滚动条 */
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:8px}
::-webkit-scrollbar-thumb:hover{background:var(--side2)}
.app{display:flex;height:100vh;height:100dvh;overflow:hidden}
.sidenav{width:204px;flex:none;background:var(--side);color:var(--sideText);display:flex;flex-direction:column;padding:calc(env(safe-area-inset-top,0px) + 18px) 12px calc(env(safe-area-inset-bottom,0px) + 14px)}
.sidenav .brand{display:flex;align-items:center;gap:11px;padding:2px 8px 20px;color:var(--text);cursor:pointer;border-radius:10px;transition:opacity .15s}
.sidenav .brand:hover{opacity:.82}
.sidenav .brand .ic{width:42px;height:42px;flex:none;border-radius:13px;background:linear-gradient(135deg,var(--brand),var(--brand2));display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 3px 10px rgba(246,130,31,.35)}
.sidenav .brand .ic svg{width:22px;height:22px}
.sidenav .brand .bt{display:flex;flex-direction:column;min-width:0;line-height:1.15}
.sidenav .brand .bt b{font-size:15.5px;font-weight:800;letter-spacing:.2px;white-space:nowrap}
.sidenav .brand .bt i{font-style:normal;font-size:9.5px;font-weight:600;letter-spacing:2.4px;color:var(--sub);margin-top:4px;white-space:nowrap}
.nav{display:flex;flex-direction:column;gap:3px}
.nav a{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--r-sm);color:var(--sideText);text-decoration:none;font-size:14px;cursor:pointer;transition:background .15s,color .15s,transform .15s}
.nav a:hover{background:var(--side2);transform:translateX(2px)}
.nav a.on{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(246,130,31,.35)}
.nav a.on:hover{transform:none}
.nav a .i{width:18px;height:18px;flex:none;display:flex;align-items:center;justify-content:center}
.nav a .i svg{width:17px;height:17px}
.sidenav .foot{margin-top:auto;font-size:12.5px;color:var(--sub)}
.sidenav .foot a{color:var(--sub);text-decoration:none;padding:8px;border-radius:var(--r-sm);display:flex;align-items:center;gap:7px;transition:color .15s,background .15s}
.sidenav .foot a .i{display:inline-flex;width:15px;height:15px;align-items:center;justify-content:center}
.sidenav .foot a .i svg{width:15px;height:15px}
.sidenav .foot a .lo{margin-left:auto;font-size:14px;opacity:0;transform:translateX(-6px);transition:opacity .18s,transform .18s}
.sidenav .foot a:hover{background:var(--side2);color:#e05252}
.sidenav .foot a:hover .i{color:#e05252}
.sidenav .foot a:hover .lo{opacity:1;transform:none}
.am-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border:1px solid var(--line);border-radius:var(--r-md);margin-bottom:8px;background:var(--in);transition:border-color .15s,box-shadow .15s}
.am-item:hover{border-color:var(--brand);box-shadow:var(--sh-sm)}
.am-edit{border:1px dashed var(--line);border-radius:var(--r-md);padding:10px 11px;margin:-4px 0 10px;background:var(--in)}
.main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.topbar{display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top,0px) + 12px) 20px 12px;background:color-mix(in srgb,var(--card) 86%,transparent);-webkit-backdrop-filter:blur(12px) saturate(1.4);backdrop-filter:blur(12px) saturate(1.4);border-bottom:1px solid var(--line);flex:none;position:relative;z-index:5}
/* 标题绝对定位居中于整条顶栏(不参与 flex 布局); 账号组 margin-right:auto 贴左 */
.topbar h2{margin:0;font-size:16px;position:absolute;left:50%;transform:translateX(-50%);max-width:40%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.accwrap{display:flex;align-items:center;gap:9px;flex:none;margin-right:auto}
.aclabel{font-size:13.5px;color:#f0932f;font-weight:700;white-space:nowrap}
.amhint{color:var(--sub);font-weight:400}
.accwrap select{width:auto;min-width:170px;max-width:280px;padding:6px 9px;font-size:13.5px;text-align:left;font-weight:600}
.content{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:18px 20px calc(env(safe-area-inset-bottom,0px) + 40px)}
.wrap{max-width:1400px;margin:0 auto}
.view{display:none}
.view.on{display:block;animation:vfade .22s ease}
@keyframes vfade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.view.on{animation:none}}
.card{background:var(--card);border-radius:var(--r-lg);padding:18px;margin-bottom:14px;box-shadow:var(--sh-sm);border:1px solid var(--line);transition:box-shadow .18s,border-color .18s}
.card:hover{box-shadow:var(--sh-md)}
.card h3{margin:0 0 12px;font-size:15px;display:flex;justify-content:space-between;align-items:center;gap:10px;letter-spacing:.2px}
label{display:block;font-size:12px;color:var(--sub);margin:12px 0 5px}
input,select{width:100%;padding:11px;font-size:15px;color:var(--text);background:var(--in);border:1px solid var(--line);border-radius:var(--r-sm);outline:none;transition:border .15s,box-shadow .15s;font-family:inherit}
input:hover,select:hover{border-color:var(--side2)}
input:focus,select:focus{border-color:var(--brand);box-shadow:var(--focus)}
select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237a828e' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:30px}
.row{display:flex;gap:8px}.row .sub{flex:1;min-width:0}.row .zone{flex:1.3;min-width:0}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:14px}
.search{flex:1;min-width:0;position:relative}
.search input{padding-left:36px;padding-right:40px}
.search .si{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--sub);pointer-events:none;display:flex}
.search .si svg{width:15px;height:15px}
.search .qx{position:absolute;right:10px;top:50%;transform:translateY(-50%);width:22px;height:22px;border:0;border-radius:50%;
background:var(--side2);color:var(--sub);font-size:12px;line-height:1;cursor:pointer;display:none;align-items:center;justify-content:center;padding:0;transition:background .15s,color .15s}
.search .qx:hover{background:var(--bad);color:#fff}
.search.has .qx{display:flex}
.preview{margin-top:14px;padding:10px 12px;border-radius:var(--r-sm);background:var(--in);font-size:13px;color:var(--sub);white-space:nowrap;overflow-x:auto;line-height:1.6}
.preview b{color:var(--brand)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:10px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--brand),var(--brand2));white-space:nowrap;box-shadow:0 2px 10px rgba(246,130,31,.3);transition:transform .12s,box-shadow .15s,background .15s,border-color .15s,color .15s,opacity .15s}
.btn:hover{box-shadow:0 4px 16px rgba(246,130,31,.42);transform:translateY(-1px)}
.btn.sm{padding:6px 11px;font-size:12.5px;font-weight:500;background:var(--in);background-image:none;color:var(--text);border:1px solid var(--line);box-shadow:none}
.btn.sm:hover{border-color:var(--brand);color:var(--brand);transform:none;box-shadow:var(--sh-sm)}
#theme{font-size:15px;line-height:1;padding:6px 10px}
#theme:hover{color:var(--text)}
.btn.sm.red{color:var(--bad)}
.btn.sm.red:hover{border-color:var(--bad);background:rgba(217,63,63,.08);color:var(--bad)}
.btn.red-solid{background:#d93f3f;background-image:none;box-shadow:0 2px 10px rgba(217,63,63,.3)}
.btn.red-solid:hover{background:#e05252;box-shadow:0 4px 16px rgba(217,63,63,.4)}
.btn.green-solid{background:#1f9d63;background-image:none;box-shadow:0 2px 10px rgba(31,157,99,.3);border:1px solid transparent;color:#fff}
.btn.green-solid:hover{background:#22b371}
.btn:active{transform:scale(.98)}.btn:disabled{opacity:.55;pointer-events:none}
.spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.5);border-top-color:#fff;border-radius:50%;animation:r .7s linear infinite;display:inline-block}
.btn.gray .spin,.btn.sm .spin,.busy .spin{border-color:var(--line);border-top-color:var(--brand)}
@keyframes r{to{transform:rotate(360deg)}}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:14px}
/* 仪表板两栏: 左侧隧道状态较窄, 右侧堆叠(域名分布+最近活动+项目链接), 高度与左卡对齐 */
.dash-cols{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,1fr);gap:14px;align-items:stretch}
.dash-right{display:flex;flex-direction:column;min-width:0}
.scroll-y{max-height:395px;overflow-y:auto;overscroll-behavior:contain}
.actcard{flex:1;min-height:0;display:flex;flex-direction:column}
.actcard h3{flex:none}
/* 活动列表: 最多显示 4 条 (renderAct 截断), 超出内部滚动; 不把左栏下沿撑高 */
.actcard #acts{flex:1;min-height:0;max-height:240px;overflow-y:auto}
/* 仪表板 fit 模式: 仅 PC (≥761px) 生效 — 占满视口、卡片内部滚动、整页不滚动、github 链接不出屏。
   手机由媒体查询直接禁用这些规则, fit 类残留也不会隐藏内容 */
@media(min-width:761px){
  .content.fit{overflow:hidden;padding-bottom:calc(env(safe-area-inset-bottom,0px) + 14px)}
  .content.fit .wrap{height:100%;display:flex;flex-direction:column}
  .content.fit .wrap>#v-dash{flex:1;min-height:0;display:flex;flex-direction:column}
  .content.fit .stats{flex:none}
  .content.fit .dash-cols{flex:1;min-height:0}
  .content.fit .dash-cols>.card{display:flex;flex-direction:column;min-height:0}
  .content.fit .dash-cols>.card #dash{flex:1;min-height:0;max-height:none}
  .content.fit .dash-right{min-height:0}
  .content.fit .ghlink{flex:none}
  .content.fit .actcard #acts{max-height:none}
}
.act{display:flex;align-items:flex-start;gap:9px;padding:8px 2px;border-top:1px solid var(--line);font-size:12.5px}
.act:first-child{border-top:0}
.act .ad{width:7px;height:7px;border-radius:50%;flex:none;margin-top:5px}
.act .at{flex:1;min-width:0;color:var(--sub);line-height:1.5;word-break:break-all}
.act .at b{color:var(--text);font-weight:600}
.act .as{display:block;font-size:11px;color:var(--sub);opacity:.85}
.act .az{flex:none;color:var(--sub);opacity:.75;font-size:11px;font-variant-numeric:tabular-nums;margin-top:1px}
.dwrap{display:flex;align-items:center;gap:16px;margin-top:12px;flex-wrap:wrap}
.donut{width:132px;height:132px;flex:none}
.donut .dnum{fill:var(--text);font-size:9.5px;font-weight:800;text-anchor:middle;font-variant-numeric:tabular-nums}
.donut .dlab{fill:var(--sub);font-size:3.6px;text-anchor:middle}
.dlegend{flex:1;min-width:150px;display:flex;flex-direction:column;gap:10px;max-height:190px;overflow-y:auto;padding-right:2px}
.dli{display:flex;align-items:center;gap:8px;font-size:12.5px}
.dli .dd{width:8px;height:8px;border-radius:50%;flex:none}
.dli .dn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--sub)}
.dli b{color:var(--text);font-variant-numeric:tabular-nums}
.ghlink{display:flex;justify-content:center;padding:50px 0 0}
.ghlink a{color:var(--sub);font-size:11.5px;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:color .15s}
.ghlink a:hover{color:var(--text)}
.ghlink svg{width:14px;height:14px;opacity:.6}
.act{display:flex;align-items:flex-start;gap:9px;padding:8px 2px;border-top:1px solid var(--line);font-size:12.5px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:18px;box-shadow:var(--sh-sm);display:flex;flex-direction:column;align-items:center;text-align:center;transition:transform .18s,box-shadow .18s,border-color .18s}
.stat:hover{transform:translateY(-2px);box-shadow:var(--sh-md);border-color:var(--side2)}
.stat .ic{width:46px;height:46px;flex:none;border-radius:14px;display:flex;align-items:center;justify-content:center}
.stat .ic svg{width:22px;height:22px}
.stat .ic.all{background:rgba(59,130,246,.13);color:#3b82f6}
.stat .ic.up{background:rgba(34,160,107,.13);color:var(--ok)}
.stat .ic.down{background:rgba(232,163,23,.16);color:var(--warn)}
.stat .ic.acc{background:rgba(139,92,246,.14);color:#8b5cf6}
.stat .k{font-size:13px;color:var(--sub);margin-top:12px}
.stat .v{font-size:32px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.5px;margin-top:4px}
.stat.on .v{color:var(--ok)}.stat.off .v{color:var(--bad)}.stat.acc .v{color:#8b5cf6}
.code{margin-top:0;position:relative}
.code pre{margin:0;padding:12px;background:var(--code);color:var(--codet);border-radius:10px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;cursor:pointer;transition:box-shadow .15s}
.code pre:hover{box-shadow:0 0 0 1px var(--brand)}
.code .hintcp{position:absolute;bottom:8px;right:10px;display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:7px;background:rgba(8,12,10,.92);color:#2ecc7d;border:1px solid rgba(255,255,255,.18);font-size:12px;opacity:0;pointer-events:none;transition:opacity .15s;z-index:2}
.code:hover .hintcp{opacity:1}
.tit{font-size:12px;color:var(--sub);margin:14px 0 6px;display:flex;justify-content:space-between;align-items:center}
.banner{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:12px;margin-bottom:14px;font-size:14px;line-height:1.5;background:rgba(34,160,107,.12);color:var(--ok)}
.banner .ck{width:26px;height:26px;flex:none;border-radius:50%;background:var(--ok);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px}
.banner .bd{flex:1;min-width:0}
.item{border-top:1px solid var(--line);padding:10px 6px;position:relative;border-radius:var(--r-sm);transition:background .15s}
.item:hover{background:color-mix(in srgb,var(--in) 55%,transparent)}
.item:first-child{border-top:0}
.item .top{display:flex;align-items:center;gap:8px}
.item .nm{font-weight:600;flex:1;min-width:0;word-break:break-all}
.dot{width:9px;height:9px;border-radius:50%;background:var(--sub);flex:none;position:relative}
.dot.healthy{background:var(--ok)}
.dot.healthy::after{content:"";position:absolute;inset:-4px;border-radius:50%;background:rgba(34,160,107,.28);animation:pulse 2.2s ease-out infinite}
@keyframes pulse{0%{transform:scale(.55);opacity:1}70%{transform:scale(1.5);opacity:0}100%{opacity:0}}
@media(prefers-reduced-motion:reduce){.dot.healthy::after{animation:none}}
.dot.down{background:var(--bad)}.dot.degraded{background:var(--warn)}
.badge{font-size:12px;padding:2px 9px;border-radius:20px;background:var(--in);color:var(--sub);flex:none;font-variant-numeric:tabular-nums}
.badge.healthy{background:rgba(34,160,107,.14);color:var(--ok)}
.badge.degraded{background:rgba(232,163,23,.16);color:var(--warn)}
.badge.down{background:rgba(217,63,63,.13);color:var(--bad)}
.id{font-size:11px;color:var(--sub);margin:2px 18px 0;word-break:break-all}
/* 紧凑行: 第一行 名称+域名+状态徽标, 第二行 路由+操作按钮全部一排 */
/* trow 不再是定位上下文: 按钮组/状态徽章改以 .item(整行) 为基准垂直居中 */
.trow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.trow .nm{font-weight:600;flex:none;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trow .id{margin:0;flex:none;font-size:11px;color:var(--sub);word-break:break-all}
.trow .host{flex:1;min-width:120px;font-size:12.5px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.trow .host b{color:var(--text);font-weight:600}
.trow .host .rp{color:var(--warn)}
.routes{margin:2px 18px 0;font-size:12.5px;color:var(--sub);line-height:1.6}
.routes b{color:var(--text);font-weight:600}
.routes .rp{color:var(--warn)}
.acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end;flex:1;min-width:280px;margin-right:106px}
.acts .btn.sm{padding:4px 10px;font-size:12px;border-radius:8px}
.acts .btn.sm .btxt{display:none}
/* 宽屏: 按钮组脱离文本流, 相对整条 item(名称行+路由行)垂直居中; 右侧留出徽章位置 */
@media(min-width:900px){.acts .btn.sm .btxt{display:inline}.acts .btn.sm .bico{margin-right:2px}
  .trow .acts{position:absolute;top:50%;transform:translateY(-50%);right:106px;margin:0;flex:none}}
/* 路由表格 (编辑/路由弹窗) */
.rtable{margin-top:8px}
.rtable .rt{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;background:var(--in);margin-bottom:6px;font-size:13px}
.rtable .rt .rh{flex:1;min-width:0;word-break:break-all}
.rtable .rt .rh b{color:var(--text)}
.rtable .rt .rs{color:var(--sub);flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{font-size:11.5px;padding:3px 9px;border-radius:20px;background:var(--in);color:var(--sub);border:1px solid var(--line);white-space:nowrap}
.pill.on{color:var(--ok);border-color:rgba(34,160,107,.4)}
.pill.off{color:var(--bad);border-color:rgba(217,63,63,.35)}
.pill.warn{color:var(--warn);border-color:rgba(232,163,23,.4)}
.empty{color:var(--sub);font-size:14px;text-align:center;padding:26px 0}
.hint{font-size:13px;color:var(--sub);margin:2px 0 6px;line-height:1.65}
.mask{position:fixed;inset:0;background:rgba(10,12,16,.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:none;z-index:8}
.mask.show{display:block}
.modal{position:fixed;left:50%;top:50%;z-index:9;width:min(560px,calc(100% - 24px));max-height:calc(100vh - 40px);overflow-y:auto;background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px;box-shadow:var(--sh-lg);display:none;transform:translate(-50%,-46%) scale(.97);opacity:0}
.modal.show{display:block;animation:min .2s ease forwards}
@keyframes min{from{transform:translate(-50%,-46%) scale(.97);opacity:0}to{transform:translate(-50%,-50%) scale(1);opacity:1}}
@media(prefers-reduced-motion:reduce){.modal.show{animation:none;transform:translate(-50%,-50%);opacity:1}}
.modal.confirm{top:120px;transform:translate(-50%,0);width:min(400px,calc(100% - 24px));padding:22px 22px 18px;overflow:visible}
.modal.confirm.show{animation:minc .2s ease forwards}
@keyframes minc{from{transform:translate(-50%,-8px);opacity:0}to{transform:translate(-50%,0);opacity:1}}
.modal.confirm h3{margin:0 0 8px;font-size:16px;display:flex;align-items:center;gap:9px}
.modal.confirm .wi{width:34px;height:34px;flex:none;border-radius:50%;background:rgba(232,163,23,.15);color:var(--warn);display:flex;align-items:center;justify-content:center;font-size:16px}
.modal.confirm p{margin:0 0 18px;font-size:13.5px;color:var(--sub);line-height:1.7;word-break:break-all}
.modal.confirm .btns .btn{flex:none;padding:9px 22px}
.modal.confirm .btns .btn.danger{margin-left:auto}
.modal h3{margin:0 0 4px;font-size:17px;display:flex;justify-content:space-between;align-items:center;gap:10px;letter-spacing:.2px}
.modal .x{border:0;background:none;color:var(--sub);font-size:19px;cursor:pointer;padding:0 4px;line-height:1;border-radius:8px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
.modal .x:hover{background:var(--in);color:var(--text)}
.btns{display:flex;gap:10px;margin-top:18px}.btns .btn{flex:1}
.btn.gray{background:var(--in);background-image:none;color:var(--text);border:1px solid var(--line);box-shadow:none}
.btn.gray:hover{border-color:var(--brand);color:var(--brand);transform:none;box-shadow:var(--sh-sm)}
.busy{position:fixed;inset:0;z-index:10;display:none;align-items:center;justify-content:center;background:rgba(10,12,16,.32);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)}
.busy.show{display:flex}
.busy .box{background:var(--card);color:var(--text);padding:18px 26px;border-radius:var(--r-md);display:flex;align-items:center;gap:12px;font-size:15px;box-shadow:var(--sh-lg)}
.busy .spin{width:20px;height:20px;border:3px solid var(--line);border-top-color:var(--brand)}
#toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 14px);transform:translate(-50%,-160%);z-index:30;max-width:min(680px,92vw);display:flex;align-items:center;gap:8px;padding:9px 16px;border-radius:var(--r-md);font-size:14px;font-weight:600;line-height:1.45;opacity:0;pointer-events:none;transition:transform .24s ease,opacity .24s ease;box-shadow:var(--sh-lg)}
#toast.ok{color:#22a06b;background:var(--card);background:color-mix(in srgb,#22a06b 16%,var(--card));border:1px solid rgba(34,160,107,.45)}
#toast.err{color:#e05252;background:var(--card);background:color-mix(in srgb,#e05252 16%,var(--card));border:1px solid rgba(224,82,82,.45)}
#toast.show{opacity:1;transform:translate(-50%,0)}
#toast .ti{width:18px;height:18px;flex:none;line-height:1;display:flex;align-items:center;justify-content:center}
#toast .ti svg{width:16px;height:16px}
.chat{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
.chat:first-child{border-top:0}
.chat .ci{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#2aabee,#229ed9);color:#fff;display:flex;align-items:center;justify-content:center;flex:none;font-size:16px}
.chat .cn{flex:1;min-width:0}
.chat .cn b{display:block;font-size:14px}
.chat .cn span{font-size:12px;color:var(--sub);word-break:break-all}
.side-toggle{display:none;background:none;border:1px solid var(--line);border-radius:9px;padding:5px 10px;font-size:16px;color:var(--text);cursor:pointer}
@media(max-width:760px){
  .stats{grid-template-columns:repeat(2,1fr);gap:10px}
  .stat{padding:14px}
  .stat .ic{width:38px;height:38px;border-radius:12px}
  .stat .ic svg{width:18px;height:18px}
  .stat .k{font-size:11.5px;margin-top:9px}
  .stat .v{font-size:24px}
  .scroll-y{max-height:46vh}
  .dash-cols{grid-template-columns:1fr}
  /* 手机: 单列自然高度, 活动列表限高滚动 */
  .actcard #acts{flex:none;max-height:190px;min-height:0}
  .side-toggle{display:inline-block}
  .sidenav{position:fixed;left:0;top:0;bottom:0;z-index:20;transform:translateX(-100%);transition:transform .2s}
  .sidenav.open{transform:none;box-shadow:0 0 40px rgba(0,0,0,.4)}
  .content{padding:14px 12px calc(env(safe-area-inset-bottom,0px) + 40px)}
  .topbar{padding:calc(env(safe-area-inset-top,0px) + 10px) 10px 10px;gap:7px;flex-wrap:nowrap}
  /* 手机: 缩小字号, 下拉变窄, 标题不与账号组重叠, 主题按钮可见 */
  .topbar h2{position:static;transform:none;left:auto;max-width:none;font-size:13px;flex:1;min-width:0;order:2;text-align:right;padding-right:2px}
  .accwrap{order:1;flex:none;min-width:0;gap:5px}
  .aclabel{font-size:11.5px}
  .accwrap select{min-width:0;max-width:96px;width:auto;padding:5px 6px;font-size:12px}
  .btn.sm{padding:5px 8px;font-size:11.5px}
  .btn.sm#theme{padding:5px 7px;font-size:14px;flex:none}
  .btn.sm#acc_mgr{flex:none;font-size:13px;padding:4px 7px}
  .modal{left:0;top:auto;bottom:0;transform:none;width:100%;max-height:92vh;border-radius:18px 18px 0 0;border-bottom:0;padding-bottom:calc(env(safe-area-inset-bottom,0px) + 20px)}
  /* 手机抽屉入场: 从下方滑入 (覆盖桌面居中缩放动画, 那套 transform 在手机 left:0 布局下会偏移) */
  .modal.show,.modal.confirm.show{animation:mob .22s ease forwards;transform:none}
  @keyframes mob{from{transform:translateY(26px);opacity:0}to{transform:translateY(0);opacity:1}}
  /* 手机: 确认弹窗 (.modal.confirm 的 top/transform 优先级更高, 需单独覆盖), 否则会左偏出屏 */
  /* bottom:0 → 悬浮在底部上方 (避开手机浏览器底部工具栏), 不再贴死屏幕底缘 */
  .modal.confirm{top:auto;transform:none;width:100%;bottom:calc(env(safe-area-inset-bottom,0px) + 56px);border-radius:16px 16px 0 0}
  /* 手机: 账号管理弹窗的两个输入框上下堆叠, 不再并排错位 */
  .amrow{flex-direction:column;gap:0}
  .amrow > div{flex:none !important;width:100%}
  .amhint{display:block;margin-top:2px}
  .toolbar{gap:8px}
}
</style></head><body>
<div class="app">
  <aside class="sidenav" id="sidenav">
    <div class="brand" id="brandHome" title="回到仪表板"><span class="ic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 19a4.5 4.5 0 1 0-.42-8.98 6 6 0 1 0-11.06 3.1A3.5 3.5 0 0 0 6.5 19Z"/></svg></span><span class="bt"><b>Argo Control</b><i>TUNNEL MANAGE</i></span></div>
    <nav class="nav">
      <a data-v="dash" class="on"><span class="i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg></span>仪表板</a>
      <a data-v="tunnels"><span class="i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-.42-8.98 6 6 0 1 0-11.06 3.1A3.5 3.5 0 0 0 6.5 19Z"/><path d="M9 12v4"/><path d="m9 12 6-3"/><circle cx="15" cy="9" r=".8" fill="currentColor" stroke="none"/></svg></span>Tunnel 管理</a>
      <a data-v="tg"><span class="i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></span>Telegram 配置</a>
    </nav>
    <div class="foot"><a href="#" id="logout"><span class="i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg></span><span class="lt">退出登录</span><span class="lo">⇥</span></a></div>
  </aside>

  <div class="main">
    <div class="topbar">
      <button class="side-toggle" id="menu" title="菜单"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
      <h2 id="ttl">仪表板</h2>
      <div class="accwrap">
        <span class="aclabel">当前账户</span>
        <select id="acc_sel" title="切换 Cloudflare 账号"></select>
      </div>
      <button class="btn sm" id="acc_mgr" title="管理账号"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16" style="font-size:15px;vertical-align:-2px"><path d="M0 0h16v16H0z" fill="none"/><path fill="#d86d16" d="M6 5a2 2 0 1 1 4 0a2 2 0 0 1-4 0m-.5 3h5A1.5 1.5 0 0 1 12 9.5c0 1.116-.459 2.01-1.212 2.615C10.047 12.71 9.053 13 8 13s-2.047-.29-2.788-.885C4.46 11.51 4 10.616 4 9.5A1.5 1.5 0 0 1 5.5 8M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8"/></svg></button>
      <button class="btn sm" id="refresh">刷新</button>
      <button class="btn sm" id="theme" title="切换白天/黑夜主题"></button>
    </div>
    <div class="content" id="content"><div class="wrap">

      <section class="view on" id="v-dash">
        <div class="stats">
          <div class="stat"><div class="ic all"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="5" rx="1.5"/><rect x="3" y="16" width="6" height="5" rx="1.5"/><rect x="15" y="16" width="6" height="5" rx="1.5"/><path d="M12 8v3.5M12 11.5H6V16M12 11.5h6V16"/></svg></div><div class="k">总 Tunnel</div><div class="v" id="s_all">-</div></div>
          <div class="stat on"><div class="ic up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div class="k">在线 Tunnel</div><div class="v" id="s_on">-</div></div>
          <div class="stat off"><div class="ic down"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5"/><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"/></svg></div><div class="k">离线 Tunnel</div><div class="v" id="s_off">-</div></div>
          <div class="stat acc"><div class="ic acc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14.5 14.5 0 0 1 0 18M12 3a14.5 14.5 0 0 0 0 18"/></svg></div><div class="k">账户总数</div><div class="v" id="s_acc">-</div></div>
        </div>
        <div class="dash-cols">
          <div class="card" style="margin-bottom:0">
            <h3><span>隧道状态</span><span class="pill" id="alert_state">-</span></h3>
            <div id="dash" class="scroll-y"><div class="empty">加载中...</div></div>
          </div>
          <div class="dash-right">
            <div class="card" style="margin-bottom:14px">
              <h3><span>域名分布</span></h3>
              <div class="hint">按账户统计托管域名</div>
              <div id="zdist"><div class="empty">加载中...</div></div>
            </div>
            <div class="card actcard" style="margin-bottom:0">
              <h3><span>最近活动</span></h3>
              <div id="acts"><div class="empty">加载中...</div></div>
            </div>
          </div>
        </div>
        <div class="ghlink"><a href="https://github.com/eooce/cloudflare-tunnel-panel" target="_blank" rel="noopener noreferrer">${CF_LOGO} Cloudflare Tunnel Panel</a></div>
      </section>

      <section class="view" id="v-tunnels">
        <div class="toolbar">
          <div class="search">
            <span class="si"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg></span>
            <input id="q" placeholder="搜索隧道名称 / ID / 域名" autocomplete="off">
            <button class="qx" id="qclear" type="button" title="清空搜索">✕</button>
          </div>
          <button class="btn" id="newbtn"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>新建隧道</button>
        </div>
        <div class="card">
          <h3><span>隧道列表</span><span class="hint" id="sum" style="margin:0"></span></h3>
          <div id="list"><div class="empty">加载中...</div></div>
        </div>
      </section>

      <section class="view" id="v-tg">
        <div class="card">
          <h3><span>Telegram 提醒</span><span class="pill" id="tg_state">-</span></h3>
          <div class="row" style="align-items:flex-end">
            <div style="flex:1;min-width:0">
              <label for="tg_chat">接收者 chat_id</label>
              <input id="tg_chat" placeholder="正数 ID 或 -100xxx" autocapitalize="off" autocomplete="off">
            </div>
            <div style="flex:2;min-width:0">
              <label for="tg_token">Bot Token</label>
              <input id="tg_token" placeholder="例如 123456789:AbCdefGhIJKlmNoPQRsTUVwxyZ" autocapitalize="off" autocomplete="off" spellcheck="false">
            </div>
            <button class="btn" id="tg_save" style="flex:none;padding:11px 18px;white-space:nowrap">保存推送配置</button>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="btn gray" id="tg_test" style="flex:none;width:76px">测试发送</button>
            <button class="btn gray" id="tg_pause" style="flex:none;width:96px"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg> 暂停推送</button>
          </div>
          <div class="hint" style="margin-top:10px">chat_id 是<strong>接收者</strong>的 ID, 不是机器人的: 想私聊收提醒, 先在 Telegram 里给机器人发一句 /start, 再填<strong>你自己的正数数字 ID</strong> (不知道自己的 ID 可问 @userinfobot); 想发到群组/频道, 填负数 ID (群组需先把机器人拉进群) 或 @公开用户名。填写后点"保存推送配置"写入存储; "测试发送"优先用当前填写的配置, 留空则用已保存的配置发送。暂停推送期间状态仍会检查, 只是不发送消息。</div>
          <div id="tg_list" style="margin-top:10px"></div>
        </div>

        <div class="card">
          <h3>提醒规则</h3>
          <div class="hint">
            1. 每个隧道可在"Tunnel 管理"里单独开关上线/离线提醒, <strong>默认关闭</strong>, 需手动开启。<br>
            2. 只在隧道状态<strong>发生变化</strong>时提醒 (上线一次、离线一次), 同一状态不会重复提醒。<br>
            3. 首次记录到的隧道只保存状态不发送提醒, 部署后不会刷屏。<br>
            4. 打开面板或点刷新时会检查一次; 若要无人值守也持续检查, 给 Worker 加一个 Cron 触发器
            (例如 <code>*/5 * * * *</code>), 代码里的 <code>scheduled</code> 处理会自动执行同样的检查。<br>
            5. Bot Token / 接收者 / 暂停状态都保存在 D1 (TUNNEL_DB) 或 KV (TUNNEL_STATE);
            也可用环境变量 <code>TG_BOT_TOKEN</code> 作为兜底 Token。<br>
            6. 暂停推送期间状态仍照常检查和记录, 只是暂时不发送 Telegram 消息。
          </div>
        </div>
      </section>

    </div></div>
  </div>
</div>

<div id="toast"><span class="ti" id="toast_i">✔</span><span id="toast_m"></span></div>
<div class="busy" id="busy"><div class="box"><span class="spin"></span><span id="busyt">处理中...</span></div></div>
<div class="mask" id="e_mask"></div>

<div class="modal" id="mCreate">
  <h3><span>新建隧道</span><button class="x" id="m_x">✕</button></h3>
  <div class="hint">填写后点"创建隧道", 创建完成会立即显示 Token</div>
  <label>隧道名称</label>
  <input id="name" placeholder="建议填写平台的名称, 例如：aws-jp" autocomplete="off">
  <label>公开域名</label>
  <div class="row">
    <input id="sub" class="sub" placeholder="子域名(留空将使用主域名)" autocapitalize="off" autocomplete="off">
    <select id="zone" class="zone"><option>加载中...</option></select>
  </div>
  <label>路径(可选)</label>
  <input id="path" placeholder="例如 /api 或 ^/ws,留空匹配全部" autocapitalize="off" autocomplete="off">
  <label>本地服务地址( tcp://localhost:3389  http://localhost:8080 )</label>
  <input id="svc" placeholder="http://localhost:8001" autocapitalize="off" autocomplete="off">
  <div class="preview" id="pv"></div>
  <div class="btns"><button class="btn gray" id="m_cancel">取消</button><button class="btn" id="go">创建隧道</button></div>
</div>

<div class="modal" id="mToken">
  <h3><span>Token</span><button class="x" id="t_x">✕</button></h3>
  <div id="t_banner"></div>
  <div id="t_body"><div class="empty">加载中...</div></div>
</div>

<div class="modal" id="mEdit">
  <h3><span>编辑隧道</span><button class="x" id="e_x">✕</button></h3>
  <div id="e_note" class="hint"></div>
  <label>隧道名称</label>
  <input id="e_name" autocomplete="off">
  <div id="e_pick_wrap" style="display:none">
    <label>正在编辑的路由</label>
    <select id="e_pick"></select>
  </div>
  <label>公开域名</label>
  <div class="row">
    <input id="e_sub" class="sub" placeholder="子域名(可空)" autocapitalize="off" autocomplete="off">
    <select id="e_zone" class="zone"></select>
  </div>
  <label>路径(可选)</label>
  <input id="e_path" placeholder="例如 /api 或 ^/ws,留空匹配全部" autocapitalize="off" autocomplete="off">
  <label>本地服务地址( tcp://localhost:3389  http://localhost:8080 )</label>
  <input id="e_svc" placeholder="http://localhost:8001" autocapitalize="off" autocomplete="off">
  <div class="preview" id="e_pv"></div>
  <div class="btns"><button class="btn gray" id="e_cancel">取消</button><button class="btn" id="e_save">保存</button></div>
</div>

<div class="modal" id="mAccMgr">
  <h3><span>账号管理</span><button class="x" id="am_x">✕</button></h3>
  <div id="am_body"></div>
  <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:14px">
    <div class="row amrow">
      <div style="flex:1;min-width:0"><label>账号名称 <span class="amhint">(邮箱/中英文/数字)</span></label><input id="am_name" placeholder="例如 admin@x.com / 主账号" autocomplete="off"></div>
      <div style="flex:1.2;min-width:0"><label>账户 ID (32 位)</label><input id="am_acc" placeholder="Cloudflare 账户 ID" autocapitalize="off" autocomplete="off" spellcheck="false"></div>
    </div>
    <label>该账户的 API Token (权限同环境变量要求)</label>
    <input id="am_token" placeholder="粘贴后点添加, 会先验证再保存" autocapitalize="off" autocomplete="off" spellcheck="false">
    <div class="btns" style="margin-top:12px"><button class="btn" id="am_add">添加账号</button></div>
    <div class="hint" style="margin-top:8px">验证通过才保存; Token 只存在D1, 不会下发到页面。环境变量配置的"默认账号"不可删除。切换账号后隧道列表/提醒规则/域名随账号切换。</div>
  </div>
</div>

<div class="mask" id="c_mask"></div>
<div class="modal confirm" id="mConfirm" data-confirm="1">
  <h3><span class="wi">⚠</span><span id="c_ttl">确认操作</span></h3>
  <p id="c_msg"></p>
  <div class="btns"><button class="btn gray" id="c_no">取消</button><button class="btn red-solid danger" id="c_yes">确定</button></div>
</div>

<div class="modal" id="mRoutes">
  <h3><span>路由管理 · <span id="r_name"></span></span><button class="x" id="r_x">✕</button></h3>
  <div class="hint">同一条隧道可以绑定多个域名/路径, 每个路由指向一个本地服务。新增路由会自动创建对应的 DNS CNAME。</div>
  <div id="r_list" class="rtable"><div class="empty">加载中...</div></div>
  <div style="border-top:1px solid var(--line);margin-top:12px;padding-top:4px">
    <div class="hint" style="margin-top:8px;font-weight:600;color:var(--text)">新增路由</div>
    <label>公开域名</label>
    <div class="row">
      <input id="r_sub" class="sub" placeholder="子域名(可空)" autocapitalize="off" autocomplete="off">
      <select id="r_zone" class="zone"></select>
    </div>
    <label>路径(可选)</label>
    <input id="r_path" placeholder="留空匹配全部" autocapitalize="off" autocomplete="off">
    <label>本地服务地址( tcp://localhost:3389  http://localhost:8080 )</label>
    <input id="r_svc" placeholder="http://localhost:8001" autocapitalize="off" autocomplete="off">
    <div class="preview" id="r_pv"></div>
    <div class="btns"><button class="btn gray" id="r_cancel">关闭</button><button class="btn" id="r_add">＋ 添加路由</button></div>
  </div>
</div>

<script>
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
var ttm;
var TIK_OK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5L20 6.5"/></svg>';
var TIK_ERR='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
function toast(msg,type){
  var t=$('toast'),ok=type!=='err',cls=ok?'ok':'err';
  $('toast_i').innerHTML=ok?TIK_OK:TIK_ERR;
  $('toast_m').textContent=msg;
  clearTimeout(ttm);
  t.className=cls;
  void t.offsetWidth;
  t.className=cls+' show';
  ttm=setTimeout(function(){t.className=cls},2600);
}
function fail(e){toast((e&&e.message)||'操作失败','err')}
function setBusy(on,msg){
  if(on&&document.activeElement&&document.activeElement.blur)document.activeElement.blur();
  $('busyt').textContent=msg||'处理中...';
  $('busy').className=on?'busy show':'busy';
}
async function api(path,extra){
  var r,d;
  // 自动携带当前所选账号 (/api/acc 自身除外, 避免循环依赖)
  var body=extra||{};
  if(path!=='/api/acc'&&curAcc)body.acc=curAcc;
  try{r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
  catch(e){throw new Error('网络请求失败, 请检查网络后重试')}
  try{d=await r.json()}catch(e){throw new Error('服务返回异常 (HTTP '+r.status+')')}
  if(r.status===401){location.replace('/');throw new Error('登录已过期')}
  if(!r.ok)throw new Error(d.error||'请求失败');
  return d;
}
function copy(text){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){toast('已复制')},function(){fb(text)});
  }else fb(text);
}
function fb(text){
  var a=document.createElement('textarea');a.value=text;document.body.appendChild(a);a.select();
  try{document.execCommand('copy');toast('已复制')}catch(e){toast('复制失败, 请手动长按复制','err')}
  document.body.removeChild(a);
}
function codeBox(title,text,extra){
  return '<div class="tit"><span>'+esc(title)+'</span>'+(extra||'')+'</div>'+
    '<div class="code"><span class="hintcp">⧉ 点击复制</span><pre data-copy="'+esc(text)+'">'+esc(text)+'</pre></div>';
}
var REFRESH_SVG='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
function cmds(t,id,name){
  return codeBox('Token',t,id?'<button class="btn sm" data-act="tkrotate" data-id="'+esc(id)+'" data-name="'+esc(name||'')+'" title="轮换后旧 Token 立即失效">'+REFRESH_SVG+'<span class="btxt">刷新Token</span></button>':'')+
         codeBox('Linux 运行','cloudflared tunnel run --token '+t)+
         codeBox('Docker 运行','docker run -d --restart always --network host cloudflare/cloudflared:latest tunnel --no-autoupdate run --token '+t);
}
// 域名栏只显示主机名, 不带 https://
function hostLine(r){
  if(!r){
    return esc('(未配置公开域名)');
  }
  return '<b>'+esc(r.hostname)+'</b>'+(r.path?' · 路径 '+esc(r.path):'')+' → '+esc(r.service||'(未填写本地服务)');
}

/* ---- 弹窗 ---- */
function openModal(id){
  $('e_mask').className='mask show';
  document.querySelectorAll('.modal').forEach(function(m){m.className=m.dataset.confirm?'modal confirm':'modal'});
  $(id).className=$(id).dataset.confirm?'modal confirm show':'modal show';
}
function closeModal(){
  $('e_mask').className='mask';
  document.querySelectorAll('.modal').forEach(function(m){m.className='modal'});
}
$('e_mask').onclick=closeModal;

/* ---- 自定义确认框 (居中偏上, Promise 风格) ---- */
var cResolve=null;
function askConfirm(msg,title,yesText){
  $('c_ttl').textContent=title||'确认操作';
  $('c_msg').innerHTML=esc(msg).replace(/\\n/g,'<br>');
  $('c_yes').textContent=yesText||'确定';
  openModal('mConfirm');
  $('c_yes').className='btn red-solid danger';
  return new Promise(function(res){cResolve=res});
}
function settleConfirm(v){
  if(cResolve){var r=cResolve;cResolve=null;r(v)}
  closeModal();
}
$('c_yes').onclick=function(){settleConfirm(true)};
$('c_no').onclick=function(){settleConfirm(false)};
$('c_mask').onclick=function(){settleConfirm(false)};
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&cResolve)settleConfirm(false);
  if(e.key==='Enter'&&cResolve){e.preventDefault();settleConfirm(true)}
});

/* ---- 菜单 ---- */
/* ---- 多账号 ---- */
var curAcc='',accNames={},envAccId='',defaultSvc='';
function renderAccSel(d){
  // d: /api/acc list 的返回 {accounts:[{name,acc,builtin}], cur}
  if(d&&d.cur)curAcc=d.cur;
  var list=(d&&d.accounts)||[];
  list.forEach(function(a){accNames[a.acc]=a.name});
  $('acc_sel').innerHTML=list.map(function(a){
    return '<option value="'+esc(a.acc)+'"'+(a.acc===curAcc?' selected':'')+'>'+esc(a.name)+'</option>';
  }).join('');
}
async function loadAccs(){
  try{
    renderAccSel(await api('/api/acc',{action:'list'}));
  }catch(e){
    // 兜底: 接口失败 (旧版本后端/临时故障) 时至少显示环境变量默认账号, 不显示"加载失败"
    if(envAccId){
      curAcc=envAccId;accNames[envAccId]='默认账号';
      $('acc_sel').innerHTML='<option value="'+esc(envAccId)+'" selected>默认账号</option>';
    }else $('acc_sel').innerHTML='<option value="">默认账号</option>';
  }
}
$('acc_sel').addEventListener('change',async function(){
  var v=this.value;
  // 遮罩只盖住切换+列表首屏; 路由详情照旧后台渐进加载, 不拖住遮罩
  setBusy(true,'账号切换中...');
  try{
    try{await api('/api/acc',{action:'switch',acc:v})}catch(e){}
    curAcc=v;renderAccSel({accounts:Object.keys(accNames).map(function(k){return {name:accNames[k],acc:k}}),cur:v});
    metaCache={}; // 新账号路由缓存清空
    await Promise.all([loadList(),initZones()]); // 列表 + 域名下拉都随账号刷新
  }finally{setBusy(false)}
  loadTg();
  loadMeta();
});
$('acc_mgr').onclick=function(){openAccMgr()};
// 账号管理弹窗列表渲染 (含编辑按钮); items: [{name,acc,builtin}]
function amRender(items){
  accNames={};
  $('am_body').innerHTML=items.map(function(a){
    accNames[a.acc]=a.name;
    return '<div class="am-item"><div style="min-width:0"><b>'+esc(a.name)+'</b>'+
      '<div style="font-size:11px;color:var(--sub)">'+esc(a.acc)+(a.builtin?' · 环境变量配置':'')+'</div></div>'+
      (a.builtin?'':'<div style="display:flex;gap:6px;flex:none">'+
        '<button class="btn sm" data-amedit="'+esc(a.acc)+'" data-amname="'+esc(a.name)+'">编辑</button>'+
        '<button class="btn sm red" data-amdel="'+esc(a.acc)+'">删除</button></div>')+
      '</div>';
  }).join('')||'<div class="empty">暂无添加的账号</div>';
}
// 点"编辑"在该账号卡片下展开内联编辑表单; 留空的字段保持原值不变
document.addEventListener('click',function(e){
  var t=e.target.closest('[data-amedit]');if(!t)return;
  document.querySelectorAll('.am-edit').forEach(function(x){x.remove()}); // 同时只展开一个
  var acc=t.dataset.amedit,orig=t.dataset.amname;
  var div=document.createElement('div');
  div.className='am-edit';
  div.innerHTML=
    '<label style="margin-top:10px">账号名称 (留空保持不变)</label>'+
    '<input id="ame_name" placeholder="当前: '+esc(orig)+'" autocomplete="off">'+
    '<label>账户 ID (留空保持不变)</label>'+
    '<input id="ame_acc" placeholder="当前: '+esc(acc)+'" autocapitalize="off" autocomplete="off" spellcheck="false">'+
    '<label>API Token (留空保持不变; 换新 Token 会先验证)</label>'+
    '<input id="ame_token" placeholder="粘贴新 Token" autocapitalize="off" autocomplete="off" spellcheck="false">'+
    '<div style="display:flex;gap:8px;margin-top:10px">'+
      '<button class="btn gray" id="ame_cancel" style="flex:1">取消</button>'+
      '<button class="btn" id="ame_save" style="flex:1">保存</button>'+
    '</div>';
  t.closest('.am-item').after(div);
  $('ame_cancel').onclick=function(){div.remove()};
  $('ame_save').onclick=async function(){
    var sb=this;
    sb.disabled=true;sb.innerHTML='<span class="spin"></span> 保存中';
    try{
      var d=await api('/api/acc',{action:'edit',acc:acc,
        name:$('ame_name').value.trim(),newAcc:$('ame_acc').value.trim(),token:$('ame_token').value.trim()});
      toast('账号已更新');
      amRender(d.accounts||[]);
      renderAccSel({accounts:d.accounts||[],cur:curAcc});
    }catch(e){fail(e)}
    sb.disabled=false;sb.innerHTML='保存';
  };
});
async function openAccMgr(){
  var b=$('am_body');
  b.innerHTML='<div class="empty">加载中...</div>';
  openModal('mAccMgr');
  try{
    var d=await api('/api/acc',{action:'list'});
    amRender(d.accounts||[]);
  }catch(e){b.innerHTML='<div class="empty">加载失败</div>';fail(e)}
}
$('am_add').onclick=async function(){
  var b=this,name=$('am_name').value.trim(),acc=$('am_acc').value.trim(),token=$('am_token').value.trim();
  if(!name||!acc||!token){toast('请填写名称、账户 ID 和 API Token','err');return}
  b.disabled=true;b.innerHTML='<span class="spin"></span> 验证中';
  try{
    var d=await api('/api/acc',{action:'add',name:name,acc:acc,token:token});
    $('am_name').value='';$('am_acc').value='';$('am_token').value='';
    toast('账号已添加: '+name);
    amRender(d.accounts||[]);
    renderAccSel({accounts:d.accounts||[],cur:curAcc});
  }catch(e){fail(e)}
  b.disabled=false;b.innerHTML='添加账号';
};
document.addEventListener('click',async function(e){
  var t=e.target.closest('[data-amdel]');if(!t)return;
  if(!(await askConfirm('删除该账号? 仅移出面板, 不影响 Cloudflare 账户本身','删除账号','删除')))return;
  try{
    var d=await api('/api/acc',{action:'del',acc:t.dataset.amdel});
    toast('已删除');
    var items=d.accounts||[];
    amRender(items);
    // 删除的是当前账号 (或其已不存在) → 自动切回默认账号 (env 账号), 重新加载列表/域名/提醒
    if(curAcc===t.dataset.amdel||!items.some(function(a){return a.acc===curAcc})){
      var fallback=items.find(function(a){return a.builtin})||items[0];
      if(fallback){
        curAcc=fallback.acc;
        try{await api('/api/acc',{action:'switch',acc:curAcc})}catch(e2){}
        renderAccSel({accounts:items,cur:curAcc});
        setBusy(true,'账号切换中...');
        try{metaCache={};await Promise.all([loadList(),initZones()])}finally{setBusy(false)}
        loadTg();loadMeta();
      }
    }else{
      renderAccSel({accounts:items,cur:curAcc});
    }
  }catch(e){fail(e)}
});
var curView='dash';
function applyFit(){
  // 仪表板在 PC 上占满视口 (卡片内部滚动, 整页不滚动); 手机保持整页滚动
  var fit=curView==='dash'&&(!window.matchMedia||matchMedia('(min-width:761px)').matches);
  $('content').className='content'+(fit?' fit':'');
}
function show(v){
  curView=v;
  document.querySelectorAll('.nav a').forEach(function(a){a.className=a.dataset.v===v?'on':''});
  document.querySelectorAll('.view').forEach(function(s){s.className='view'+(s.id==='v-'+v?' on':'')});
  $('ttl').textContent=({dash:'仪表板',tunnels:'Tunnel 管理',tg:'Telegram 配置'})[v]||'';
  $('sidenav').className='sidenav';
  applyFit();
}
window.addEventListener('resize',applyFit);
document.querySelectorAll('.nav a').forEach(function(a){a.onclick=function(){show(a.dataset.v)}});
$('brandHome').onclick=function(){show('dash');location.hash=''};
$('menu').onclick=function(){$('sidenav').className='sidenav open'};
$('logout').onclick=async function(e){
  e.preventDefault();
  try{await fetch('/api/logout',{method:'POST'})}catch(err){}
  location.replace('/');
};
document.querySelectorAll('.view').forEach(function(s){s.addEventListener('click',function(){$('sidenav').className='sidenav'})});

/* ---- 仪表板 ---- */
var stText={healthy:'在线',degraded:'降级',down:'离线',inactive:'未启用'};
function durShort(ms){
  var m=Math.floor(ms/60000);
  if(m<1)return '<1m';
  if(m<60)return m+'m';
  var h=Math.floor(m/60);
  if(h<24)return h+'h';
  return Math.floor(h/24)+'d';
}
// 域名分布: SVG 环形图 + 图例 (r=15.9155 使周长=100, 直接按百分比切分)
var DIST_COLORS = ["#f6821f", "#38bdf8", "#22c55e", "#8b5cf6", "#ec4899", "#eab308", "#14b8a6", "#f472b6"];
function renderDist(dist){
  var box=$('zdist');dist=dist||[];
  if(!dist.length){box.innerHTML='<div class="empty">暂无域名数据</div>';return}
  var total=dist.reduce(function(s,x){return s+(x.n||0)},0);
  if(!total){box.innerHTML='<div class="empty">各账户暂无托管域名</div>';return}
  var off=25,segs='';
  dist.forEach(function(x,i){
    if(!x.n)return;
    var pct=(x.n/total)*100,seg=Math.max(pct-0.8,0.4);
    segs+='<circle cx="21" cy="21" r="15.9155" fill="none" stroke="'+DIST_COLORS[i%DIST_COLORS.length]+'" stroke-width="5" stroke-dasharray="'+seg+' '+(100-seg)+'" stroke-dashoffset="'+off+'"/>';
    off-=pct;
  });
  box.innerHTML='<div class="dwrap"><svg class="donut" viewBox="0 0 42 42">'+segs+
    '<text x="21" y="20.5" class="dnum">'+total+'</text><text x="21" y="26.8" class="dlab">个域名</text></svg>'+
    '<div class="dlegend">'+dist.map(function(x,i){
      return '<div class="dli"><span class="dd" style="background:'+DIST_COLORS[i%DIST_COLORS.length]+'"></span>'+
        '<span class="dn" title="'+esc(x.name)+'">'+esc(x.name)+'</span><b>'+(x.n||0)+'</b></div>';
    }).join('')+'</div></div>';
}
function actTime(ms){
  var d=new Date(ms),z=function(n){return String(n).length<2?'0'+n:n};
  return z(d.getMonth()+1)+'-'+z(d.getDate())+' '+z(d.getHours())+':'+z(d.getMinutes());
}
function renderAct(list){
  var box=$('acts');list=list||[];
  if(!list.length){box.innerHTML='<div class="empty">暂无活动记录<br><span style="font-size:11.5px">创建/删除隧道、隧道上下线会显示在这里</span></div>';return}
  var K={add:['创建','var(--ok)'],del:['删除','var(--bad)'],off:['离线','var(--bad)'],on:['恢复在线','var(--ok)']};
  box.innerHTML=list.slice(0,4).map(function(a){
    var k=K[a.k]||['事件','var(--sub)'];
    return '<div class="act"><span class="ad" style="background:'+k[1]+'"></span>'+
      '<div class="at">'+k[0]+'隧道 <b>'+esc(a.n)+'</b>'+(a.d?'<span class="as">'+esc(a.d)+'</span>':'')+'</div>'+
      '<span class="az">'+actTime(a.t)+'</span></div>';
  }).join('');
}
function renderDash(d){
  $('s_on').textContent=d.online;$('s_off').textContent=d.offline;$('s_all').textContent=d.total;
  $('s_acc').textContent=Math.max(1,Object.keys(accNames).length); // 账户总数 (loadAccs 已填充)
  renderAct(d.activity);
  var pill=$('alert_state');
  if(!d.kv){pill.className='pill warn';pill.textContent='未绑定 KV: 仅查看状态'}
  else if(d.alert&&d.alert.error){pill.className='pill warn';pill.textContent='提醒异常: '+d.alert.error}
  else{pill.className='pill on';pill.textContent='提醒已启用'}
  var box=$('dash');
  if(!d.tunnels||!d.tunnels.length){box.innerHTML='<div class="empty">暂无隧道</div>';return}
  box.innerHTML=d.tunnels.map(function(t){
    return '<div class="item"><div class="top"><span class="dot '+esc(t.status)+'"></span>'+
      '<span class="nm">'+esc(t.name)+'</span>'+
      '<span class="badge '+esc(t.status)+'">'+esc(stText[t.status]||t.status)+'</span></div>'+
      '<div class="id">'+esc(t.id)+'</div></div>';
  }).join('');
}

/* ---- 隧道列表 + 搜索 ---- */
var allTunnels=[],allAlertOn={},metaCache={},upTs={};
function setSum(d){
  $('sum').innerHTML='共 <b>'+d.total+'</b> · 在线 <b>'+d.online+'</b> · 离线 <b>'+d.offline+'</b>';
}
function filtered(){
  var q=$('q').value.trim().toLowerCase();
  if(!q)return allTunnels;
  return allTunnels.filter(function(t){
    var m=metaCache[t.id]||{};
    return (t.name+' '+t.id+' '+(m.hostname||'')).toLowerCase().indexOf(q)>=0;
  });
}
function renderList(){
  var l=$('list'),arr=filtered();
  if(!allTunnels.length){l.innerHTML='<div class="empty">暂无隧道, 点右上角"新建隧道"创建</div>';return}
  if(!arr.length){l.innerHTML='<div class="empty">没有匹配的隧道</div>';return}
  l.innerHTML=arr.map(function(t){
    var on=allAlertOn[t.id]===true,m=metaCache[t.id]||{};
    // 在线徽章附带运行时长 (随 /api/list 的 conns_active_at 下发, 实时计算)
    var badgeTxt=stText[t.status]||t.status;
    if(t.status==='healthy'&&upTs[t.id])badgeTxt+=' '+durShort(Date.now()-upTs[t.id]);
    var rules=(m.routes&&m.routes.length?m.routes:(m.hostname?[{hostname:m.hostname,path:m.path||'',service:m.service||''}]:[]));
    // routes===null 表示还没拉到或拉取失败, 显示"加载中"而不是误导性的"未配置域名"
    var routeLines=(m.routes===null&&(!rules||!rules.length))
      ?'<span class="rp">路由信息加载中…</span>'
      :(rules.length
        ?rules.map(function(r){return '<b>'+esc(r.hostname)+'</b>'+(r.path?'<span class="rp">'+esc(r.path)+'</span>':'')+(r.service?' → '+esc(r.service):'')}).join('<br>')
        :'<span style="color:var(--warn)">未配置域名</span>');
    var nRoutes=(m.routes===null&&!rules.length)?'…':rules.length;
    return '<div class="item">'+
      '<div class="trow">'+
      '<span class="dot '+esc(t.status)+'"></span>'+
      '<span class="nm" title="'+esc(t.name)+'">'+esc(t.name)+'</span>'+
      '<span class="id" title="'+esc(t.id)+'">'+esc(t.id)+'</span>'+
      '<span class="pill">'+nRoutes+' 条路由</span>'+
      '<div class="acts">'+
      '<button class="btn sm" data-act="tk" data-id="'+esc(t.id)+'" data-name="'+esc(t.name)+'"><span class="bico">🔑</span><span class="btxt">Token</span></button>'+
      '<button class="btn sm" data-act="route" data-id="'+esc(t.id)+'" data-name="'+esc(t.name)+'"><span class="bico">🌐</span><span class="btxt">路由</span></button>'+
      '<button class="btn sm" data-act="edit" data-id="'+esc(t.id)+'" data-name="'+esc(t.name)+'"><span class="bico">✏️</span><span class="btxt">编辑</span></button>'+
      '<button class="btn sm" data-act="alert" data-id="'+esc(t.id)+'" data-up="'+(t.up?1:0)+'" data-on="'+(on?1:0)+'">'+(on?'🔔':'🔕')+'<span class="btxt">'+(on?'提醒开':'提醒关')+'</span></button>'+
      '<button class="btn sm red" data-act="del" data-id="'+esc(t.id)+'"><span class="bico">🗑</span><span class="btxt">删除</span></button>'+
      '</div>'+
      '<span class="badge '+esc(t.status)+'" style="position:absolute;right:0;top:50%;transform:translateY(-50%)" title="'+(upTs[t.id]?'自 '+new Date(upTs[t.id]).toLocaleString():'')+'">'+esc(badgeTxt)+'</span>'+
      '</div>'+
      '<div class="routes">'+routeLines+'</div></div>';
  }).join('');
}
$('q').addEventListener('input',function(){
  $('q').parentNode.className='search'+($('q').value?' has':'');
  renderList();
});
$('qclear').onclick=function(){
  $('q').value='';$('q').parentNode.className='search';renderList();$('q').focus();
};
$('refresh').onclick=async function(){
  var b=$('refresh');if(b.disabled)return;
  b.disabled=true;b.innerHTML='<span class="spin"></span> 刷新中';
  try{await loadList();await loadMeta();toast('列表已刷新')}catch(e){}
  b.disabled=false;b.innerHTML='刷新';
};
async function loadList(){
  var l=$('list');
  try{
    var d=await api('/api/list');
    allTunnels=d.tunnels||[];allAlertOn=d.alertOn||{};
    upTs={};(d.tunnels||[]).forEach(function(t){if(t.since)upTs[t.id]=t.since});
    setSum(d);renderDash(d);renderList();
  }catch(e){$('sum').innerHTML='';l.innerHTML='<div class="empty">加载失败</div>';fail(e)}
}
async function loadMeta(){
  // 分批串行, 每批 6 个, 避免隧道很多时被 Cloudflare API 限流
  for (var i=0;i<allTunnels.length;i+=6){
    await Promise.all(allTunnels.slice(i,i+6).map(async function(t){
      try{
        var r=await api('/api/detail',{id:t.id});
        metaCache[t.id]={hostname:(r.rules&&r.rules[0]&&r.rules[0].hostname)||'',path:(r.rules&&r.rules[0]&&r.rules[0].path)||'',service:(r.rules&&r.rules[0]&&r.rules[0].service)||r.service||'',routes:r.rules||[]};
      }catch(e){
        // 拉取失败 (限流等): 保留上次结果, 不当作"未配置域名"
        if(!metaCache[t.id])metaCache[t.id]={hostname:'',path:'',service:'',routes:null,unknown:true};
        else metaCache[t.id].unknown=true;
      }
    }));
    renderList();
  }
  // 拉完再整体重绘一次, 清掉 unknown 标记的显示
  setTimeout(renderList,0);
}

document.addEventListener('click',function(e){
  var t=e.target.closest('[data-copy],[data-act]');if(!t)return;
  if(t.dataset.copy!==undefined){copy(t.dataset.copy);return}
  var id=t.dataset.id;
  if(t.dataset.act==='tk')showTk(id,t.dataset.name);
  if(t.dataset.act==='tkrotate')rotateTk(id,t.dataset.name);
  if(t.dataset.act==='route')openRoutes(id,t.dataset.name);
  if(t.dataset.act==='edit')openEdit(id,t.dataset.name);
  if(t.dataset.act==='del')del(id);
  if(t.dataset.act==='alert')toggleAlert(id,t.dataset.on==='1',t.dataset.up==='1');
  if(t.dataset.act==='rmchat')rmChat(t.dataset.chat);
  if(t.dataset.act==='rmdel')rmRoute(t.dataset.host,t.dataset.path);
});

async function toggleAlert(id,on,up){
  try{
    var d=await api('/api/alert',{id:id,action:'toggle',on:!on,up:up});
    allAlertOn[id]=!!d.on;renderList();
    toast(d.on?'已开启该隧道的提醒':'已关闭该隧道的提醒');
  }catch(e){
    if(/KV/.test(e.message))toast('请先绑定 D1 (TUNNEL_DB) 或 KV (TUNNEL_STATE)','err');
    else fail(e);
  }
}

/* ---- 新建隧道 ---- */
function zoneName(){var o=$('zone').options[$('zone').selectedIndex];return o?o.textContent:''}
function preview(){
  var sub=$('sub').value.trim(),z=zoneName().replace(/^\./,''),p=$('path').value.trim(),s=$('svc').value.trim();
  if(!z){$('pv').innerHTML='';return}
  var host=sub?sub+'.'+z:z;
  $('pv').innerHTML='<b>'+esc(host)+'</b>'+(p?' · 路径 '+esc(p):'')+' → '+esc(s||'(未填写本地服务)');
}
['sub','zone','path','svc'].forEach(function(i){$(i).addEventListener('input',preview);$(i).addEventListener('change',preview)});
var subDirty=false;
$('name').addEventListener('input',function(){if(!subDirty){$('sub').value=$('name').value;preview()}});
$('sub').addEventListener('input',function(){var v=$('sub').value;subDirty=v!==''&&v!==$('name').value});

async function initZones(){
  try{
    var d=await api('/api/init');
    if(d.envAcc)envAccId=d.envAcc;
    if(d.dist)renderDist(d.dist);
    if(d.service){defaultSvc=d.service;$('svc').value=d.service;}
    $('zone').innerHTML=d.zones.length?d.zones.map(function(z){return '<option value="'+esc(z.id)+'">.'+esc(z.name)+'</option>'}).join(''):'<option value="">无可用域名</option>';
    preview();
  }catch(e){
    $('zone').innerHTML='<option value="">加载失败</option>';
    fail(e);
  }
}
$('newbtn').onclick=function(){
  openModal('mCreate');
  setTimeout(function(){$('name').focus()},50);
};
$('m_x').onclick=closeModal;$('m_cancel').onclick=closeModal;
$('go').onclick=async function(){
  var b=$('go');
  if(!$('name').value.trim()){toast('请填写隧道名称','err');return}
  if(!$('zone').value){toast('请选择域名','err');return}
  if(!$('svc').value.trim()){toast('请填写本地服务地址','err');return}
  b.disabled=true;b.innerHTML='<span class="spin"></span> 创建中';
  try{
    var d=await api('/api/create',{name:$('name').value.trim(),zoneId:$('zone').value,sub:$('sub').value.trim(),path:$('path').value.trim(),service:$('svc').value.trim()});
    closeModal();
    toast('隧道 '+d.name+' 创建成功');
    // 重置表单
    $('name').value='';$('sub').value='';$('path').value='';$('pv').innerHTML='';subDirty=false;
    loadList().then(loadMeta);
    showToken({name:d.name,id:d.id,hostname:d.hostname,path:d.path||'',service:d.service},d.token,true);
  }catch(e){fail(e)}
  b.disabled=false;b.innerHTML='创建隧道';
};

/* ---- Token 弹窗 ---- */
$('t_x').onclick=closeModal;$('am_x').onclick=closeModal;
var lastTk=null; // 当前 Token 弹窗展示的隧道 (刷新 Token 后原地重绘)
function showToken(r,token,fresh){
  lastTk={r:r,token:token};
  $('t_banner').innerHTML='<div class="banner"><span class="ck">✓</span><div class="bd">'+
    (fresh?'隧道创建成功, 复制下面的域名和Token到服务器运行cloudflared':'隧道: <b>'+esc(r.name||r.id)+'</b>')+
    '</div></div>'+
    // 多路由隧道: 逐条列出全部域名, 每条可单独点击复制 (路径只显示不复制)
    (function(){
      var rules=(r.rules&&r.rules.length?r.rules:(r.hostname?[{hostname:r.hostname,path:r.path||''}]:[]));
      if(!rules.length)return '';
      return '<div class="tit" style="margin-top:2px"><span>域名'+(rules.length>1?' ('+rules.length+' 条)':'')+'</span></div>'+
        rules.map(function(x){
          return '<div class="code"><span class="hintcp">⧉ 点击复制</span><pre style="max-height:none" data-copy="'+esc(x.hostname)+'">'+esc(x.hostname)+(x.path?'<span style="color:#8b93a0"> · '+esc(x.path)+'</span>':'')+'</pre></div>';
        }).join('<div style="height:8px"></div>');
    })();
  $('t_body').innerHTML=cmds(token,r.id,r.name);
  openModal('mToken');
}
async function showTk(id,name){
  openModal('mToken');
  $('t_banner').innerHTML='';
  $('t_body').innerHTML='<div class="empty">加载中...</div>';
  try{
    var res=await Promise.all([api('/api/token',{id:id}),api('/api/detail',{id:id}).catch(function(){return null})]);
    var det=res[1]||{};
    var rules=det.rules||[];
    showToken({name:name,id:id,rules:rules,hostname:rules[0]?rules[0].hostname:'',path:rules[0]?(rules[0].path||''):'',service:det.service||''},res[0].token,false);
  }catch(e){$('t_body').innerHTML='<div class="empty">加载失败</div>';fail(e)}
}
// 刷新 (轮换) 隧道 Token: 旧 Token 立即失效, 弹窗原地重绘为新 Token
async function rotateTk(id,name){
  if(!(await askConfirm('确定刷新该隧道的 Token?\\n旧 Token 将立即失效, 服务器上正在运行的 cloudflared 需改用新 Token 重启。','刷新Token','刷新')))return;
  setBusy(true,'刷新Token中...');
  try{
    var d=await api('/api/token',{id:id,rotate:true,name:name||''});
    if(!d.token)throw new Error('Cloudflare 未返回新 Token');
    if(lastTk&&lastTk.r&&lastTk.r.id===id){lastTk.token=d.token;showToken(lastTk.r,d.token,false);}
    else showTk(id);
    toast('Token 已刷新, 请用新 Token 重启 cloudflared');
  }catch(e){fail(e)}
  setBusy(false);
}
async function del(id){
  if(!(await askConfirm('确定删除该隧道?\\n将同时删除对应的 DNS 记录。','删除隧道','删除')))return;
  setBusy(true,'正在删除tunnel和dns...');
  try{
    var d=await api('/api/delete',{id:id});
    toast(d.dnsFailed?'隧道已删除, 但 DNS 记录清理失败: '+(d.dnsErr||'请到 DNS 页面手动删除'):(d.dns?'已删除隧道和 '+d.dns+' 条 DNS 记录':'已删除隧道'));
    loadList().then(loadMeta);
  }catch(e){fail(e)}
  setBusy(false);
}

/* ---- 编辑 ---- */
var editId=null,editOld='',editRules=[],editSel=0;
function fillEditRule(i){
  editSel=i;var r=editRules[i];if(!r)return;
  if(r.zoneId)$('e_zone').value=r.zoneId;
  $('e_sub').value=r.sub||'';$('e_path').value=r.path||'';$('e_svc').value=r.service||'';
  ePreview();
}
function ePreview(){
  var sub=$('e_sub').value.trim(),o=$('e_zone').options[$('e_zone').selectedIndex],
      z=o?o.textContent.charAt(0)==='.'?o.textContent.slice(1):'':'',p=$('e_path').value.trim(),s=$('e_svc').value.trim();
  if(!z){$('e_pv').innerHTML='';return}
  $('e_pv').innerHTML='<b>'+esc(sub?sub+'.'+z:z)+'</b>'+(p?' · 路径 '+esc(p):'')+' → '+esc(s||'(未填写本地服务)');
}
async function openEdit(id,name){
  editId=id;editOld=name;editRules=[];editSel=0;
  $('e_name').value=name;$('e_sub').value='';$('e_path').value='';$('e_svc').value='';
  $('e_pick').innerHTML='';$('e_pick_wrap').style.display='none';
  $('e_note').innerHTML='读取配置中...';
  $('e_zone').innerHTML=$('zone').innerHTML;
  $('e_save').disabled=true;
  openModal('mEdit');
  try{
    var d=await api('/api/detail',{id:id});
    editRules=d.rules||[];
    var note='';
    if(editRules.length>1){
      // 多条路由: 显示选择器, 表单随选择切换; 单条/无路由保持原表单不变
      $('e_pick').innerHTML=editRules.map(function(r,i){
        return '<option value="'+i+'">'+esc(r.hostname+(r.path?' · '+r.path:''))+(r.service?' → '+esc(r.service):'')+'</option>';
      }).join('');
      $('e_pick_wrap').style.display='';
      fillEditRule(0);
      note='该隧道共有 '+editRules.length+' 条路由, 在"正在编辑的路由"中选择要修改的一条; 保存时其他规则保持不变。';
    }else{
      $('e_sub').value=d.sub;$('e_path').value=d.path;$('e_svc').value=d.service;
      if(d.zoneId)$('e_zone').value=d.zoneId;
      note=d.hostname?'':'该隧道还没有公开域名规则, 保存后将新建。';
      if(d.others)note+=' 另有 '+d.others+' 条其他域名规则, 保存时保持不变。';
    }
    $('e_note').innerHTML=esc(note);
    $('e_save').disabled=false;ePreview();
  }catch(e){$('e_note').innerHTML='';fail(e)}
}
async function saveEdit(){
  var b=$('e_save'),name=$('e_name').value.trim();
  if(!name){toast('请填写隧道名称','err');return}
  if(!$('e_zone').value){toast('请选择域名','err');return}
  if(!$('e_svc').value.trim()){toast('请填写本地服务地址','err');return}
  b.disabled=true;b.innerHTML='<span class="spin"></span> 保存中';
  try{
    var sel=editRules.length>1?editRules[$('e_pick').selectedIndex]:editRules[0];
    var d=await api('/api/update',{id:editId,name:name!==editOld?name:'',zoneId:$('e_zone').value,
      sub:$('e_sub').value.trim(),path:$('e_path').value.trim(),service:$('e_svc').value.trim(),
      host:sel&&sel.hostname||'',oldPath:sel&&sel.path||''});
    closeModal();
    toast(d.dnsFailed?'已保存, 但旧 DNS 记录清理失败: '+(d.dnsErr||'请手动删除'):'修改已保存');
    loadList().then(loadMeta);
  }catch(e){fail(e)}
  b.disabled=false;b.innerHTML='保存';
}
['e_sub','e_zone','e_path','e_svc'].forEach(function(i){$(i).addEventListener('input',ePreview);$(i).addEventListener('change',ePreview)});
$('e_pick').addEventListener('change',function(){fillEditRule(+this.value)});
$('e_x').onclick=closeModal;$('e_cancel').onclick=closeModal;$('e_save').onclick=saveEdit;

/* ---- 路由管理 ---- */
var routeId=null;
function renderRoutes(rules){
  var box=$('r_list');
  if(!rules||!rules.length){box.innerHTML='<div class="empty">还没有路由, 在下面添加第一条</div>';return}
  box.innerHTML=rules.map(function(r){
    return '<div class="rt">'+
      '<div class="rh"><b>'+esc(r.hostname)+'</b>'+(r.path?'<span class="rp">'+esc(r.path)+'</span>':'')+'</div>'+
      '<div class="rs" title="'+esc(r.service)+'">'+esc(r.service)+'</div>'+
      '<button class="btn sm red" data-act="rmdel" data-host="'+esc(r.hostname)+'" data-path="'+esc(r.path||'')+'">删除</button>'+
      '</div>';
  }).join('');
}
function rPreview(){
  var sub=$('r_sub').value.trim(),o=$('r_zone').options[$('r_zone').selectedIndex],
      z=o?o.textContent.charAt(0)==='.'?o.textContent.slice(1):'':'',p=$('r_path').value.trim(),s=$('r_svc').value.trim();
  if(!z){$('r_pv').innerHTML='';return}
  $('r_pv').innerHTML='<b>'+esc(sub?sub+'.'+z:z)+'</b>'+(p?' · 路径 '+esc(p):'')+' → '+esc(s||'(未填写本地服务)');
}
['r_sub','r_zone','r_path','r_svc'].forEach(function(i){$(i).addEventListener('input',rPreview);$(i).addEventListener('change',rPreview)});
async function openRoutes(id,name){
  routeId=id;
  $('r_name').textContent=name||'';
  $('r_sub').value='';$('r_path').value='';$('r_svc').value=defaultSvc;$('r_pv').innerHTML='';
  $('r_zone').innerHTML=$('zone').innerHTML;
  $('r_list').innerHTML='<div class="empty">加载中...</div>';
  openModal('mRoutes');
  rPreview();
  try{
    var d=await api('/api/route',{id:id,action:'list'});
    renderRoutes(d.rules);
  }catch(e){$('r_list').innerHTML='<div class="empty">加载失败</div>';fail(e)}
}
$('r_x').onclick=closeModal;$('r_cancel').onclick=closeModal;
async function rmRoute(host,path){
  if(!(await askConfirm('删除路由 '+host+(path||'')+' ?\\n若没有其他路由使用该域名, 对应的 DNS 记录也会一并删除。','删除路由','删除')))return;
  try{
    var d=await api('/api/route',{id:routeId,action:'del',hostname:host,path:path});
    renderRoutes(d.rules);
    toast(d.dnsFailed?'路由已删除, 但 DNS 清理失败: '+(d.dnsErr||'请手动删除'):'路由已删除');
    loadList().then(loadMeta);
  }catch(e){fail(e)}
}
$('r_add').onclick=async function(){
  var b=this;
  if(!$('r_zone').value){toast('请选择域名','err');return}
  if(!$('r_svc').value.trim()){toast('请填写本地服务地址','err');return}
  b.disabled=true;b.innerHTML='<span class="spin"></span> 添加中';
  try{
    var d=await api('/api/route',{id:routeId,action:'add',zoneId:$('r_zone').value,
      sub:$('r_sub').value.trim(),path:$('r_path').value.trim(),service:$('r_svc').value.trim()});
    renderRoutes(d.rules);
    $('r_sub').value='';$('r_path').value='';$('r_pv').innerHTML='';
    toast('路由已添加, DNS 已同步');
    loadList().then(loadMeta);
  }catch(e){fail(e)}
  b.disabled=false;b.innerHTML='＋ 添加路由';
};

/* ---- Telegram ---- */
var tgSaved=false; // 是否已保存过接收者 (决定"测试发送"能否用已存配置)
function renderTg(d){
  tgSaved=!!(d.chats&&d.chats.length);
  var pill=$('tg_state');
  if(!d.kv){pill.className='pill warn';pill.textContent='未绑定 KV'}
  else if(d.paused){pill.className='pill warn';pill.textContent='推送已暂停'}
  else if(!d.bot&&!d.hasToken){pill.className='pill off';pill.textContent='未配置机器人'}
  else if(!d.targets){pill.className='pill warn';pill.textContent='未添加接收者'}
  else{pill.className='pill on';pill.textContent='已配置 '+d.targets+' 个接收者'}
  // 暂停按钮状态
  var pb=$('tg_pause');
  if(d.paused){pb.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5Z"/></svg> 恢复推送';pb.className='btn green-solid';pb.style.width='96px'}
  else{pb.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg> 暂停推送';pb.className='btn gray';pb.style.width='96px'}
  // 回填已保存的 token (只显示前几位)
  if(d.hasToken&&!$('tg_token').value)$('tg_token').placeholder='已保存: '+(d.tokenMask||'••••')+' (留空则不修改)';
  var box=$('tg_list');
  if(!d.chats||!d.chats.length){box.innerHTML='<div class="empty">还没有接收者, 保存后提醒才会发送</div>';return}
  box.innerHTML=d.chats.map(function(c){
    return '<div class="chat"><div class="ci">✈️</div><div class="cn"><b>'+esc(c.name)+'</b>'+
      '<span>'+esc(c.id?('chat_id: '+c.id):'未解析, 请重新添加')+(c.ok?'':' · 需验证')+'</span></div>'+
      '<button class="btn sm red" data-act="rmchat" data-chat="'+esc(c.name)+'">移除</button></div>';
  }).join('');
}
async function loadTg(){
  try{renderTg(await api('/api/tg',{action:'get'}))}catch(e){fail(e)}
}
function tgInputs(){
  return {chat:$('tg_chat').value.trim(), token:$('tg_token').value.trim()};
}
$('tg_save').onclick=async function(){
  var i=tgInputs();
  if(!i.token&&!$('tg_token').placeholder.indexOf('已保存')===0&&!$('tg_token').value){/*可只改 chat*/}
  var b=this;b.disabled=true;b.innerHTML='<span class="spin"></span> 保存中';
  try{
    var d=await api('/api/tg',{action:'save',chat:i.chat,token:i.token});
    $('tg_token').value='';
    toast('推送配置已保存');
    renderTg(d);loadList().then(loadMeta);
  }catch(e){fail(e)}
  b.disabled=false;b.innerHTML='保存推送配置';
};
$('tg_test').onclick=async function(){
  var i=tgInputs();
  // 输入框为空时, 若已保存过接收者则用已保存配置发送; 否则提示先配置
  if(!i.chat&&!tgSaved){toast('请先填写通知配置','err');return}
  var b=this;b.disabled=true;b.innerHTML='<span class="spin"></span> 发送中';
  try{
    var d=await api('/api/tg',{action:'test',chat:i.chat,token:i.token});
    toast('测试消息已发送');
    renderTg(d);loadList().then(loadMeta);
  }catch(e){fail(e)}
  b.disabled=false;b.innerHTML='测试发送';
};
$('tg_pause').onclick=async function(){
  var paused=$('tg_state').textContent==='推送已暂停';
  var b=this;b.disabled=true;
  try{
    var d;
    if(paused){d=await api('/api/tg',{action:'resume'});toast('已恢复推送')}
    else{d=await api('/api/tg',{action:'pause',minutes:0});toast('已暂停推送')}
    renderTg(d);
  }catch(e){fail(e)}
  b.disabled=false;
};
async function rmChat(chat){
  if(!(await askConfirm('移除接收者 '+chat+' ?','移除接收者','移除')))return;
  try{renderTg(await api('/api/tg',{action:'remove',chat:chat}));toast('已移除接收者')}catch(e){fail(e)}
}

/* ---- 主题切换 ---- */
var ICON_MOON='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>';
var ICON_SUN='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M4.8 4.8l1.6 1.6M17.6 17.6l1.6 1.6M19.2 4.8l-1.6 1.6M6.4 17.6l-1.6 1.6"/></svg>';
function applyTheme(t){
  if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);
  else document.documentElement.removeAttribute('data-theme');
  $('theme').innerHTML=(t==='dark')?ICON_SUN:ICON_MOON; // 当前暗色→点一下变亮色(显示太阳)
}
function toggleTheme(){
  // 未设置过时按当前实际渲染判定 (matchMedia), 切换后写入 localStorage
  var cur=document.documentElement.getAttribute('data-theme')
    ||(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
  var next=cur==='dark'?'light':'dark';
  try{localStorage.setItem('theme',next)}catch(e){}
  applyTheme(next);
}
$('theme').onclick=toggleTheme;
var savedTheme='';
try{savedTheme=localStorage.getItem('theme')||''}catch(e){}
applyTheme(savedTheme);

/* ---- 启动 ---- */
show((location.hash||'').replace('#','')||'dash');
initZones().catch(function(){}).then(loadAccs).then(function(){
  loadList().then(loadMeta);
  loadTg();
});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){});
</script></body></html>`;
