// stores/users.js
export const users = new Map();
/**
 * users: Map<uid, {
 *   displayName: string,
 *   email: string|null,
 *   avatarUrl: string|null,
 *   plan: "free"|"pro",
 *   planUntilEpochSeconds: number|null
 * }>
 */