# Firestore Security Specification

## 1. Data Invariants
1. **Default Deny**: No read or write is allowed on any path unless explicitly permitted.
2. **Verified Identity**: All authenticated reads and writes require `request.auth != null` and `request.auth.token.email_verified == true`.
3. **Strict Ownership**:
   - `/users/{userId}` can only be read or written by the user whose `request.auth.uid == userId`.
   - `/users/{userId}/private/{docId}` (only `docId == 'profile'`) isolates PII (`email`, `displayName`, `photoURL`) strictly to the owning user.
   - `/users/{userId}/projects/{projectId}` can only be read, listed, created, updated, or deleted by `request.auth.uid == userId` AND `resource.data.ownerId == request.auth.uid` (for reads/list) AND `exists(/databases/$(database)/documents/users/$(userId))` (Master Gate parent check on single-doc create/update).
4. **ID Poisoning Guard**: All document IDs (`userId`, `projectId`, `docId`) must match `^[a-zA-Z0-9_\-]+$` and be `<= 128` chars.
5. **Immutable Fields**: `uid`, `ownerId`, and `createdAt` can never be mutated after creation.
6. **Temporal Integrity**: `createdAt` on create and `updatedAt` on create/update must equal `request.time`.
7. **Strict Key Allowlists & Value Bounds**: Every create checks `keys().hasAll(...) && keys().hasOnly(...)`; every update checks `isValid[Entity](incoming())` and `incoming().diff(existing()).affectedKeys().hasOnly(...)`.

## 2. The "Dirty Dozen" Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated Read/Write**: Reading or writing `/users/userA/projects/proj1` with `auth == null`.
2. **Unverified Email Spoofing**: Writing `/users/userA` with `auth.uid == 'userA'` and `email_verified: false`.
3. **Cross-User PII Snooping**: User B reading `/users/userA/private/profile`.
4. **Cross-User Project List**: User B listing `/users/userA/projects`.
5. **Identity Spoofing on Create**: User A creating `/users/userA/projects/proj1` with `ownerId: 'userB'`.
6. **Shadow / Ghost Field Injection**: User A creating `/users/userA` with an extra field `isAdmin: true`.
7. **ID Poisoning**: User A creating `/users/userA/projects/` with a 200-char or `$bad!id` `projectId`.
8. **Client-Forged Timestamp on Create**: User A creating `/users/userA/projects/proj1` with `createdAt: new Date('2020-01-01')` instead of `serverTimestamp()`.
9. **Immutable Field Mutation on Update**: User A updating `/users/userA/projects/proj1` to change `ownerId` or `createdAt`.
10. **Value Poisoning (Out-of-Bounds Number)**: User A updating `speakingRate: 5.0` (outside `[0.8, 1.5]`).
11. **Value Poisoning (Oversized String)**: User A updating `draftText` with a string longer than `10000` characters.
12. **Orphaned Subcollection Write**: User A creating `/users/userA/projects/proj1` when `/users/userA` parent document does not exist.
