export class Calculator {
  public add(left: number, right: number): number {
    return left + right;
  }

  public calculateLongSequence(seed: number): number {
    let value = seed;
    value += 1;
    value *= 2;
    value -= 3;
    value += 5;
    value *= 7;
    value -= 11;
    value += 13;
    value *= 17;
    value -= 19;
    value += 23;
    return value;
  }
}

export function item2(): string {
  return 'item2';
}

export function item10(): string {
  return 'item10';
}

export const sampleValue = 42;
