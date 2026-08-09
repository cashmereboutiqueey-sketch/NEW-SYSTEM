import { describe, it, expect } from "vitest";
import {
  encodeSerial,
  decodeSerial,
  isWellFormedSerial,
  normaliseTypedSerial,
  SerialError,
  SERIAL_ALPHABET,
  SERIAL_LENGTH,
  MAX_SERIAL_ORDINAL,
} from "./serial";
import { code128Bars, QUIET_ZONE_MODULES } from "./barcode";

describe("the alphabet", () => {
  it("leaves out the characters people confuse", () => {
    for (const character of "01ILO") {
      expect(SERIAL_ALPHABET).not.toContain(character);
    }
  });

  it("has no repeats", () => {
    expect(new Set(SERIAL_ALPHABET).size).toBe(SERIAL_ALPHABET.length);
  });

  it("is a prime length, which is what makes the check character sound", () => {
    const length = SERIAL_ALPHABET.length;
    expect(length).toBe(31);
    for (let d = 2; d * d <= length; d++) expect(length % d).not.toBe(0);
  });
});

describe("encoding", () => {
  it("is always eight characters", () => {
    for (const ordinal of [0, 1, 29, 30, 12345, 999999, MAX_SERIAL_ORDINAL]) {
      expect(encodeSerial(ordinal)).toHaveLength(SERIAL_LENGTH);
    }
  });

  it("uses only alphabet characters", () => {
    for (const ordinal of [0, 7, 1000, 5_000_000]) {
      for (const character of encodeSerial(ordinal)) {
        expect(SERIAL_ALPHABET).toContain(character);
      }
    }
  });

  it("gives a different code to every garment", () => {
    const seen = new Set<string>();
    for (let ordinal = 0; ordinal < 20_000; ordinal++) {
      seen.add(encodeSerial(ordinal));
    }
    expect(seen.size).toBe(20_000);
  });

  it("round-trips through decoding", () => {
    for (const ordinal of [0, 1, 29, 30, 899, 900, 12345, 6_400_000, MAX_SERIAL_ORDINAL]) {
      expect(decodeSerial(encodeSerial(ordinal))).toBe(ordinal);
    }
  });

  it("refuses an ordinal past the end of the body", () => {
    expect(() => encodeSerial(MAX_SERIAL_ORDINAL + 1)).toThrow(SerialError);
  });

  it("refuses a fraction or a negative", () => {
    expect(() => encodeSerial(1.5)).toThrow(SerialError);
    expect(() => encodeSerial(-1)).toThrow(SerialError);
  });
});

describe("the check character", () => {
  it("rejects a single wrong character", () => {
    const serial = encodeSerial(4271);

    let caught = 0;
    for (let i = 0; i < serial.length; i++) {
      for (const replacement of SERIAL_ALPHABET) {
        if (replacement === serial[i]) continue;
        const broken = serial.slice(0, i) + replacement + serial.slice(i + 1);
        if (decodeSerial(broken) === null) caught++;
      }
    }

    // Every single-character misreading of this code is caught.
    expect(caught).toBe(serial.length * (SERIAL_ALPHABET.length - 1));
  });

  it("rejects two characters swapped over", () => {
    // Positional weights are what make this fail; a plain sum would not.
    const serial = encodeSerial(58_321);

    let checked = 0;
    for (let i = 0; i < serial.length - 1; i++) {
      if (serial[i] === serial[i + 1]) continue;
      const swapped =
        serial.slice(0, i) + serial[i + 1] + serial[i] + serial.slice(i + 2);
      expect(decodeSerial(swapped)).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("rejects a code of the wrong length", () => {
    const serial = encodeSerial(99);
    expect(decodeSerial(serial.slice(0, 7))).toBeNull();
    expect(decodeSerial(serial + "K")).toBeNull();
  });

  it("rejects characters outside the alphabet", () => {
    expect(decodeSerial("O1ILO234")).toBeNull();
    expect(decodeSerial("ABCD!FGH")).toBeNull();
  });
});

describe("what a scanner hands over", () => {
  it("accepts lower case and stray separators", () => {
    const serial = encodeSerial(777);
    expect(decodeSerial(normaliseTypedSerial(` ${serial.toLowerCase()} `))).toBe(777);
    expect(
      decodeSerial(normaliseTypedSerial(`${serial.slice(0, 4)}-${serial.slice(4)}`)),
    ).toBe(777);
  });

  it("does not guess at a character outside the alphabet", () => {
    // A misread is better failing loudly than silently pointing at another
    // garment, so nothing is mapped to a lookalike.
    expect(isWellFormedSerial(normaliseTypedSerial("OOOOOOOO"))).toBe(false);
  });
});

describe("the printed barcode fits a 40mm label", () => {
  it("comes in under the label width at 0.25mm per module", () => {
    // totalModules already counts the quiet zones, which a scanner needs as
    // much as it needs the bars.
    const { totalModules } = code128Bars(encodeSerial(4271));
    const widthMm = totalModules * 0.25;

    expect(QUIET_ZONE_MODULES).toBeGreaterThan(0);
    expect(widthMm).toBeLessThan(40);
    // And leaves a sane margin rather than touching the edges.
    expect(widthMm).toBeLessThan(37);
  });

  it("would not fit if the readable form were printed instead", () => {
    // The reason the code is short. Kept as a test so nobody "improves" the
    // serial into something legible and discovers the problem on the roll.
    const { totalModules } = code128Bars("DALIA-BLK-M-00427");
    expect(totalModules * 0.25).toBeGreaterThan(40);
  });
});
