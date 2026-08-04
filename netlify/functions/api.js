/**
 * 股票监测工作台 - Netlify Function (serverless 版 server.js)
 *
 * 把原 server.js 的 4 个数据源函数 + 6 个 API 路由改写成单一 handler。
 * 前端调用 /api/quote?code=... 等相对路径，netlify.toml 配置 rewrite 到本函数。
 *
 * 数据源：
 *   - K线：新浪财经（money.finance.sina.com.cn）
 *   - 分时：腾讯财经（web.ifzq.gtimg.cn）
 *   - 实时报价：腾讯财经（qt.gtimg.cn，GB18030 编码）
 *   - 股票搜索：东方财富（searchadapter.eastmoney.com）
 */

const https = require('https');

// ====== 数据源封装 ======

function httpsGet(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

// 把 SH600519 / 600519 / 300758 统一转成小写网络代码
function normalizeCode(input) {
  if (!input) return null;
  let code = String(input).trim().toLowerCase();
  code = code.replace(/^(sh|sz|bj)/, '');
  if (!/^\d{6}$/.test(code)) return null;
  const first = code[0];
  let prefix = 'sz';
  if (first === '6' || first === '9') prefix = 'sh';
  else if (first === '4' || first === '8') prefix = 'bj';
  return prefix + code;
}

function toSinaSymbol(code) {
  return normalizeCode(code);
}

// 拉实时报价（腾讯 qt.gtimg.cn）
// 注意：腾讯返回 GBK 编码，需要用 Buffer + TextDecoder 解码
async function fetchQuote(code) {
  const sinaCode = toSinaSymbol(code);
  if (!sinaCode) return { error: 'invalid code' };

  const url = `https://qt.gtimg.cn/q=${sinaCode}`;

  const text = await new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Referer': 'https://gu.qq.com/',
        'User-Agent': 'Mozilla/5.0',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(new TextDecoder('gb18030').decode(buf));
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });

  const match = text.match(/="([^"]+)"/);
  if (!match) return { error: 'empty data', raw: text.slice(0, 200) };

  const parts = match[1].split('~');
  if (parts.length < 50) return { error: 'incomplete data', count: parts.length };

  const name = parts[1];
  const stockCode = parts[2];
  const price = parseFloat(parts[3]) || 0;
  const prevClose = parseFloat(parts[4]) || 0;
  const open = parseFloat(parts[5]) || 0;
  const volumeHand = parseInt(parts[6]) || 0;
  const high = parseFloat(parts[33]) || 0;
  const low = parseFloat(parts[34]) || 0;
  const change = parseFloat(parts[31]) || 0;
  const changePct = parseFloat(parts[32]) || 0;
  const amountWan = parseFloat(parts[37]) || 0;
  const turnoverPct = parseFloat(parts[38]) || 0;
  const pe = parseFloat(parts[39]) || 0;
  const amp = parseFloat(parts[43]) || 0;
  const circMarketCapYi = parseFloat(parts[44]) || 0;
  const totalMarketCapYi = parseFloat(parts[45]) || 0;
  const pb = parseFloat(parts[46]) || 0;
  const limitUp = parseFloat(parts[47]) || 0;
  const limitDown = parseFloat(parts[48]) || 0;
  const time = parts[30] || '';

  if (price <= 0 || prevClose <= 0) {
    return { error: 'invalid price data', raw: parts.slice(0, 10) };
  }

  return {
    code: sinaCode,
    name,
    price,
    prevClose,
    open,
    high,
    low,
    change,
    changePct,
    volume: volumeHand * 100,
    amount: amountWan * 10000,
    turnover: turnoverPct,
    pe,
    pb,
    amplitude: amp,
    circMarketCap: circMarketCapYi,
    totalMarketCap: totalMarketCapYi,
    limitUp,
    limitDown,
    time,
  };
}

// 拉 K线（新浪）
async function fetchKline(code, period = 'day', count = 300) {
  const sinaCode = toSinaSymbol(code);
  if (!sinaCode) return { error: 'invalid code' };

  let scale = 240;
  if (period === '1' || period === 'm1') scale = 1;
  else if (period === '5' || period === '5day' || period === 'm5') scale = 5;
  else if (period === '15' || period === 'm15') scale = 15;
  else if (period === '30' || period === 'm30') scale = 30;
  else if (period === '60' || period === 'm60') scale = 60;
  else if (period === 'day' || period === 'd') scale = 240;
  else if (period === 'week' || period === 'w') scale = 1200;

  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sinaCode}&scale=${scale}&ma=no&datalen=${count}`;

  try {
    const res = await httpsGet(url, {
      'Referer': 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0',
    });

    if (res.status !== 200) return { error: `upstream ${res.status}` };

    let raw;
    try {
      raw = JSON.parse(res.data);
    } catch (e) {
      return { error: 'parse error' };
    }

    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: 'no data' };
    }

    const klines = raw.map(item => ({
      time: item.day,
      date: item.day,
      open: parseFloat(item.open),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      close: parseFloat(item.close),
      volume: parseInt(item.volume) || 0,
    }));

    if (period === 'month' || period === 'm') {
      return { klines: aggregateMonthly(klines), period: 'month' };
    }

    return { klines, period };
  } catch (e) {
    return { error: e.message };
  }
}

function aggregateMonthly(dailyKlines) {
  const monthlyMap = new Map();
  dailyKlines.forEach(k => {
    const month = k.date.substring(0, 7);
    if (!monthlyMap.has(month)) {
      monthlyMap.set(month, {
        time: month + '-01',
        date: month + '-01',
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      });
    } else {
      const m = monthlyMap.get(month);
      m.high = Math.max(m.high, k.high);
      m.low = Math.min(m.low, k.low);
      m.close = k.close;
      m.volume += k.volume;
    }
  });
  return Array.from(monthlyMap.values());
}

// 拉分时数据（腾讯 minute/query）
async function fetchIntraday(code) {
  const sinaCode = toSinaSymbol(code);
  if (!sinaCode) return { error: 'invalid code' };

  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${sinaCode}`;

  try {
    const res = await httpsGet(url, {
      'Referer': 'https://gu.qq.com/',
      'User-Agent': 'Mozilla/5.0',
    });

    if (res.status !== 200) return { error: `upstream ${res.status}` };

    const json = JSON.parse(res.data);
    const stockData = json.data && json.data[sinaCode];
    if (!stockData) return { error: 'no data' };

    const rawData = stockData.data && stockData.data.data;
    if (!Array.isArray(rawData)) return { error: 'no intraday data' };

    let prevVolume = 0;
    let prevAmount = 0;
    const points = rawData.map(item => {
      const parts = item.split(' ');
      const time = parts[0];
      const price = parseFloat(parts[1]);
      const cumVolume = parseInt(parts[2]) || 0;
      const cumAmount = parseFloat(parts[3]) || 0;
      const volume = cumVolume - prevVolume;
      const amount = cumAmount - prevAmount;
      prevVolume = cumVolume;
      prevAmount = cumAmount;
      return { time, price, volume, cumVolume, cumAmount };
    });

    const lastPoint = points[points.length - 1];
    let prevClose = 0;
    if (lastPoint && lastPoint.price > 0) {
      const q = await fetchQuote(code);
      prevClose = q.prevClose || 0;
    }

    return {
      points,
      prevClose,
      lastPrice: lastPoint ? lastPoint.price : 0,
      lastTime: lastPoint ? lastPoint.time : '',
    };
  } catch (e) {
    return { error: e.message };
  }
}

// 股票搜索（东方财富）
async function searchStock(keyword) {
  if (!keyword) return [];
  const encoded = encodeURIComponent(keyword);
  const url = `https://searchadapter.eastmoney.com/api/suggest/get?input=${encoded}&type=14`;

  try {
    const res = await httpsGet(url, {
      'Referer': 'https://www.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0',
    });

    if (res.status !== 200) return [];

    const json = JSON.parse(res.data);
    const data = json.QuotationCodeTable && json.QuotationCodeTable.Data;
    if (!Array.isArray(data)) return [];

    return data.slice(0, 20).map(item => ({
      code: item.Code,
      name: item.Name,
      pinyin: item.PinYin,
      market: item.MktNum === '1' ? 'SH' : (item.MktNum === '0' ? 'SZ' : 'BJ'),
      marketName: item.SecurityTypeName,
      quoteId: item.QuoteID,
    }));
  } catch (e) {
    return [];
  }
}

// ====== Netlify Function handler ======

exports.handler = async (event, context) => {
  const { httpMethod, queryStringParameters: q } = event;
  const path = event.path || '';

  // CORS + 防缓存
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };

  if (httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    let data;

    // 路由匹配：用 path 关键词判断（兼容 /api/quote 和 /.netlify/functions/api/quote）
    // 顺序敏感：batch-quote 必须在 quote 之前匹配
    if (path.includes('batch-quote') || path.includes('batch_quote')) {
      const codes = (q.codes || '').split(',').filter(Boolean);
      const results = await Promise.all(codes.map(c => fetchQuote(c)));
      data = results;
    } else if (path.includes('intraday')) {
      data = await fetchIntraday(q.code);
    } else if (path.includes('kline')) {
      data = await fetchKline(q.code, q.period || 'day', parseInt(q.count) || 300);
    } else if (path.includes('search')) {
      data = await searchStock(q.keyword || q.q || '');
    } else if (path.includes('quote')) {
      data = await fetchQuote(q.code);
    } else if (path.includes('health')) {
      data = { status: 'ok', time: new Date().toISOString(), runtime: 'netlify-function' };
    } else {
      data = {
        name: '股神 API',
        version: '1.0.0',
        endpoints: [
          'GET /api/quote?code=sz301292',
          'GET /api/kline?code=sz301292&period=day&count=300',
          'GET /api/intraday?code=sz301292',
          'GET /api/search?keyword=海科',
          'GET /api/batch-quote?codes=sz301292,sh600519',
          'GET /api/health',
        ],
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
