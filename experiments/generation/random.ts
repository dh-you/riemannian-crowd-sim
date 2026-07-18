/**
 * Repository-owned Mulberry32 PRNG. State and output are unsigned 32-bit values;
 * floating output is exactly uint32 / 2^32 and therefore lies in [0, 1).
 */
export class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new Error("PRNG seed must be a safe integer");
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  floatBetween(minimum: number, maximum: number): number {
    if (![minimum, maximum].every(Number.isFinite) || maximum < minimum) {
      throw new Error("PRNG floating range must be finite and ordered");
    }
    return minimum + (maximum - minimum) * this.nextFloat();
  }

  integerBetween(minimumInclusive: number, maximumExclusive: number): number {
    if (
      !Number.isSafeInteger(minimumInclusive) ||
      !Number.isSafeInteger(maximumExclusive) ||
      maximumExclusive <= minimumInclusive
    ) {
      throw new Error("PRNG integer range must be nonempty safe integers");
    }
    const range = maximumExclusive - minimumInclusive;
    return minimumInclusive + Math.floor(this.nextFloat() * range);
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = this.integerBetween(0, index + 1);
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }
}
