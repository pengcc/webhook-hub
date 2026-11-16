import { describe, expect, it } from 'vitest';
import { retryDelaySeconds } from '../src/backoff.js';

describe('retryDelaySeconds', () => {
  it('grows exponentially, using the lower half of the range at random=0', () => {
    const opts = { baseSeconds: 10, capSeconds: 10_000, random: () => 0 };
    expect(retryDelaySeconds(1, opts)).toBe(5); // 10 / 2
    expect(retryDelaySeconds(2, opts)).toBe(10); // 20 / 2
    expect(retryDelaySeconds(3, opts)).toBe(20); // 40 / 2
  });

  it('reaches the full exponential value as random approaches 1', () => {
    const opts = {
      baseSeconds: 10,
      capSeconds: 10_000,
      random: () => 0.999999,
    };
    expect(retryDelaySeconds(3, opts)).toBeCloseTo(40, 3);
  });

  it('never exceeds the cap', () => {
    const opts = { baseSeconds: 5, capSeconds: 60, random: () => 0.999999 };
    for (let attempt = 1; attempt <= 40; attempt++) {
      expect(retryDelaySeconds(attempt, opts)).toBeLessThanOrEqual(60);
    }
  });

  it('keeps every delay within [exp/2, exp] for random jitter', () => {
    for (let i = 0; i < 200; i++) {
      const delay = retryDelaySeconds(4, { baseSeconds: 5, capSeconds: 3600 });
      expect(delay).toBeGreaterThanOrEqual(20); // exp = 40
      expect(delay).toBeLessThanOrEqual(40);
    }
  });

  it('treats attempt 0 like the first attempt', () => {
    const opts = { baseSeconds: 8, random: () => 0 };
    expect(retryDelaySeconds(0, opts)).toBe(retryDelaySeconds(1, opts));
  });
});
