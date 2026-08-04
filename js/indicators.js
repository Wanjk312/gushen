/**
 * 技术指标计算引擎
 * 返回字段：MA5, MA10, MA20, MA60, MACD: {dif, dea, hist}, BOLL: {upper, mid, lower},
 *         KDJ: {K, D, J}, RSI6/12/24, VOL_MA5
 */
const Indicators = {

  round(v, p = 4) {
    if (v === null || v === undefined || isNaN(v)) return null;
    const m = Math.pow(10, p);
    return Math.round(v * m) / m;
  },

  // 简单移动平均线（用 close）
  MA(data, period) {
    const result = new Array(data.length).fill(null);
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j].close;
      result[i] = sum / period;
    }
    return result;
  },

  // 成交量均线
  VOLMA(data, period) {
    const result = new Array(data.length).fill(null);
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j].volume;
      result[i] = sum / period;
    }
    return result;
  },

  // 指数移动平均线
  EMA(data, period) {
    const result = new Array(data.length).fill(null);
    const k = 2 / (period + 1);
    if (data.length < period) return result;

    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i].close;
    let ema = sum / period;
    result[period - 1] = ema;

    for (let i = period; i < data.length; i++) {
      ema = data[i].close * k + ema * (1 - k);
      result[i] = ema;
    }
    return result;
  },

  // MACD: { dif, dea, hist }
  MACD(data, fast = 12, slow = 26, signal = 9) {
    const emaFast = this.EMA(data, fast);
    const emaSlow = this.EMA(data, slow);
    const dif = new Array(data.length).fill(null);

    for (let i = 0; i < data.length; i++) {
      if (emaFast[i] !== null && emaSlow[i] !== null) {
        dif[i] = emaFast[i] - emaSlow[i];
      }
    }

    // DEA = EMA(DIF, signal)，从第一个有效 DIF 开始
    const dea = new Array(data.length).fill(null);
    const startIdx = dif.findIndex(v => v !== null);
    if (startIdx >= 0 && startIdx + signal <= data.length) {
      const k = 2 / (signal + 1);
      // 初始 SMA
      let sum = 0;
      for (let i = 0; i < signal; i++) sum += dif[startIdx + i];
      let emaVal = sum / signal;
      dea[startIdx + signal - 1] = emaVal;
      for (let i = signal; i + startIdx < data.length; i++) {
        emaVal = dif[startIdx + i] * k + emaVal * (1 - k);
        dea[startIdx + i] = emaVal;
      }
    }

    // MACD 柱 = (DIF - DEA) * 2
    const hist = new Array(data.length).fill(null);
    for (let i = 0; i < data.length; i++) {
      if (dif[i] !== null && dea[i] !== null) {
        hist[i] = (dif[i] - dea[i]) * 2;
      }
    }

    return { dif, dea, hist };
  },

  // RSI
  RSI(data, period = 14) {
    const result = new Array(data.length).fill(null);
    if (data.length < period + 1) return result;

    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
      const change = data[i].close - data[i - 1].close;
      if (change > 0) gainSum += change;
      else lossSum -= change;
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    result[period] = 100 - 100 / (1 + (avgLoss > 0 ? avgGain / avgLoss : 100));

    for (let i = period + 1; i < data.length; i++) {
      const change = data[i].close - data[i - 1].close;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result[i] = avgLoss > 0 ? 100 - 100 / (1 + avgGain / avgLoss) : 100;
    }
    return result;
  },

  // KDJ: { K, D, J }
  KDJ(data, n = 9, m1 = 3, m2 = 3) {
    const K = new Array(data.length).fill(null);
    const D = new Array(data.length).fill(null);
    const J = new Array(data.length).fill(null);

    let prevK = 50, prevD = 50;
    for (let i = 0; i < data.length; i++) {
      if (i < n - 1) continue;
      let high = -Infinity, low = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        if (data[j].high > high) high = data[j].high;
        if (data[j].low < low) low = data[j].low;
      }
      const rsv = high === low ? 50 : (data[i].close - low) / (high - low) * 100;
      const k = (m1 - 1) / m1 * prevK + 1 / m1 * rsv;
      const d = (m2 - 1) / m2 * prevD + 1 / m2 * k;
      const j = 3 * k - 2 * d;
      K[i] = k; D[i] = d; J[i] = j;
      prevK = k; prevD = d;
    }
    return { K, D, J };
  },

  // BOLL: { upper, mid, lower }
  BOLL(data, period = 20, mult = 2) {
    const mid = this.MA(data, period);
    const upper = new Array(data.length).fill(null);
    const lower = new Array(data.length).fill(null);
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += Math.pow(data[i - j].close - mid[i], 2);
      }
      const std = Math.sqrt(sum / period);
      upper[i] = mid[i] + mult * std;
      lower[i] = mid[i] - mult * std;
    }
    return { upper, mid, lower };
  },

  // 计算所有指标
  calculateAll(data) {
    return {
      MA5: this.MA(data, 5),
      MA10: this.MA(data, 10),
      MA20: this.MA(data, 20),
      MA60: this.MA(data, 60),
      MACD: this.MACD(data),
      BOLL: this.BOLL(data),
      KDJ: this.KDJ(data),
      RSI6: this.RSI(data, 6),
      RSI12: this.RSI(data, 12),
      RSI24: this.RSI(data, 24),
      VOL_MA5: this.VOLMA(data, 5),
      VOL_MA10: this.VOLMA(data, 10),
    };
  },
};
