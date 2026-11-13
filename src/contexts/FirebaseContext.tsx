import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import {
  ensureUserDocuments,
  subscribeToUserProjects,
  UserSettings,
  VoiceoverProject,
} from '../services/firestoreService';

interface FirebaseContextValue {
  user: User | null;
  authReady: boolean;
  signingIn: boolean;
  authError: string | null;
  cloudSettings: UserSettings | null;
  projects: VoiceoverProject[];
  projectsLoading: boolean;
  signInWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  clearAuthError: () => void;
}

const FirebaseContext = createContext<FirebaseContextValue | undefined>(undefined);

export function FirebaseProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [cloudSettings, setCloudSettings] = useState<UserSettings | null>(null);
  const [projects, setProjects] = useState<VoiceoverProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  useEffect(() => {
    let unsubscribeProjects: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      if (unsubscribeProjects) {
        unsubscribeProjects();
        unsubscribeProjects = null;
      }

      setUser(firebaseUser);

      if (firebaseUser) {
        setProjectsLoading(true);
        try {
          const savedRateRaw = localStorage.getItem('voiceover_speaking_rate');
          const parsedRate = savedRateRaw ? parseFloat(savedRateRaw) : 1.0;
          const safeRate = !Number.isNaN(parsedRate) && parsedRate >= 0.8 && parsedRate <= 1.5 ? parsedRate : 1.0;
          const savedDraft = localStorage.getItem('voiceover_draft') || '';

          const settings = await ensureUserDocuments(firebaseUser, {
            preferredVoice: 'teacher_m',
            speakingRate: safeRate,
            draftText: savedDraft,
          });
          setCloudSettings(settings);

          unsubscribeProjects = subscribeToUserProjects(
            firebaseUser.uid,
            (items) => {
              setProjects(items);
              setProjectsLoading(false);
            },
            () => {
              setProjectsLoading(false);
            }
          );
        } catch (err) {
          console.error('Failed to initialize Firebase user workspace:', err);
          setProjectsLoading(false);
        }
      } else {
        setCloudSettings(null);
        setProjects([]);
        setProjectsLoading(false);
      }

      setAuthReady(true);
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProjects) unsubscribeProjects();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setSigningIn(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.error('Google sign-in error:', err);
      if (err?.code === 'auth/popup-closed-by-user') {
        setAuthError('تم إغلاق نافذة تسجيل الدخول قبل الإتمام.');
      } else if (err?.code === 'auth/popup-blocked') {
        setAuthError('يرجى السماح بفتح النوافذ المنبثقة (Popups) لتسجيل الدخول.');
      } else {
        setAuthError('تعذر تسجيل الدخول حالياً. يرجى المحاولة مرة أخرى.');
      }
    } finally {
      setSigningIn(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setAuthError(null);
    try {
      await signOut(auth);
    } catch (err) {
      console.error('Sign-out error:', err);
    }
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  return (
    <FirebaseContext.Provider
      value={{
        user,
        authReady,
        signingIn,
        authError,
        cloudSettings,
        projects,
        projectsLoading,
        signInWithGoogle,
        logout,
        clearAuthError,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
}

export function useFirebase() {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error('useFirebase must be used inside FirebaseProvider');
  }
  return ctx;
}
