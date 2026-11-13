import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';

export interface UserSettings {
  uid: string;
  preferredVoice: string;
  speakingRate: number;
  draftText: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface VoiceoverProject {
  id: string;
  ownerId: string;
  title: string;
  text: string;
  voiceId: string;
  voiceName: string;
  speakingRate: number;
  srtContent: string;
  charCount: number;
  estimatedDurationSeconds: number;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface SaveProjectInput {
  title?: string;
  text: string;
  voiceId: string;
  voiceName: string;
  speakingRate: number;
  srtContent?: string | null;
  estimatedDurationSeconds?: number;
}

const SAFE_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;

function sanitizeShortId(value: string, fallback: string): string {
  const cleaned = (value || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64);
  return cleaned && SAFE_ID_REGEX.test(cleaned) ? cleaned : fallback;
}

function clampRate(rate: number): number {
  if (typeof rate !== 'number' || Number.isNaN(rate)) return 1.0;
  return Math.min(1.5, Math.max(0.8, Number(rate.toFixed(2))));
}

function truncateString(value: string, maxLength: number): string {
  return (value || '').slice(0, maxLength);
}

function buildProjectTitle(text: string, customTitle?: string): string {
  const source = (customTitle || text || 'مشروع تعليق صوتي').trim().replace(/\s+/g, ' ');
  if (!source) return 'مشروع تعليق صوتي';
  return source.length > 60 ? `${source.slice(0, 57).trim()}...` : source.slice(0, 120);
}

export async function ensureUserDocuments(
  user: User,
  defaults: { preferredVoice: string; speakingRate: number; draftText: string }
): Promise<UserSettings> {
  const settingsPath = `users/${user.uid}`;
  const settingsRef = doc(db, 'users', user.uid);

  let resolvedSettings: UserSettings;

  try {
    const snap = await getDoc(settingsRef);
    if (!snap.exists()) {
      const newSettings = {
        uid: user.uid,
        preferredVoice: sanitizeShortId(defaults.preferredVoice, 'teacher_m'),
        speakingRate: clampRate(defaults.speakingRate),
        draftText: truncateString(defaults.draftText, 10000),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      await setDoc(settingsRef, newSettings);
      resolvedSettings = {
        uid: user.uid,
        preferredVoice: newSettings.preferredVoice,
        speakingRate: newSettings.speakingRate,
        draftText: newSettings.draftText,
      };
    } else {
      const data = snap.data() as UserSettings;
      resolvedSettings = {
        uid: data.uid,
        preferredVoice: data.preferredVoice || 'teacher_m',
        speakingRate: clampRate(data.speakingRate ?? 1.0),
        draftText: typeof data.draftText === 'string' ? data.draftText : '',
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null,
      };
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, settingsPath);
  }

  // Ensure isolated private PII profile document exists/stays fresh
  const profilePath = `users/${user.uid}/private/profile`;
  const profileRef = doc(db, 'users', user.uid, 'private', 'profile');

  try {
    const profileSnap = await getDoc(profileRef);
    const email = truncateString(user.email || '', 320);
    const displayName = truncateString(user.displayName || '', 120);
    const photoURL = truncateString(user.photoURL || '', 1000);

    if (!profileSnap.exists()) {
      await setDoc(profileRef, {
        uid: user.uid,
        email,
        displayName,
        photoURL,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const existingProfile = profileSnap.data();
      if (
        existingProfile.email !== email ||
        existingProfile.displayName !== displayName ||
        existingProfile.photoURL !== photoURL
      ) {
        await updateDoc(profileRef, {
          email,
          displayName,
          photoURL,
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, profilePath);
  }

  return resolvedSettings;
}

export async function updateUserSettings(
  uid: string,
  updates: { preferredVoice: string; speakingRate: number; draftText: string }
): Promise<void> {
  const path = `users/${uid}`;
  const ref = doc(db, 'users', uid);

  try {
    await updateDoc(ref, {
      preferredVoice: sanitizeShortId(updates.preferredVoice, 'teacher_m'),
      speakingRate: clampRate(updates.speakingRate),
      draftText: truncateString(updates.draftText, 10000),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function saveVoiceoverProject(
  uid: string,
  input: SaveProjectInput
): Promise<string> {
  const trimmedText = truncateString((input.text || '').trim(), 10000);
  if (!trimmedText) {
    throw new Error('لا يمكن حفظ نص فارغ');
  }

  const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `users/${uid}/projects/${projectId}`;
  const ref = doc(db, 'users', uid, 'projects', projectId);

  const payload = {
    ownerId: uid,
    title: buildProjectTitle(trimmedText, input.title),
    text: trimmedText,
    voiceId: sanitizeShortId(input.voiceId, 'teacher_m'),
    voiceName: truncateString((input.voiceName || 'Arabic Voice').trim(), 100) || 'Arabic Voice',
    speakingRate: clampRate(input.speakingRate),
    srtContent: truncateString(input.srtContent || '', 20000),
    charCount: Math.max(1, Math.min(10000, Math.floor(trimmedText.length))),
    estimatedDurationSeconds: Math.max(
      0,
      Math.min(86400, Number((input.estimatedDurationSeconds || 0).toFixed(2)))
    ),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(ref, payload);
    return projectId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function deleteVoiceoverProject(
  uid: string,
  projectId: string
): Promise<void> {
  if (!SAFE_ID_REGEX.test(projectId)) {
    throw new Error('معرف المشروع غير صالح');
  }
  const path = `users/${uid}/projects/${projectId}`;
  const ref = doc(db, 'users', uid, 'projects', projectId);

  try {
    await deleteDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeToUserProjects(
  uid: string,
  onProjects: (projects: VoiceoverProject[]) => void,
  onError?: (err: Error) => void
): () => void {
  const path = `users/${uid}/projects`;
  const q = query(
    collection(db, 'users', uid, 'projects'),
    where('ownerId', '==', uid),
    limit(50)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const items: VoiceoverProject[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          ownerId: data.ownerId,
          title: data.title,
          text: data.text,
          voiceId: data.voiceId,
          voiceName: data.voiceName,
          speakingRate: data.speakingRate,
          srtContent: data.srtContent || '',
          charCount: data.charCount || 0,
          estimatedDurationSeconds: data.estimatedDurationSeconds || 0,
          createdAt: data.createdAt || null,
          updatedAt: data.updatedAt || null,
        };
      });

      items.sort((a, b) => {
        const aMs = a.updatedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;
        const bMs = b.updatedAt?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0;
        return bMs - aMs;
      });

      onProjects(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) {
          onError(wrapped);
        }
      }
    }
  );
}
