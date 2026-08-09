/**
 * The code printed on every garment.
 *
 * Each physical garment carries its own code, so two black mediums off the
 * same run are told apart. That is what lets the system say which piece was
 * sold, which was returned, and which never arrived — none of which is
 * answerable when a whole size shares one barcode.
 *
 * Eight characters, because that is what fits. A Code 128 barcode of eight
 * characters comes to 143 modules including its quiet zones; at 0.25mm per
 * module that is 35.75mm, which sits inside a 40mm label with a margin either
 * side. Seventeen characters — the readable `DALIA-BLK-M-00427` shape — comes
 * to 55mm and runs off the edge of the label, where no scanner will read it.
 *
 * The alphabet drops 0/O and 1/I/L — the pairs people confuse reading a code
 * off a tag or over the phone. That leaves exactly 31 of the 36 alphanumerics,
 * and 31 being prime is what makes the check character below actually work.
 */

export const SERIAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SERIAL_BODY_LENGTH = 7;
export const SERIAL_LENGTH = SERIAL_BODY_LENGTH + 1;

/** Prime, and the check character depends on it being prime. */
const BASE = SERIAL_ALPHABET.length; // 31

/** The largest ordinal that fits in the body. 31^7 ≈ 27.5 billion garments. */
export const MAX_SERIAL_ORDINAL = BASE ** SERIAL_BODY_LENGTH - 1;

export class SerialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerialError";
  }
}

/**
 * A check character over the body.
 *
 * Positional weights, so transposing two characters changes the result — the
 * commonest mistake when a code is read aloud or typed in by hand, and the one
 * a plain sum would miss.
 *
 * Both guarantees rest on the alphabet length being prime. A single wrong
 * character shifts the sum by `delta × weight`, and a swap by
 * `delta × (weight difference)`; with a prime modulus neither product can come
 * back to zero unless the change itself was zero. At a composite length — 30,
 * say, which is what dropping one more letter would give — every weight
 * sharing a factor with the base has misreadings it waves through.
 */
function checkCharacter(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const value = SERIAL_ALPHABET.indexOf(body[i]);
    if (value < 0) throw new SerialError(`"${body[i]}" is not a serial character.`);
    sum += value * (i + 2);
  }
  return SERIAL_ALPHABET[sum % BASE];
}

/** Turns a counter into the code printed on the tag. */
export function encodeSerial(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new SerialError("A serial ordinal must be a whole number, zero or more.");
  }
  if (ordinal > MAX_SERIAL_ORDINAL) {
    throw new SerialError(
      `Ordinal ${ordinal} is past the end of an ${SERIAL_BODY_LENGTH}-character body.`,
    );
  }

  let n = ordinal;
  let body = "";
  for (let i = 0; i < SERIAL_BODY_LENGTH; i++) {
    body = SERIAL_ALPHABET[n % BASE] + body;
    n = Math.floor(n / BASE);
  }

  return body + checkCharacter(body);
}

/**
 * Checks a scanned or typed code.
 *
 * Returns the ordinal it encodes, or null if the code is malformed or its
 * check character does not agree. A scanner that misreads one bar produces a
 * code that looks perfectly ordinary; this is what catches it before the till
 * sells the wrong garment.
 */
export function decodeSerial(serial: string): number | null {
  const code = serial.trim().toUpperCase();
  if (code.length !== SERIAL_LENGTH) return null;

  const body = code.slice(0, SERIAL_BODY_LENGTH);
  const check = code[SERIAL_BODY_LENGTH];

  let ordinal = 0;
  for (const character of body) {
    const value = SERIAL_ALPHABET.indexOf(character);
    if (value < 0) return null;
    ordinal = ordinal * BASE + value;
  }

  if (SERIAL_ALPHABET.indexOf(check) < 0) return null;
  if (checkCharacter(body) !== check) return null;

  return ordinal;
}

/** Whether a code could be a serial at all, without asking the database. */
export function isWellFormedSerial(serial: string): boolean {
  return decodeSerial(serial) !== null;
}

/**
 * Tidies what a scanner or a person typed.
 *
 * Case and stray spaces or dashes carry no meaning, so they go. Nothing else
 * is touched: a character outside the alphabet is a genuine misreading, and
 * guessing which letter was meant would turn a code that fails loudly into one
 * that quietly points at the wrong garment.
 */
export function normaliseTypedSerial(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}
