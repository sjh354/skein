function twice(x: number): number {
  return x * 2;
}

export const first = twice(1);
export const second = twice(first + 1);
