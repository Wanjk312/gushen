/**
 * 股票监测工作台 - 后端代理服务器
 *
 * 数据源：
 *   - K线：新浪财经（money.finance.sina.com.cn）
 *   - 分时：腾讯财经（web.ifzq.gtimg.cn）
 *   - 实时报价：腾讯财经（qt.gtimg.cn）
 *   - 股票搜索：东方财富（searchadapter.eastmoney.com）
 *
 * 启动：node server.js
 * 端口：8080
 */

const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');

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
  // 去掉前缀
  code = code.replace(/^(sh|sz|bj)/, '');
  // 6位数字
  if (!/^\d{6}$/.test(code)) return null;
  // 按首位确定市场
  const first = code[0];
  let prefix = 'sz';
  if (first === '6' || first === '9') prefix = 'sh';
  else if (first === '4' || first === '8') prefix = 'bj';
  return prefix + code;
}

// 把网络代码转成新浪 symbol（带 sh/sz 前缀）
function toSinaSymbol(code) {
  const c = normalizeCode(code);
  return c;
}

// 把网络代码转成东方财富 secid
function toEastSecid(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  const prefix = c.slice(0, 2);
  const num = c.slice(2);
  const market = prefix === 'sh' ? '1' : '0';
  return `${market}.${num}`;
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

  // 格式：v_sz301292="51~海科新源~301292~67.26~..."
  const match = text.match(/="([^"]+)"/);
  if (!match) return { error: 'empty data', raw: text.slice(0, 200) };

  const parts = match[1].split('~');
  if (parts.length < 50) return { error: 'incomplete data', count: parts.length };

  // 腾讯字段顺序（基于实际抓取 301292 校对）：
  // 0 标识, 1 名称, 2 代码, 3 当前价, 4 昨收, 5 今开,
  // 6 成交量(手), 7 外盘, 8 内盘, 9-28 买卖五档
  // 30 时间, 31 涨跌额, 32 涨跌幅, 33 最高, 34 最低
  // 35 价格/成交量/成交额, 36 成交量(手), 37 成交额(万)
  // 38 换手率, 39 PE, 40 (空), 41 最高, 42 最低,
  // 43 振幅%, 44 流通市值(亿), 45 总市值(亿), 46 市净率PB
  // 47 涨停价, 48 跌停价
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
  const amp = parseFloat(parts[43]) || 0;  // 振幅%
  const circMarketCapYi = parseFloat(parts[44]) || 0;  // 流通市值(亿)
  const totalMarketCapYi = parseFloat(parts[45]) || 0;  // 总市值(亿)
  const pb = parseFloat(parts[46]) || 0;  // 市净率
  const limitUp = parseFloat(parts[47]) || 0;
  const limitDown = parseFloat(parts[48]) || 0;
  const time = parts[30] || '';

  // 验证关键字段
  if (price <= 0 || prevClose <= 0) {
    return { error: 'invalid price data', raw: parts.slice(0, 10) };
  }

  return {
    code: sinaCode,       // 带前缀的网络代码，如 'sz301292'
    name,
    price,
    prevClose,
    open,
    high,
    low,
    change,
    changePct,
    volume: volumeHand * 100,  // 手 → 股
    amount: amountWan * 10000,  // 万 → 元
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
// period: 1/5/15/30/60 (分钟) | 240 (日) | 1200 (周) | month (用日聚合成月)
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
  // month: 用日K聚合成月K

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

    // 转换为统一格式
    const klines = raw.map(item => ({
      time: item.day,  // "2025-05-13" 或 "2026-07-27 10:15:00"
      date: item.day,
      open: parseFloat(item.open),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      close: parseFloat(item.close),
      volume: parseInt(item.volume) || 0,
    }));

    // 如果是月K，从日K聚合
    if (period === 'month' || period === 'm') {
      return { klines: aggregateMonthly(klines), period: 'month' };
    }

    return { klines, period };
  } catch (e) {
    return { error: e.message };
  }
}

// 把日K聚合成月K
function aggregateMonthly(dailyKlines) {
  const monthlyMap = new Map();
  dailyKlines.forEach(k => {
    const month = k.date.substring(0, 7);  // "2025-05"
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

    // 格式：["0930 65.83 882 5806206.00", ...]
    // 分别：时间 价格 累计成交量(手) 累计成交额(元)
    let prevVolume = 0;
    let prevAmount = 0;
    const points = rawData.map(item => {
      const parts = item.split(' ');
      const time = parts[0];
      const price = parseFloat(parts[1]);
      const cumVolume = parseInt(parts[2]) || 0;
      const cumAmount = parseFloat(parts[3]) || 0;
      // 单根成交量 = 累计差
      const volume = cumVolume - prevVolume;
      const amount = cumAmount - prevAmount;
      prevVolume = cumVolume;
      prevAmount = cumAmount;
      return { time, price, volume, cumVolume, cumAmount };
    });

    // 昨收（从最后根推算或返回）
    const lastPoint = points[points.length - 1];
    let prevClose = 0;
    if (lastPoint && lastPoint.price > 0) {
      // 昨收用 quote 接口再拿一次
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

// ====== HTTP 服务器 ======

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    // API 路由
    if (pathname === '/api/quote') {
      const code = parsed.query.code;
      const data = await fetchQuote(code);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(data));
      return;
    }

    if (pathname === '/api/kline') {
      const code = parsed.query.code;
      const period = parsed.query.period || 'day';
      const count = parseInt(parsed.query.count) || 300;
      const data = await fetchKline(code, period, count);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(data));
      return;
    }

    if (pathname === '/api/intraday') {
      const code = parsed.query.code;
      const data = await fetchIntraday(code);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(data));
      return;
    }

    if (pathname === '/api/search') {
      const keyword = parsed.query.keyword || parsed.query.q || '';
      const data = await searchStock(keyword);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(data));
      return;
    }

    if (pathname === '/api/batch-quote') {
      // 批量拉取报价
      const codes = (parsed.query.codes || '').split(',').filter(Boolean);
      const results = await Promise.all(codes.map(c => fetchQuote(c)));
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(results));
      return;
    }

    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
      return;
    }

    // 静态文件
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    const ext = path.extname(filePath);

    // 安全检查
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found: ' + pathname);
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`[Server] 股票监测工作台已启动`);
  console.log(`[Server] 访问地址: http://localhost:${PORT}`);
  console.log(`[Server] API 路由:`);
  console.log(`  GET /api/quote?code=sz301292`);
  console.log(`  GET /api/kline?code=sz301292&period=day&count=300`);
  console.log(`  GET /api/intraday?code=sz301292`);
  console.log(`  GET /api/search?keyword=海科`);
  console.log(`  GET /api/batch-quote?codes=sz301292,sh600519`);
});
