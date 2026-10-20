import { requireSafe } from './errors';

/** Exact base-10 arithmetic. Only digit counts/scales use Number, never financial values. */
export class Decimal {
  private constructor(private readonly units: bigint, private readonly scale: number) {}
  static parse(text: string): Decimal {
    requireSafe(typeof text === 'string' && /^-?(?:0|[1-9][0-9]{0,255})(?:\.[0-9]{1,256})?$/.test(text), 'invalid_decimal', 400);
    const [whole, fraction = ''] = text.split('.');
    return new Decimal(BigInt(whole! + fraction), fraction.length);
  }
  private align(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    return [this.units * 10n ** BigInt(scale - this.scale), other.units * 10n ** BigInt(scale - other.scale), scale];
  }
  add(other: Decimal): Decimal { const [a, b, s] = this.align(other); return new Decimal(a + b, s); }
  sub(other: Decimal): Decimal { const [a, b, s] = this.align(other); return new Decimal(a - b, s); }
  mul(other: Decimal): Decimal { return new Decimal(this.units * other.units, this.scale + other.scale); }
  compare(other: Decimal): number { const [a, b] = this.align(other); return a < b ? -1 : a > b ? 1 : 0; }
  toString(): string {
    const negative = this.units < 0n; let digits = (negative ? -this.units : this.units).toString();
    if (this.scale) {
      digits = digits.padStart(this.scale + 1, '0');
      digits = digits.slice(0, -this.scale) + '.' + digits.slice(-this.scale);
      digits = digits.replace(/0+$/, '').replace(/\.$/, '');
    }
    return (negative ? '-' : '') + digits;
  }
}
export const D = Decimal.parse;
export const ZERO = D('0');
export function nonnegative(text: string): void { requireSafe(D(text).compare(ZERO) >= 0, 'negative_amount', 400); }
export function positive(text: string): void { requireSafe(D(text).compare(ZERO) > 0, 'nonpositive_amount', 400); }
