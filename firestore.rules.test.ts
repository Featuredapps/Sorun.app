/**
 * Verification specification for Firestore Security Rules Dirty Dozen payloads.
 * Intended to be run against the Firebase Firestore Emulator (`@firebase/rules-unit-testing`).
 */

export const DIRTY_DOZEN_SCENARIOS = [
  { id: 1, name: 'Unauthenticated write to /users/userA', expected: 'PERMISSION_DENIED' },
  { id: 2, name: 'Unverified email token write to /users/userA', expected: 'PERMISSION_DENIED' },
  { id: 3, name: 'Cross-user PII read on /users/userA/private/profile', expected: 'PERMISSION_DENIED' },
  { id: 4, name: 'Cross-user project list on /users/userA/projects', expected: 'PERMISSION_DENIED' },
  { id: 5, name: 'Identity spoofing ownerId != auth.uid on create', expected: 'PERMISSION_DENIED' },
  { id: 6, name: 'Shadow field isAdmin injected on create', expected: 'PERMISSION_DENIED' },
  { id: 7, name: 'Invalid projectId with illegal characters or >128 length', expected: 'PERMISSION_DENIED' },
  { id: 8, name: 'Client-forged createdAt timestamp instead of request.time', expected: 'PERMISSION_DENIED' },
  { id: 9, name: 'Attempt to mutate immutable createdAt or ownerId on update', expected: 'PERMISSION_DENIED' },
  { id: 10, name: 'Out-of-range speakingRate (5.0 > 1.5)', expected: 'PERMISSION_DENIED' },
  { id: 11, name: 'Oversized draftText (> 10000 chars)', expected: 'PERMISSION_DENIED' },
  { id: 12, name: 'Orphaned project creation without parent /users/{userId}', expected: 'PERMISSION_DENIED' },
] as const;
