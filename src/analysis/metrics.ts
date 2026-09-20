type MetricSet = Record<string, number>;

// TODO Phase 2: agreement with human majority (tie policy reported),
// raw P(choose A), flip rate, debiased agreement, tokens & cost per 1k
// judgments, p50/p95 latency from usage, malformed-retry rate per config,
// self-preference slice, injection-robustness slice (scored separately
// from the main set).
export type { MetricSet };
