// Shared error taxonomy. Lives in its own module so both the auth layer and the
// service can throw the same types without importing each other, and so the
// daemon has exactly one place to map errors to status codes.

/** No usable credential was presented. */
export class AuthError extends Error {}

/** Authenticated, but the token lacks the scope for this operation. */
export class ForbiddenError extends Error {}

/**
 * The resource does not exist *for this caller*.
 *
 * Deliberately also used when an env exists but belongs to another tenant:
 * distinguishing "not yours" from "no such thing" lets a caller enumerate which
 * ids are real.
 */
export class NotFoundError extends Error {}

/** A limit was hit. Retryable once something is freed. */
export class QuotaError extends Error {}

/** The request body exceeded the cap before it could be parsed. */
export class PayloadTooLargeError extends Error {}
