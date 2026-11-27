function accept<T extends { [K in keyof T as `${Extract<K, string>}y`]: number }>(value: T) {}
const value = { x: 1 };
accept(value);
