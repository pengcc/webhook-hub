export type BackoffOptions = {
  baseSeconds?: number;
  capSeconds?: number;
  /** Returns a number in [0, 1). Injectable for tests. */
  random?: () => number;
};

/**
 * Delay before the next attempt, in seconds. `attempt` is the number of
 * attempts already made (>= 1). Exponential growth capped at `capSeconds`,
 * with "equal jitter": the result is uniform in [exp/2, exp], so retries
 * spread out but never fire almost immediately.
 */
export function retryDelaySeconds(
  attempt: number,
  {
    baseSeconds = 5,
    capSeconds = 3600,
    random = Math.random,
  }: BackoffOptions = {}
): number {
  const exponent = Math.max(0, attempt - 1);
  const exp = Math.min(capSeconds, baseSeconds * 2 ** exponent);
  return exp / 2 + random() * (exp / 2);
}
