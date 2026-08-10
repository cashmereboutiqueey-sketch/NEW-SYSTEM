import bcrypt from "bcryptjs";

/**
 * Hashing a password, and nothing else.
 *
 * Split out of `lib/auth` because that module imports Next's router in order
 * to redirect, and hashing a password has no business depending on a web
 * framework. The practical cost of the old arrangement was that no command
 * line tool could create a user — which matters most in exactly the situation
 * where it is needed, standing at a fresh server with no accounts on it, or
 * locked out of the only owner.
 */

/**
 * Twelve rounds costs an attacker roughly a quarter of a second per guess on
 * commodity hardware, and costs a person signing in an amount they will not
 * notice. Raising it later is safe: bcrypt records the cost inside the hash,
 * so old passwords keep verifying at the cost they were made with.
 */
export const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A hash that cannot match anything, for spending the same time on an account
 * that does not exist as on one that does. Without it, a missing address
 * answers instantly and a real one takes a quarter of a second, and the login
 * page becomes a way to enumerate staff.
 */
export const IMPOSSIBLE_HASH =
  "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
