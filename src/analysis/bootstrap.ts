type BootstrapResult = {
  readonly estimate: number;
  readonly ci95: readonly [number, number];
};

// TODO Phase 2: bootstrap confidence intervals (--bootstrap N, default
// 2000) for every reported metric.
export type { BootstrapResult };
