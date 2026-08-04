/**
 * API 客户端 - 调用后端代理服务
 * 后端从新浪/腾讯/东方财富拉真实行情数据
 */

const API = {
  baseUrl: '',  // 同源

  // 统一 fetch 包装
  async get(path) {
    try {
      const res = await fetch(this.baseUrl + path, { cache: 'no-cache' });
      if (!res.ok) {
        return { error: `HTTP ${res.status}` };
      }
      return await res.json();
    } catch (e) {
      return { error: e.message };
    }
  },

  // 实时报价
  async getQuote(code) {
    return await this.get(`/api/quote?code=${encodeURIComponent(code)}`);
  },

  // 批量实时报价
  async getBatchQuote(codes) {
    if (!Array.isArray(codes) || codes.length === 0) return [];
    return await this.get(`/api/batch-quote?codes=${codes.map(encodeURIComponent).join(',')}`);
  },

  // K线数据
  // period: 'day' | '5day' | 'week' | 'month' | '1' | '5' | '15' | '30' | '60'
  async getKline(code, period = 'day', count = 300) {
    return await this.get(`/api/kline?code=${encodeURIComponent(code)}&period=${period}&count=${count}`);
  },

  // 分时数据
  async getIntraday(code) {
    return await this.get(`/api/intraday?code=${encodeURIComponent(code)}`);
  },

  // 股票搜索
  async search(keyword) {
    return await this.get(`/api/search?keyword=${encodeURIComponent(keyword)}`);
  },
};


/**
 * 数据管理 - 缓存 + 转换
 * 把 API 返回的数据转换为图表需要的格式
 */
const DataStore = {
  // 自选股列表（持久化）
  watchlist: [],
  // 股票代码 -> 行情数据
  quotes: {},     // { '301292': { code, name, price, ... } }
  // 当前选中的股票 + 周期
  currentCode: null,
  currentPeriod: 'day',
  // 加载状态
  loading: false,
  // K线缓存
  klineCache: {},  // { '301292_day': [...klines] }

  // 加载自选股（从 localStorage）
  loadWatchlist() {
    try {
      const data = localStorage.getItem('stock_watchlist');
      this.watchlist = data ? JSON.parse(data) : [];
    } catch {
      this.watchlist = [];
    }
  },

  // 保存自选股
  saveWatchlist() {
    try {
      localStorage.setItem('stock_watchlist', JSON.stringify(this.watchlist));
    } catch {}
  },

  // 添加自选股
  addStock(code, name = '') {
    code = String(code).toLowerCase();
    if (this.watchlist.find(s => s.code === code)) return false;
    this.watchlist.push({ code, name });
    this.saveWatchlist();
    return true;
  },

  // 删除自选股
  removeStock(code) {
    this.watchlist = this.watchlist.filter(s => s.code !== code);
    this.saveWatchlist();
    delete this.quotes[code];
  },

  // 获取股票代码（去掉 sh/sz 前缀，返回 6 位数字）
  getStockNumber(code) {
    if (!code) return '';
    return String(code).replace(/^(sh|sz|bj)/, '');
  },

  // 网络代码 -> 显示代码 (sz301292 -> 301292)
  displayCode(code) {
    return this.getStockNumber(code);
  },

  // 显示代码 -> 网络代码
  toNetworkCode(code) {
    if (!code) return null;
    code = String(code).trim().toLowerCase();
    code = code.replace(/^(sh|sz|bj)/, '');
    if (!/^\d{6}$/.test(code)) return null;
    const first = code[0];
    let prefix = 'sz';
    if (first === '6' || first === '9') prefix = 'sh';
    else if (first === '4' || first === '8') prefix = 'bj';
    return prefix + code;
  },

  // 拉取并缓存 K线
  async loadKline(code, period) {
    const cacheKey = `${code}_${period}`;
    const result = await API.getKline(code, period, 300);
    if (result.error || !result.klines) {
      throw new Error(result.error || '拉取K线失败');
    }
    // 转换为统一格式
    const klines = result.klines.map(k => ({
      date: k.date,
      time: k.time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
    }));
    this.klineCache[cacheKey] = klines;
    return klines;
  },

  // 拉取并缓存分时
  async loadIntraday(code) {
    const result = await API.getIntraday(code);
    if (result.error || !result.points) {
      throw new Error(result.error || '拉取分时失败');
    }
    return result;
  },

  // 批量更新自选股报价
  async updateAllQuotes() {
    if (this.watchlist.length === 0) return;
    const codes = this.watchlist.map(s => s.code);
    const results = await API.getBatchQuote(codes);
    if (!Array.isArray(results)) return;
    results.forEach(q => {
      if (q && q.code) {
        // server 返回的 code 可能是纯数字(301292)，统一转成网络代码(sz301292)作为 key
        const netCode = this.toNetworkCode(q.code) || q.code;
        this.quotes[netCode] = q;
        // 同步 name 到 watchlist
        const w = this.watchlist.find(s => s.code === netCode);
        if (w && !w.name) w.name = q.name;
      }
    });
  },

  // 获取单只股票报价（用于新增后立即拉一次）
  async updateQuote(code) {
    const q = await API.getQuote(code);
    if (q && q.code) {
      const netCode = this.toNetworkCode(q.code) || q.code;
      this.quotes[netCode] = q;
      const w = this.watchlist.find(s => s.code === netCode);
      if (w && !w.name) w.name = q.name;
    }
    return q;
  },
};
