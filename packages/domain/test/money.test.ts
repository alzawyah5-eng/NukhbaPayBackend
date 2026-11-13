import assert from "node:assert/strict";
import test from "node:test";
import { parseAed, formatAed, percentageFeeMinor } from "../src/index.ts";

test("decimal input becomes exact minor units without binary floating-point arithmetic", () => {
  assert.equal(parseAed("0.10") + parseAed("0.20"), 30n);
  assert.equal(formatAed(30n), "0.30");
  assert.equal(formatAed(parseAed("1000000.00")), "1000000.00");
});

test("ambiguous, negative, excessive, and non-canonical AED inputs are rejected", () => {
  for (const value of ["1", "1.0", "1.001", "01.00", "1e2", "-1.00", "NaN", "1,000.00", " 1.00", "1000000.01"]) {
    assert.throws(() => parseAed(value));
  }
  assert.throws(() => parseAed(1.01 as unknown as string));
  assert.throws(() => formatAed(-1n));
});

test("percentage fees apply explicit half-up minor-unit rounding", () => {
  assert.equal(percentageFeeMinor(10_200n, 150), 153n);
  assert.equal(percentageFeeMinor(1n, 5_000), 1n);
  assert.equal(percentageFeeMinor(1n, 4_999), 0n);
  assert.throws(() => percentageFeeMinor(100n, 1.5));
  assert.throws(() => percentageFeeMinor(100n, 10_001));
});

test("excessive money input is rejected by the length guard before conversion", () => {
  assert.throws(() => parseAed(`${"9".repeat(10_000)}.00`), { name: "RangeError", message: /at most 10 characters/ });
  assert.equal(parseAed("1000000.00"), 100_000_000n);
});
