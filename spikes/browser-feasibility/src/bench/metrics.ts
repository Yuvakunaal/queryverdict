// Browser-side measurement helpers. Every number is labelled with its source so results can
// distinguish actual browser measurements, engine-reported statistics and estimates.

export interface BrowserMemorySample {
  source: 'performance.memory (Chromium, non-standard, main-thread JS heap only)';
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function browserMemory(): BrowserMemorySample | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!m) return null;
  return {
    source: 'performance.memory (Chromium, non-standard, main-thread JS heap only)',
    usedJSHeapSize: m.usedJSHeapSize,
    totalJSHeapSize: m.totalJSHeapSize,
    jsHeapSizeLimit: m.jsHeapSizeLimit,
  };
}

export function memoryApiAvailability() {
  return {
    measureUserAgentSpecificMemory: typeof (performance as unknown as { measureUserAgentSpecificMemory?: unknown }).measureUserAgentSpecificMemory === 'function',
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    performanceMemory: browserMemory() !== null,
    deviceMemoryGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
  };
}

/**
 * Main-thread responsiveness monitor: a requestAnimationFrame heartbeat (all browsers) plus
 * Long Task entries where supported (Chromium). Frame gaps measure how long the UI could not paint.
 */
export class ResponsivenessMonitor {
  private last = 0;
  private raf = 0;
  private gaps: number[] = [];
  private longTasks: number[] = [];
  private observer: PerformanceObserver | null = null;

  start() {
    this.gaps = [];
    this.longTasks = [];
    this.last = performance.now();
    const tick = (t: number) => {
      this.gaps.push(t - this.last);
      this.last = t;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      this.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longTasks.push(e.duration);
      });
      this.observer.observe({ type: 'longtask' });
    }
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    this.observer = null;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const pick = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);
    return {
      /** False when no animation frame fired during the workload (too short, or a hidden tab). */
      measured: this.gaps.length > 0,
      frames: this.gaps.length,
      maxFrameGapMs: sorted.length ? sorted[sorted.length - 1]! : null,
      p95FrameGapMs: pick(0.95),
      framesOver100Ms: this.gaps.filter((g) => g > 100).length,
      longTasksSupported: PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false,
      longTaskCount: this.longTasks.length,
      longTaskMaxMs: this.longTasks.length ? Math.max(...this.longTasks) : null,
      note: 'rAF heartbeat in the page. Not measured when the workload ends before the first frame. Headless runs do not establish visible-window interaction latency.',
    };
  }
}
