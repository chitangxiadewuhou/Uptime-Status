// functions/api/status.js
// EdgeOne 边缘函数：安全代理 UptimeRobot API
// 【安全要点】
// 1. API Key 只从服务端环境变量读取，绝不返回给前端
// 2. 返回给前端的监控数据强制过滤掉 url / host / port / ip 字段
// 3. 带 60 秒缓存，避免频繁请求触发 UptimeRobot 限流

const CACHE_TTL_MS = 60 * 1000; // 60 秒缓存

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// 模块级内存缓存（同一函数实例内有效，跨实例不共享，但足够防止短时间内重复请求）
let _cache = { data: null, ts: 0 };

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`,
      ...extraHeaders,
    },
  });
}

// 【核心安全函数】清洗单个监控项，剔除一切可能泄露源站信息的字段
function sanitizeMonitor(m) {
  return {
    // —— 前端渲染必需的字段，保留 ——
    id: m.id,
    friendly_name: m.friendly_name,
    status: m.status,
    type: m.type,
    interval: m.interval,
    response_times: m.response_times,
    custom_uptime_ratio: m.custom_uptime_ratio,
    create_datetime: m.create_datetime,
    // —— 可能泄露源站的字段，全部清空 ——
    url: '',
    host: '',
    port: '',
    ip: '',
  };
}

async function fetchMonitorsFromUptimeRobot(apiKey) {
  const resp = await fetch('https://api.uptimerobot.com/v2/getMonitors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      api_key: apiKey,
      format: 'json',
      logs: '1',
      response_times: '1',
      custom_uptime_ratios: '1-7-30',
    }).toString(),
  });
  return resp.json();
}

async function fetchMonitorResponseTime(apiKey, monitorId) {
  const data = await fetchMonitorsFromUptimeRobot(apiKey);
  const monitor = data.monitors?.find((m) => String(m.id) === String(monitorId));
  if (!monitor) return { error: 'monitor not found' };
  // response_times 本身不含 IP，可安全返回
  return { response_times: monitor.response_times || [] };
}

export async function onRequest(context) {
  const request = context?.request ?? context;
  const env = context?.env ?? {};

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: '只支持 GET / POST' }, 405);
  }

  try {
    // 【关键】从服务端环境变量读取 API Key，前端永远看不到它
    const apiKey = env.UPTIMEROBOT_API_KEY;
    if (!apiKey) {
      return json({ error: 'UPTIMEROBOT_API_KEY 未在环境变量中配置' }, 500);
    }

    const url = new URL(request.url);
    const monitorId = url.searchParams.get('monitorId');

    if (monitorId) {
      return json({ responseTimeStats: await fetchMonitorResponseTime(apiKey, monitorId) });
    }

    const force = ['1', 'true'].includes(url.searchParams.get('refresh'));
    const now = Date.now();

    // 命中缓存则直接返回
    if (!force && _cache.data && now - _cache.ts < CACHE_TTL_MS) {
      return json(_cache.data);
    }

    const rawData = await fetchMonitorsFromUptimeRobot(apiKey);

    // UptimeRobot 返回失败
    if (rawData.stat === 'fail') {
      return json({ error: rawData.error?.message || 'UptimeRobot API 错误' }, 502);
    }

    // 【核心安全过滤】清洗每一个监控项，剔除 url / host / port / ip
    const sanitized = {
      ...rawData,
      monitors: (rawData.monitors || []).map(sanitizeMonitor),
    };

    _cache = { data: sanitized, ts: now };
    return json(sanitized);
  } catch (e) {
    return json({ error: e.message || '请求失败' }, 500);
  }
}
