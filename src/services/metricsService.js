const MAX_SAMPLES  = 1000;
const BUCKET_SIZE  = 60 * 1000;

class MetricsStore {
  constructor() {
    this.requests = [];
    this.buckets  = [];
    this._lastBucket = null;
  }

  record({ path, method, status, duration }) {
    const ts = Date.now();
    this.requests.push({ ts, path, method, status, duration });
    if (this.requests.length > MAX_SAMPLES) this.requests.shift();
    this._updateBuckets(ts, status, duration);
  }

  _updateBuckets(ts, status, duration) {
    const minute = Math.floor(ts / BUCKET_SIZE) * BUCKET_SIZE;
    if (!this._lastBucket || this._lastBucket.minute !== minute) {
      this._lastBucket = { minute, samples: [], errors: 0 };
      this.buckets.push(this._lastBucket);
      if (this.buckets.length > 60) this.buckets.shift();
    }
    this._lastBucket.samples.push(duration);
    if (status >= 400) this._lastBucket.errors++;
  }

  getSummary() {
    if (!this.requests.length) return { total: 0 };
    const recent    = this.requests.filter(r => r.ts > Date.now() - 60_000);
    const durations = recent.map(r => r.duration).sort((a, b) => a - b);
    return {
      total_requests_tracked: this.requests.length,
      last_minute: {
        count:          recent.length,
        avg_ms:         avg(durations),
        p50_ms:         percentile(durations, 50),
        p95_ms:         percentile(durations, 95),
        p99_ms:         percentile(durations, 99),
        errors:         recent.filter(r => r.status >= 400).length,
        error_rate_pct: recent.length ? ((recent.filter(r => r.status >= 400).length / recent.length) * 100).toFixed(1) : 0,
      },
      slowest_endpoints: this._getSlowestEndpoints(),
    };
  }

  getTimeSeries() {
    return this.buckets.map(b => {
      const sorted = [...b.samples].sort((a, c) => a - c);
      return { time: new Date(b.minute).toISOString(), count: b.samples.length, avg_ms: avg(sorted), p95_ms: percentile(sorted, 95), errors: b.errors };
    });
  }

  _getSlowestEndpoints() {
    const byPath = {};
    this.requests.forEach(r => {
      const key = `${r.method} ${r.path.replace(/\/\d+/g, '/:id')}`;
      if (!byPath[key]) byPath[key] = [];
      byPath[key].push(r.duration);
    });
    return Object.entries(byPath)
      .map(([endpoint, times]) => ({ endpoint, calls: times.length, avg_ms: avg(times), p95_ms: percentile([...times].sort((a, b) => a - b), 95) }))
      .sort((a, b) => b.avg_ms - a.avg_ms).slice(0, 10);
  }
}

function avg(arr) { return arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0; }
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]);
}

const metricsStore = new MetricsStore();

function metricsMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    metricsStore.record({ path: req.path, method: req.method, status: res.statusCode, duration: Date.now() - start });
  });
  next();
}

module.exports = { metricsStore, metricsMiddleware };
