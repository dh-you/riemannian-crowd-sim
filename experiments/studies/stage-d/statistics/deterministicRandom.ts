/** Repository-owned deterministic PRNG for preregistered bootstrap resampling. */
export class DeterministicBootstrapRandom {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new Error("Bootstrap seed must be a safe integer");
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  }

  integer(upperExclusive: number): number {
    if (!Number.isSafeInteger(upperExclusive) || upperExclusive <= 0) {
      throw new Error("Bootstrap integer bound must be positive");
    }
    return Math.floor(this.next() * upperExclusive);
  }
}
