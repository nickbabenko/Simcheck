import { randomBytes } from 'node:crypto'

/** Crockford base32: 32 symbols, no U, and I/L/O excluded as digit lookalikes.
 *  Exactly 32 characters matters — it means 5 bits map to one symbol with no
 *  modulo bias, so every slug is uniformly distributed. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 16 symbols of base32 is 80 bits of entropy — not enumerable at any plausible
 * request rate.
 *
 * It is still not authentication. An unguessable URL survives scanning; it does
 * not survive a Referer header, a proxy log, a screenshot, or a link pasted into
 * a chat. Any env holding real data wants a token on top — see README,
 * "What obscurity does and does not buy".
 */
export function newSlug(length = 16): string {
  const buf = randomBytes(length)
  let out = ''
  for (const b of buf) out += ALPHABET[b & 31]
  return out.toLowerCase()
}
