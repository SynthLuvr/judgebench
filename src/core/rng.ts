const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Hash a string to [0, 1); stable across processes for the same input, so
 * seeded decisions (e.g. swap order) are reproducible across runs. */
const hash01 = (text: string): number => {
  let h = 2_166_136_261;
  for (const byte of new TextEncoder().encode(text))
    h = Math.imul(h ^ byte, 16_777_619) >>> 0;

  return (h % 1_000_003) / 1_000_003;
};

export { hash01, mulberry32 };
