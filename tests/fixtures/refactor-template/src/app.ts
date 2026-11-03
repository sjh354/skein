export function alpha(value: number): number {
  return helper(value) + 1;
}

export function helper(value: number): number {
  return value * 2;
}

export function beta(value: number): number {
  return helper(value);
}
