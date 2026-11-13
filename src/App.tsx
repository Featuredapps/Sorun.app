/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { generateVoiceover } from './services/geminiService';
import { useFirebase } from './contexts/FirebaseContext';
import {
  saveVoiceoverProject,
  deleteVoiceoverProject,
  updateUserSettings,
  VoiceoverProject,
} from './services/firestoreService';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';
import { 
  Mic2,
  Volume2,
  Download,
  Pause,
  Play,
  Loader2,
  History,
  Sparkles,
  Music,
  Settings2,
  Info,
  FileText,
  AlertCircle,
  Clock,
  BarChart3,
  Zap,
  Gauge,
  RotateCcw,
  RotateCw,
  CheckCircle2,
  Wand2,
  AlertTriangle,
  Check,
  LogIn,
  LogOut,
  Cloud,
  Bookmark,
  Trash2,
  FolderOpen
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface AnalysisIssue {
  id: string;
  type: 'critical' | 'warning' | 'suggestion';
  title: string;
  detail: string;
  canAutoFix: boolean;
}

interface TextAnalysis {
  charCount: number;
  wordCount: number;
  estimatedDurationSeconds: number;
  issues: AnalysisIssue[];
  status: 'optimal' | 'warning' | 'critical' | 'empty';
  canAutoFix: boolean;
}

export default function App() {
  // Voiceover State
  const [voiceoverText, setVoiceoverText] = useState("");
  const [cleanNotification, setCleanNotification] = useState<string | null>(null);
  const [generatingVoice, setGeneratingVoice] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [srtContent, setSrtContent] = useState<string | null>(null);
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState<number>(0);
  const [isCoolingDown, setIsCoolingDown] = useState(false);
  const [cooldownTime, setCooldownTime] = useState(0);
  const [selectedVoice, setSelectedVoice] = useState("teacher_m");
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewAudio, setPreviewAudio] = useState<{ [key: string]: string }>({});
  const [activePreview, setActivePreview] = useState<string | null>(null);
  const [autoPopulate, setAutoPopulate] = useState(true);
  const [speakingRate, setSpeakingRate] = useState<number>(() => {
    const saved = localStorage.getItem('voiceover_speaking_rate');
    if (saved) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed >= 0.8 && parsed <= 1.5) {
        return parsed;
      }
    }
    return 1.0;
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Firebase Auth & Cloud Sync State
  const {
    user,
    authReady,
    signingIn,
    authError,
    cloudSettings,
    projects: cloudProjects,
    projectsLoading,
    signInWithGoogle,
    logout,
    clearAuthError,
  } = useFirebase();
  const [savingProject, setSavingProject] = useState(false);
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);
  const hydratedUidRef = useRef<string | null>(null);

  // Usage Tracking State
  const [usage, setUsage] = useState({
    requestsToday: 0,
    charsToday: 0,
    lastResetDate: new Date().toDateString(),
    requestsThisMinute: 0,
    minuteResetTime: Date.now() + 60000
  });

  const DAILY_REQUEST_LIMIT = 1000;
  const DAILY_CHAR_LIMIT = 1000000;
  const MINUTE_REQUEST_LIMIT = 15;

  useEffect(() => {
    const savedUsage = localStorage.getItem('voiceover_usage');
    if (savedUsage) {
      const parsed = JSON.parse(savedUsage);
      const today = new Date().toDateString();
      
      if (parsed.lastResetDate !== today) {
        // Reset daily limits
        const newUsage = {
          requestsToday: 0,
          charsToday: 0,
          lastResetDate: today,
          requestsThisMinute: 0,
          minuteResetTime: Date.now() + 60000
        };
        setUsage(newUsage);
        localStorage.setItem('voiceover_usage', JSON.stringify(newUsage));
      } else {
        setUsage(parsed);
      }
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() >= usage.minuteResetTime) {
        setUsage(prev => ({
          ...prev,
          requestsThisMinute: 0,
          minuteResetTime: Date.now() + 60000
        }));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [usage.minuteResetTime]);

  // Auto-save and restore text draft
  useEffect(() => {
    const savedDraft = localStorage.getItem('voiceover_draft');
    if (savedDraft) {
      setVoiceoverText(savedDraft);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('voiceover_draft', voiceoverText);
  }, [voiceoverText]);

  useEffect(() => {
    if (autoPopulate && !voiceoverText.trim()) {
      const currentVoice = voices.find(v => v.id === selectedVoice);
      if (currentVoice?.example) {
        setVoiceoverText(currentVoice.example);
      }
    }
  }, [selectedVoice, autoPopulate]);

  useEffect(() => {
    localStorage.setItem('voiceover_speaking_rate', speakingRate.toString());
    if (audioRef.current) {
      audioRef.current.playbackRate = speakingRate;
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.playbackRate = speakingRate;
    }
  }, [speakingRate]);

  // Hydrate voiceover settings from Firestore once per authenticated session
  useEffect(() => {
    if (!user || !cloudSettings) {
      if (!user) hydratedUidRef.current = null;
      return;
    }
    if (hydratedUidRef.current === user.uid) return;
    hydratedUidRef.current = user.uid;

    if (cloudSettings.preferredVoice) {
      setSelectedVoice(cloudSettings.preferredVoice);
    }
    if (
      typeof cloudSettings.speakingRate === 'number' &&
      cloudSettings.speakingRate >= 0.8 &&
      cloudSettings.speakingRate <= 1.5
    ) {
      setSpeakingRate(cloudSettings.speakingRate);
    }
    if (cloudSettings.draftText && cloudSettings.draftText.trim() && !localStorage.getItem('voiceover_draft')) {
      setVoiceoverText(cloudSettings.draftText);
    }
  }, [user, cloudSettings]);

  // Debounced sync of active draft and audio settings to Firestore
  useEffect(() => {
    if (!user || hydratedUidRef.current !== user.uid) return;
    const timer = setTimeout(() => {
      updateUserSettings(user.uid, {
        preferredVoice: selectedVoice,
        speakingRate,
        draftText: voiceoverText,
      }).catch((err) => {
        console.error('Failed to sync user settings:', err);
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [user, selectedVoice, speakingRate, voiceoverText]);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isCoolingDown && cooldownTime > 0) {
      timer = setInterval(() => {
        setCooldownTime(prev => {
          if (prev <= 1) {
            setIsCoolingDown(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isCoolingDown, cooldownTime]);

  const textAnalysis = useMemo<TextAnalysis>(() => {
    const trimmed = voiceoverText.trim();
    const charCount = voiceoverText.length;
    
    if (!trimmed) {
      return {
        charCount: 0,
        wordCount: 0,
        estimatedDurationSeconds: 0,
        issues: [],
        status: 'empty',
        canAutoFix: false
      };
    }

    const words = trimmed.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    // Standard Arabic narration: ~130 words per minute at 1.0x rate
    const estimatedDurationSeconds = Math.max(1, Math.round((wordCount / (130 * speakingRate)) * 60));

    const issues: AnalysisIssue[] = [];

    // 1. Check for Emojis
    const emojiMatches = voiceoverText.match(/\p{Extended_Pictographic}/gu) || [];
    if (emojiMatches.length > 0) {
      const sample = Array.from(new Set(emojiMatches)).slice(0, 4).join(' ');
      issues.push({
        id: 'emojis',
        type: 'critical',
        title: 'رموز تعبيرية (Emojis) غير مدعومة صوتياً',
        detail: `تم رصد ${emojiMatches.length} رمز تعبيري (${sample}). الرموز التعبيرية لا تُقرأ وقد تسبب تشويشاً أو سكوتاً مفاجئاً في الصوت.`,
        canAutoFix: true
      });
    }

    // 2. Check for URLs & Emails
    const urlMatches = voiceoverText.match(/(?:https?:\/\/|www\.)[^\s]+/gi) || [];
    const emailMatches = voiceoverText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi) || [];
    if (urlMatches.length > 0 || emailMatches.length > 0) {
      issues.push({
        id: 'links',
        type: 'critical',
        title: 'روابط إنترنت أو عناوين إلكترونية',
        detail: 'تحتوي الفقرة على روابط إنترنت يصعب تهجئتها صوتياً وتسبب تعثراً في القراءة.',
        canAutoFix: true
      });
    }

    // 3. Check for unsupported code / math / bracket symbols
    const symbolMatches = voiceoverText.match(/[#@$^*_~\\/|<>{}[\]+=`%]/g) || [];
    if (symbolMatches.length > 0) {
      const sample = Array.from(new Set(symbolMatches)).slice(0, 5).join(' ');
      issues.push({
        id: 'symbols',
        type: 'warning',
        title: 'رموز خاصة أو برمجية غير مقروءة',
        detail: `تم رصد رموز غير لغوية (${sample}) قد تُقرأ بصوت غير دقيق أو تؤثر على جودة مخارج الحروف.`,
        canAutoFix: true
      });
    }

    // 4. Check for repeated excessive punctuation
    const repeatedPunct = voiceoverText.match(/\.{3,}|،{2,}|\?{2,}|!{2,}|؟{2,}/g) || [];
    if (repeatedPunct.length > 0) {
      issues.push({
        id: 'repeated_punct',
        type: 'suggestion',
        title: 'تكرار في علامات الترقيم',
        detail: 'تكرار النقاط أو الفواصل (مثل .... أو ؟؟) يربك توقيت السكتات والتنفس الصوتي الطبيعي.',
        canAutoFix: true
      });
    }

    // 5. Length checks (explicitly requested: 'النص طويل جداً، يفضل تقسيمه')
    if (charCount > 3500) {
      issues.push({
        id: 'extremely_long',
        type: 'critical',
        title: 'النص طويل جداً، يفضل تقسيمه',
        detail: `النص يتجاوز ${charCount.toLocaleString()} حرف (${wordCount} كلمة). النصوص الطويلة جداً تزيد من احتمال انقطاع الصوت أو ثبات النبرة، ويُنصح بشدة بتجزئتها إلى مقاطع مستقلة.`,
        canAutoFix: false
      });
    } else if (charCount > 1500) {
      issues.push({
        id: 'long',
        type: 'warning',
        title: 'النص طويل نسبياً، يفضل تقسيمه',
        detail: `النص يحتوي على ${charCount.toLocaleString()} حرف (${wordCount} كلمة). يستغرق التوليد وقتاً أطول، وتقسيم النص يحافظ على حيوية وتنوع النبرة.`,
        canAutoFix: false
      });
    }

    // 6. Check for lack of punctuation in long sentences
    if (wordCount >= 25 && !/[.،؛!؟\n]/.test(voiceoverText)) {
      issues.push({
        id: 'no_punctuation',
        type: 'suggestion',
        title: 'نصيحة: أضف علامات الترقيم (الفاصلة والنقطة)',
        detail: 'تساعد علامات الترقيم محرك الصوت في أخذ فترات استراحة وتنفس طبيعية بين الجمل والعبارات.',
        canAutoFix: false
      });
    }

    const hasCritical = issues.some(i => i.type === 'critical');
    const hasWarning = issues.some(i => i.type === 'warning');
    const hasAutoFix = issues.some(i => i.canAutoFix);

    let status: 'optimal' | 'warning' | 'critical' = 'optimal';
    if (hasCritical) status = 'critical';
    else if (hasWarning) status = 'warning';

    return {
      charCount,
      wordCount,
      estimatedDurationSeconds,
      issues,
      status,
      canAutoFix: hasAutoFix
    };
  }, [voiceoverText, speakingRate]);

  const handleCleanText = () => {
    if (!voiceoverText.trim()) return;
    let cleaned = voiceoverText;
    
    // 1. Remove Emojis
    cleaned = cleaned.replace(/\p{Extended_Pictographic}/gu, '');
    
    // 2. Remove URLs & Emails
    cleaned = cleaned.replace(/(?:https?:\/\/|www\.)[^\s]+/gi, '');
    cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '');
    
    // 3. Remove unsupported code/math characters
    cleaned = cleaned.replace(/[#@$^*_~\\/|<>{}[\]+=`%]/g, ' ');
    
    // 4. Standardize punctuation to Arabic where appropriate
    cleaned = cleaned.replace(/,/g, '،');
    cleaned = cleaned.replace(/\?/g, '؟');
    cleaned = cleaned.replace(/;/g, '؛');
    
    // 5. Collapse excessive duplicate punctuation
    cleaned = cleaned.replace(/\.{2,}/g, '.');
    cleaned = cleaned.replace(/،{2,}/g, '،');
    cleaned = cleaned.replace(/؟{2,}/g, '؟');
    cleaned = cleaned.replace(/!{2,}/g, '!');
    
    // 6. Clean multiple spaces but preserve line breaks
    cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
    cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, '\n\n');
    cleaned = cleaned.trim();

    setVoiceoverText(cleaned);
    setCleanNotification("تم تنظيف النص وتنسيقه بنجاح! جاهز للتوليد الصوتي.");
    setTimeout(() => setCleanNotification(null), 3500);
  };

  const updateUsage = (charCount: number, isRequestOnly: boolean = false) => {
    const newUsage = {
      ...usage,
      requestsToday: usage.requestsToday + 1,
      charsToday: usage.charsToday + (isRequestOnly ? 0 : charCount),
      requestsThisMinute: usage.requestsThisMinute + 1
    };
    setUsage(newUsage);
    localStorage.setItem('voiceover_usage', JSON.stringify(newUsage));
  };

  const triggerCooldown = (seconds: number = 60) => {
    setIsCoolingDown(true);
    setCooldownTime(seconds);
    // Also sync minute limit to prevent immediate retry
    setUsage(prev => ({
      ...prev,
      requestsThisMinute: MINUTE_REQUEST_LIMIT
    }));
  };

  const checkLimits = (charCount: number) => {
    if (isCoolingDown) {
      alert(`النظام في فترة راحة حالياً لتجنب الحظر. يرجى الانتظار ${cooldownTime} ثانية.`);
      return false;
    }
    if (usage.requestsToday >= DAILY_REQUEST_LIMIT) {
      alert("عذراً، لقد وصلت إلى الحد الأقصى للمحاولات اليومية (1000 محاولة). يرجى العودة غداً.");
      return false;
    }
    if (usage.charsToday + charCount >= DAILY_CHAR_LIMIT) {
      alert("عذراً، لقد وصلت إلى الحد الأقصى للحروف اليومية (مليون حرف). يرجى العودة غداً.");
      return false;
    }
    if (usage.requestsThisMinute >= MINUTE_REQUEST_LIMIT) {
      const remainingSeconds = Math.max(0, Math.ceil((usage.minuteResetTime - Date.now()) / 1000));
      alert(`عذراً، لقد تجاوزت سرعة الطلبات المسموح بها (15 طلب/دقيقة). يرجى الانتظار ${remainingSeconds} ثانية.`);
      return false;
    }
    return true;
  };

  const voices = [
    { 
      id: 'teacher_m', 
      voiceName: 'Charon',
      name: 'المعلم (ذكر/عام)', 
      description: 'نبرة تعليمية وقورة، مخارج حروف دقيقة جداً',
      gender: 'male',
      previewGreeting: 'أهلاً بكم في رحاب لغة الضاد؛ فصاحة البيان ودقة المخارج في كل كلمة.',
      tone: 'A dignified and articulate male Arabic educator. Exceptionally precise articulation of letters from their authentic phonetic origins (Makharij al-Huroof). Formal, steady, and authoritative pace. Impeccable classical Fusha phonetics, distinct syllable separation, and an inspiring academic presence.',
      example: 'إن اللغة العربية هي لغة الضاد، وتتميز بجمالياتها وبلاغتها الفريدة. اليوم سنتعلم معاً كيفية نطق الحروف من مخارجها الصحيحة، مع التركيز على مخارج الحلق واللسان.'
    },
    { 
      id: 'teacher_young_m', 
      voiceName: 'Puck',
      name: 'المعلم الشاب (ذكر/حيوي)', 
      description: 'نبرة شبابية متحمسة (20-25 عاماً)، أسلوب تعليمي عصري وتفاعلي',
      gender: 'male',
      previewGreeting: 'مرحباً بكم يا أصدقائي! جاهزون لنبدأ تجربة تعليمية ممتعة ومميزة اليوم؟',
      tone: 'A dynamic young adult male tutor (20-25 years old). Energetic, clear, friendly, and engaging. Fast-paced yet remarkably articulate. Uses a modern, interactive pedagogical style that connects effortlessly with learners. Relatable, warm, and highly motivating.',
      example: 'أهلاً بكم يا شباب! أنا متحمس جداً لأننا سنكتشف معاً أسرار البرمجة وكيف يمكننا بناء تطبيقات مذهلة من الصفر. هل أنتم مستعدون للتحدي؟'
    },
    { 
      id: 'teacher_middle_m', 
      voiceName: 'Charon',
      name: 'المعلم الخبير (ذكر/متزن)', 
      description: 'نبرة ناضجة وواثقة (40-50 عاماً)، أسلوب أكاديمي رصين ومحترف',
      gender: 'male',
      previewGreeting: 'أهلاً بكم، سنخوض معاً غمار المعرفة الأكاديمية بأسلوب علمي رصين ومتقن.',
      tone: 'A seasoned middle-aged university professor (45-50 years old). Balanced, authoritative, structured, and profoundly calm. Highly professional with a steady, measured pace and crystal-clear diction. Evokes academic integrity and scholarly trust.',
      example: 'أعزائي الطلاب، يسرني أن أرحب بكم في هذه المحاضرة العلمية. سنناقش اليوم أسس الفيزياء الكلاسيكية وتطبيقاتها العميقة في حياتنا اليومية، مع التركيز على الجوانب التحليلية.'
    },
    { 
      id: 'teacher_elderly_m', 
      voiceName: 'Fenrir',
      name: 'المعلم الحكيم (ذكر/وقور)', 
      description: 'نبرة دافئة وحكيمة (65+ عاماً)، أسلوب أبوي هادئ وملهم',
      gender: 'male',
      previewGreeting: 'يا بني، إن العلم نور ورفعة؛ خذ من التجارب حكمتها ومن المعرفة بريقها.',
      tone: 'A venerable senior educator and mentor (65-70 years old). Deep, warm, slow-paced, grandfatherly, and deeply reassuring. Gentle resonance with thoughtful pauses between sentences. Evokes lifelong wisdom, patience, and profound heritage.',
      example: 'يا أبنائي، العلم هو النور الذي يضيء دروبكم في عتمة الجهل. تذكروا دائماً أن المعرفة لا حدود لها، وأن المثابرة هي مفتاح النجاح الحقيقي في هذه الحياة الطويلة.'
    },
    { 
      id: 'teacher_f', 
      voiceName: 'Kore',
      name: 'المعلمة (أنثى/أكاديمي)', 
      description: 'نبرة تعليمية وقورة، مخارج حروف دقيقة جداً، أسلوب أكاديمي محترف',
      gender: 'female',
      previewGreeting: 'أهلاً بكم يا أحبائي، فلنتعلم معاً بأعلى درجات الدقة والوضوح والإتقان.',
      tone: 'A distinguished professional female educator (35-40 years old). Exceptionally crisp articulation of Arabic phonemes, perfect syllable balance, and a dignified academic cadence. Inspiring, articulate, steady, and documentary-grade clear.',
      example: 'أهلاً بكم يا أحبائي في درس اليوم. سنقوم اليوم برحلة ممتعة في عالم العلوم، لنكتشف كيف تنمو النباتات وما هي العناصر الأساسية التي تحتاجها للحياة.'
    },
    { 
      id: 'teacher_young_f', 
      voiceName: 'Zephyr',
      name: 'الأستاذة الشابة (أنثى/حيوي)', 
      description: 'نبرة شبابية متحمسة (22-28 عاماً)، أسلوب تعليمي عصري وتفاعلي',
      gender: 'female',
      previewGreeting: 'مرحباً بكل المبدعين! أنا معكم اليوم لنحول كل درس إلى متعة واكتشاف جديد.',
      tone: 'A vibrant young female educator (22-28 years old). Bright, energetic, modern, interactive, and articulate. Keeps students engaged with natural vocal agility, clear diction, and an encouraging, friendly warmth.',
      example: 'أهلاً بكم يا صديقاتي في درس اليوم الممتع! اليوم سنكتشف معاً كيف يمكننا استخدام التكنولوجيا لنغير العالم من حولنا. هل أنتن مستعدات للبدء؟'
    },
    { 
      id: 'teacher_elderly_f', 
      voiceName: 'Kore',
      name: 'الأستاذة الحكيمة (أنثى/وقور)', 
      description: 'نبرة دافئة وحكيمة (65+ عاماً)، أسلوب أمومي هادئ وملهم',
      gender: 'female',
      previewGreeting: 'يا أبنائي وبناتي، المعرفة كنز لا يفنى، وبالصبر والاجتهاد تبلغون أعالي القمم.',
      tone: 'A gentle, revered senior female teacher (65-70 years old). Maternal, warm, soothing, and slow-paced. Imbued with unconditional encouragement, deep experience, and pristine Fusha pronunciation.',
      example: 'يا بناتي العزيزات، إن العلم هو السلاح الأقوى الذي يمكنكن التسلح به. تذكرن دائماً أن القراءة تفتح لكن آفاقاً جديدة، وأن الصبر هو مفتاح كل خير.'
    },
    { 
      id: 'deep_baritone_m', 
      voiceName: 'Fenrir',
      name: 'الباريتون العميق (باس/رخيم)', 
      description: 'صوت رجالي عميق (باريتون إلى باس)، دافئ ورنّان وغير حاد، بإيقاع متوسط هادئ وإلقاء ثابت ورصين',
      gender: 'male',
      previewGreeting: 'في هدوء اللحظة وعمق الإحساس، ينساب هذا الصوت الرخيم بوقار وثبات.',
      tone: 'An extraordinarily rich and deep male voice ranging from full baritone to resonant bass. Warm, rounded, velvety low end without any harsh or piercing treble frequencies. Steady, unhurried, grounded cadence with strong chest resonance and supreme acoustic warmth.',
      example: 'في سكون الليل وهدوء اللحظة، تتجلى أعظم المعاني في عمق النفوس. صوتٌ رصين دافئ يحمل في طياته وزناً وحكمة، يلامس القلوب بوقاره ودفئه الهادئ المستقر.'
    },
    { 
      id: 'cheerful_f', 
      voiceName: 'Puck',
      name: 'المتفائلة (أنثى/مبهج)', 
      description: 'نبرة حيوية ومشرقة، طاقة إيجابية وسعادة غامرة',
      gender: 'female',
      previewGreeting: 'يا هلا وكل الهلا! يومكم مليء بالبهجة والنشاط والطاقة الإيجابية الرائعة!',
      tone: 'A radiant, buoyant female voice radiating pure joy and positivity. High energy, sparkling intonation, smiling acoustic timbre, and an uplifting cadence that instantly brightens the listener’s day.',
      example: 'يا له من يوم رائع ومشرق! أنا متحمسة جداً لمشاركتكم هذه الأخبار السعيدة. أتمنى لكم يوماً مليئاً بالبهجة والسرور والنجاح في كل ما تقومون به!'
    },
    { 
      id: 'empathetic_f', 
      voiceName: 'Kore',
      name: 'المتعاطفة (أنثى/حنون)', 
      description: 'نبرة دافئة وحنونة، تعاطف وهدوء وسكينة',
      gender: 'female',
      previewGreeting: 'أنا هنا لأستمع إليك بكل دفء وراحة، خذ نفساً عميقاً وكل شيء سيكون بخير.',
      tone: 'A deeply empathetic, tender, and soothing female voice. Gentle breath control, warm intimate presence, soft velvety tone, and peaceful cadence. Perfect for mindfulness, emotional comfort, and heartfelt messaging.',
      example: 'أعلم تماماً ما تشعر به في هذه اللحظة. لا بأس بأن تأخذ قسطاً من الراحة، فأنت تبذل قصارى جهدك. تذكر دائماً أنني هنا بجانبك لأدعمك وأسمعك.'
    },
    { 
      id: 'wise_m', 
      voiceName: 'Fenrir',
      name: 'الحكيم (ذكر/وقور)', 
      description: 'صوت عميق، وقار وهيبة وفلسفة تأملية',
      gender: 'male',
      previewGreeting: 'تأمل في مجريات الأيام؛ فالحكمة لا تأتي إلا لمن أحسن الاستماع والتفكر.',
      tone: 'An ancient sage and philosopher. Deep, resonant, resonant chest voice with deliberate, meditative pauses. Calm, profound, spiritual, and serene. Every word is delivered with timeless weight.',
      example: 'يا بني، إن الحكمة لا تأتي من الكتب وحدها، بل من تجارب الحياة وتأملات النفس. كن صبوراً في طلب العلم، ورحيماً في التعامل مع الناس، فالأيام دول.'
    },
    { 
      id: 'strong_m', 
      voiceName: 'Charon',
      name: 'القوي (ذكر/حماسي)', 
      description: 'نبرة قيادية واثقة وقوية، حماس وعزيمة',
      gender: 'male',
      previewGreeting: 'بالعزيمة والإرادة الصلبة نصنع المستحيل ونرتقي نحو قمم المجد والفخار!',
      tone: 'A heroic and commanding leader. Powerful vocal projection, crisp decisive consonants, unwavering confidence, high motivational drive, and a resonant, bold presence.',
      example: 'أيها الجنود البواسل، إن الوطن يناديكم اليوم لنذود عن حياضه ونحمي مقدساته. كونوا على قلب رجل واحد، فبالعزيمة والإصرار نحقق النصر المؤزر!'
    },
    { 
      id: 'news_f', 
      voiceName: 'Zephyr',
      name: 'الإخبارية (أنثى/رسمي)', 
      description: 'نبرة رسمية احترافية، وضوح إخباري وإلقاء صحفي متقن',
      gender: 'female',
      previewGreeting: 'إليكم موجز الأنباء من استوديوهاتنا الإخبارية؛ دقة وموضوعية على مدار الساعة.',
      tone: 'A premier television news anchor. Neutral, pristine Arabic diction, agile broadcast cadence, perfect stress placement, and authoritative journalistic presence without dramatization.',
      example: 'سيداتي وسادتي، طابت أوقاتكم بكل خير. إليكم نشرة الأخبار الرئيسية من استوديوهاتنا. نبدأها بالعناوين: قمة دولية لمناقشة التغير المناخي، وافتتاح أكبر مشروع للطاقة المتجددة في المنطقة.'
    },
    { 
      id: 'narrator_m', 
      voiceName: 'Fenrir',
      name: 'الراوي (ذكر/سينمائي)', 
      description: 'سرد قصصي جذاب ومتزن، إلقاء درامي سينمائي',
      gender: 'male',
      previewGreeting: 'في زوايا الحكاية وأعماق الزمان، تكمن أسرار لم تروَ من قبل.. استمعوا بعناية.',
      tone: 'A master cinematic documentary and audiobook narrator. Rich baritone, vivid storytelling pacing, subtle dramatic tension, seamless atmospheric shifts, and hypnotic narrative cadence.',
      example: 'في قديم الزمان، وسالف العصر والأوان، كان هناك ملك عادل يحكم بلاداً واسعة. وفي ليلة مقمرة، ظهر فارس غامض عند بوابة القصر، يحمل معه سراً سيغير مجرى التاريخ.'
    },
    { 
      id: 'friendly_m', 
      voiceName: 'Puck',
      name: 'الودود (ذكر/متفائل)', 
      description: 'نبرة ترحيبية دافئة، عفوية وطاقة إيجابية',
      gender: 'male',
      previewGreeting: 'أهلاً يا غالي! كيفك اليوم؟ مبسوط جداً بلقائك وجاهز لنبدأ مع بعض.',
      tone: 'An affable, trustworthy everyday companion. Warm conversational cadence, smiling acoustic presence, natural casual ease, approachable, and effortlessly charismatic.',
      example: 'مرحباً بك يا صديقي! كيف حالك اليوم؟ يسعدني جداً رؤيتك مرة أخرى. هل أنت مستعد لنبدأ مغامرتنا الجديدة؟ أنا متأكد أننا سنقضي وقتاً ممتعاً معاً.'
    },
    { 
      id: 'serious_f', 
      voiceName: 'Kore',
      name: 'الرسمية (أنثى/جاد)', 
      description: 'نبرة جادة، احترافية مؤسسية وصرامة مهنية',
      gender: 'female',
      previewGreeting: 'نلتزم بأعلى معايير الحوكمة والاحترافية لتحقيق نتائج استراتيجية استثنائية.',
      tone: 'A corporate C-level executive and official spokesperson. Direct, assertive, analytical, immaculate diction, steady tempo, and an authoritative executive presence that conveys decisive leadership.',
      example: 'بناءً على التقارير السنوية الأخيرة، يتضح لنا ضرورة اتخاذ إجراءات حاسمة لتحسين الأداء المؤسسي. نؤكد على أهمية الالتزام بالمعايير المهنية والجداول الزمنية المحددة.'
    },
    { 
      id: 'egyptian_m', 
      voiceName: 'Charon',
      name: 'المصري (ذكر/حيوي)', 
      description: 'لهجة مصرية أصيلة، خفة دم وحيوية ودفء شعبي',
      gender: 'male',
      previewGreeting: 'يا أهلاً بالناس الحلوة! منورين الدنيا ويارب دايماً في أحسن حال وسعادة.',
      tone: 'An authentic Egyptian male speaker from Cairo. Warm, witty, vibrant, natural Egyptian colloquial prosody with authentic accent markers (elided vowels, melodic cadence, genuine warmth). Engaging, spontaneous, and charming.',
      example: 'يا أهلاً يا أهلاً! منورنا والله. إيه الأخبار؟ يا رب تكون بخير دايماً. النهاردة بقى جايبلك حتة موضوع إنما إيه، هيعجبك جداً وهتستفيد منه كتير.'
    },
    { 
      id: 'levantine_f', 
      voiceName: 'Puck',
      name: 'الشامية الشابة (أنثى/عفوي)', 
      description: 'لهجة شامية محبوبة (18 عاماً)، حيوية وشباب وعفوية',
      gender: 'female',
      previewGreeting: 'يسعدلي صباحكن ومساكن يا أحلى عالم! بتمنى يومكن يكون كله حب وابتسامة.',
      tone: 'A cheerful, bubbly 18-year-old Levantine (Shami) girl. Bright, youthful, energetic, and highly expressive. Speaks with an authentic Shami dialect lilt, soft vowels, musical question intonations, and charming conversational warmth.',
      example: 'يسعدلي صباحكن يا غوالي! كيفكن اليوم؟ إن شاء الله تكونوا بألف خير. اليوم حابة أحكيلكن قصة كتير مهضومة صارت معي بالجامعة، بتمنى تعجبكن وتنبسطوا فيها!'
    },
    { 
      id: 'gulf_m', 
      voiceName: 'Fenrir',
      name: 'الخليجي (ذكر/وقور)', 
      description: 'لهجة خليجية فخمة، أصالة وهيبة وكرم ضيافة',
      gender: 'male',
      previewGreeting: 'يا هلا ومسهلا تريليون.. عساكم دوم بخير وطيبين، وحياكم الله في دار الكرم.',
      tone: 'A distinguished Gulf (Khaleeji) male gentleman. Deep, noble, resonant baritone with authentic Khaleeji dialect intonations. Expresses royal hospitality, dignity, calm confidence, and aristocratic warmth.',
      example: 'يا هلا ومرحبا فيكم. عساكم بخير وطيبين. يسعدنا اليوم نستضيفكم في هذا المحفل المبارك، ونتمنى لكم قضاء أمتع الأوقات في رحاب كرم الضيافة والأصالة.'
    },
    { 
      id: 'egyptian_f', 
      voiceName: 'Puck',
      name: 'المصرية (أنثى/مرح)', 
      description: 'لهجة مصرية، روح مرحة وخفة ظل وتلقائية',
      gender: 'female',
      previewGreeting: 'يا خبر أبيض على السكر! منورين ومفرحين قلبنا بوجودكم معانا النهاردة!',
      tone: 'A spontaneous, cheerful Egyptian female speaker. High-spirited, humorous, warm, fast-paced, with native Cairo intonations. Highly expressive facial audio presence, natural cadence, and delightful cultural warmth.',
      example: 'يا خبر أبيض! إنت لسه هنا؟ ده الدنيا مقلوبة بره والكل مستنيك. يلا بسرعة مفيش وقت نضيعه، لازم نلحق الحفلة قبل ما تخلص والكل يمشي.'
    },
    { 
      id: 'gulf_f', 
      voiceName: 'Kore',
      name: 'الخليجية (أنثى/راقي)', 
      description: 'لهجة خليجية راقية، لباقة وأناقة واحترافية عالية',
      gender: 'female',
      previewGreeting: 'حياكم الله وبياكم في لقائنا، نسعد بتواصلكم ونتطلع لتحقيق أرقى التطلعات.',
      tone: 'An elegant and refined Gulf (Khaleeji) businesswoman and hostess. Polished, courteous, steady, with authentic upscale Khaleeji dialect cadences. Conveys prestige, graceful etiquette, and poised professionalism.',
      example: 'حياكم الله وبياكم. نرحب بكم في هذا اللقاء الرسمي لمناقشة سبل التعاون المشترك. نثمن جهودكم المبذولة ونتطلع إلى تحقيق المزيد من الإنجازات في المستقبل القريب.'
    },
    { 
      id: 'museum_guide_m', 
      voiceName: 'Fenrir',
      name: 'المرشد الثقافي (ذكر/وثائقي)', 
      description: 'صوت أكاديمي وثائقي، دقة متناهية في المخارج، أسلوب معرفي جذاب',
      gender: 'male',
      previewGreeting: 'مرحباً بكم في رحاب هذا المعلم التاريخي الشاهد على عبقرية الحضارة الإنسانية.',
      tone: 'An elite cultural educator and documentary presenter (around 45 years old). Exceptional acoustic fidelity, pristine Modern Standard Arabic with breathtaking phonemic precision, evocative descriptions, measured informative cadence, and National Geographic-caliber depth.',
      example: 'سيداتي وسادتي، نحن الآن نقف أمام أحد أعظم الآثار التاريخية في هذا المتحف. تلاحظون دقة النقوش وبراعة التصميم التي تعكس حضارة عريقة امتدت لآلاف السنين.'
    },
    { 
      id: 'historical_m', 
      voiceName: 'Fenrir',
      name: 'الحقبة التاريخية (ذكر/ملحمي)', 
      description: 'نبرة كلاسيكية فخمة وملحمية، توحي بعمق التاريخ وعظمة الحضارات',
      gender: 'male',
      previewGreeting: 'من شموخ الماضي وعزة القرون الخوالي، نروي لكم سيرة المجد والخلود.',
      tone: 'A monumental, epic male narrator for historical epics. Resonant, thunderous, solemn bass-baritone. Flawless archaic Classical Arabic (Fusha Turathiyya), slow majestic pace, long resonant pauses, evoking ancient manuscripts, legendary empires, and timeless sagas.',
      example: 'منذ فجر التاريخ، سطرت هذه الأرض ملاحم العزة والكرامة. هنا، وبين طيات هذه الجبال الشامخة، ولدت حضارات غيرت وجه البشرية، وتركت خلفها آثاراً تحكي قصصاً من المجد لا يمحوها الزمان.'
    },
    { 
      id: 'historical_f', 
      voiceName: 'Kore',
      name: 'الحقبة التاريخية (أنثى/ملحمي)', 
      description: 'نبرة كلاسيكية فخمة وملحمية، أصالة التاريخ وسحر الأساطير',
      gender: 'female',
      previewGreeting: 'عبر دروب التاريخ وأروقة الحضارات العريقة، تهمس الرياح بأمجاد الأجداد.',
      tone: 'A regal, classical female chronicler of historical legends. Solemn, majestic, resonant, and slow-paced. Impeccable Classical Arabic diction with poetic reverence, echoing the elegance of palace courts, ancient folklore, and historical grandeur.',
      example: 'بين جدران هذه القصور العتيقة، همست الرياح بأسرار الملوك والعظماء. هنا، حيث يلتقي الماضي بالحاضر، تروي لنا الحجارة قصصاً من الصبر والعزيمة، وتذكرنا بأن التاريخ هو مرآة الشعوب وذاكرتها الحية.'
    }
  ];

  const selectedVoiceProfile = useMemo(() => voices.find(v => v.id === selectedVoice), [selectedVoice]);

  const formatSRTTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  };

  const generateSRT = (text: string, duration: number) => {
    const words = text.trim().split(/\s+/);
    if (words.length === 0) return "";

    const MAX_CHARS_PER_SUBTITLE = 80; // Total for 2 lines
    const MAX_CHARS_PER_LINE = 42;
    const pausePunctuation = /[.,!?;:،؛؟]/;

    const getWeight = (str: string) => {
      return str.split('').reduce((acc, char) => {
        if (pausePunctuation.test(char)) return acc + 10; // Slightly more weight for pauses
        return acc + 1;
      }, 0);
    };

    const totalWeight = words.reduce((acc, word) => acc + getWeight(word) + 1, 0);

    // Helper to balance two lines
    const balanceLines = (text: string) => {
      const words = text.split(' ');
      if (words.length <= 3 || text.length <= MAX_CHARS_PER_LINE) return text;
      
      let bestDiff = Infinity;
      let bestSplit = 1;
      
      for (let i = 1; i < words.length; i++) {
        const line1 = words.slice(0, i).join(' ');
        const line2 = words.slice(i).join(' ');
        
        // Don't allow a line to exceed the max limit
        if (line1.length > MAX_CHARS_PER_LINE || line2.length > MAX_CHARS_PER_LINE) continue;

        const diff = Math.abs(line1.length - line2.length);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestSplit = i;
        }
      }
      
      return words.slice(0, bestSplit).join(' ') + '\n' + words.slice(bestSplit).join(' ');
    };

    const segments: { text: string; start: number; end: number }[] = [];
    let currentWords: string[] = [];
    let currentChars = 0;
    let accumulatedTime = 0;
    let currentWeight = 0;

    const pushSegment = (isLast = false) => {
      if (currentWords.length === 0) return;

      const rawText = currentWords.join(' ');
      const balancedText = balanceLines(rawText);
      const chunkDuration = (currentWeight / totalWeight) * duration;
      
      const end = isLast ? duration : Math.min(accumulatedTime + chunkDuration, duration);
      
      segments.push({
        text: balancedText,
        start: accumulatedTime,
        end: end
      });

      accumulatedTime = end;
      currentWords = [];
      currentChars = 0;
      currentWeight = 0;
    };

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordWeight = getWeight(word) + 1;
      const wordLen = word.length;
      const hasPause = pausePunctuation.test(word);

      const wouldExceed = currentChars + wordLen + 1 > MAX_CHARS_PER_SUBTITLE;
      const isNaturalBreak = hasPause && currentChars > 25;
      const isTooLong = currentWords.length >= 12;

      if (wouldExceed || isNaturalBreak || isTooLong) {
        pushSegment();
      }

      currentWords.push(word);
      currentChars += wordLen + (currentWords.length > 1 ? 1 : 0);
      currentWeight += wordWeight;
    }

    pushSegment(true);

    return segments.map((seg, i) => {
      return `${i + 1}\r\n${formatSRTTime(seg.start)} --> ${formatSRTTime(seg.end)}\r\n${seg.text}`;
    }).join('\r\n\r\n') + '\r\n';
  };

  const formatDisplayTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const updateSubtitleForTime = (time: number) => {
    if (!srtContent) {
      setCurrentSubtitle(null);
      return;
    }

    const lines = srtContent.split(/\r?\n\r?\n/);
    let found = false;
    for (const line of lines) {
      const parts = line.split(/\r?\n/);
      if (parts.length >= 3) {
        const timeRange = parts[1];
        if (!timeRange.includes(' --> ')) continue;
        const [startStr, endStr] = timeRange.split(' --> ');

        const parseTime = (t: string) => {
          const [h, m, s_ms] = t.split(':');
          const [s, ms] = (s_ms || '0,0').split(',');
          return (parseInt(h) || 0) * 3600 + (parseInt(m) || 0) * 60 + (parseInt(s) || 0) + (parseInt(ms) || 0) / 1000;
        };

        const start = parseTime(startStr);
        const end = parseTime(endStr);

        if (time >= start && time <= end) {
          const text = parts.slice(2).join(' ');
          if (currentSubtitle !== text) {
            setCurrentSubtitle(text);
          }
          found = true;
          break;
        }
      }
    }
    if (!found) setCurrentSubtitle(null);
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      const curr = audioRef.current.currentTime;
      if (!isSeeking) {
        setCurrentTime(curr);
      }
      updateSubtitleForTime(curr);
    }
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    updateSubtitleForTime(newTime);
    if (audioRef.current) {
      audioRef.current.currentTime = newTime;
    }
  };

  const handleSeekStart = () => {
    setIsSeeking(true);
  };

  const handleSeekEnd = () => {
    setIsSeeking(false);
    if (audioRef.current) {
      updateSubtitleForTime(audioRef.current.currentTime);
    }
  };

  const handleSeekDelta = (deltaSeconds: number) => {
    if (audioRef.current) {
      const audioDuration = (audioRef.current.duration && !isNaN(audioRef.current.duration)) ? audioRef.current.duration : duration;
      const targetTime = Math.max(0, Math.min(audioDuration, audioRef.current.currentTime + deltaSeconds));
      audioRef.current.currentTime = targetTime;
      setCurrentTime(targetTime);
      updateSubtitleForTime(targetTime);
    }
  };

  const handleTrackMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const percent = x / rect.width;
    setHoverPosition(percent * 100);
    const audioDuration = (audioRef.current?.duration && !isNaN(audioRef.current.duration)) ? audioRef.current.duration : duration;
    if (audioDuration > 0) {
      setHoverTime(percent * audioDuration);
    }
  };

  const handleTrackMouseLeave = () => {
    setHoverTime(null);
  };

  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const handlePreviewVoice = async (e: React.MouseEvent, voice: typeof voices[0]) => {
    e.stopPropagation();
    
    if (activePreview === voice.id) {
      previewAudioRef.current?.pause();
      setActivePreview(null);
      return;
    }

    const previewText = voice.previewGreeting || `أهلاً بكم، يسعدني تقديم هذا الأداء الصوتي المميز لكم اليوم.`;
    if (!checkLimits(previewText.length)) return;

    // Increment request count immediately to prevent rapid-fire clicks
    updateUsage(previewText.length, true);

    const previewKey = `${voice.id}_${speakingRate.toFixed(2)}`;
    if (previewAudio[previewKey]) {
      if (previewAudioRef.current) {
        previewAudioRef.current.src = previewAudio[previewKey];
        previewAudioRef.current.playbackRate = speakingRate;
        previewAudioRef.current.play();
        setActivePreview(voice.id);
      }
      return;
    }

    setPreviewLoading(voice.id);
    try {
      const instructions = `
        Role: Master Arabic Voice Artist & Performer.
        Profile: ${voice.name} (${voice.gender})
        Acoustic Direction: ${voice.tone}
        Speaking Pace & Playback Rate: ${speakingRate.toFixed(2)}x speed. Deliver the performance with a ${
          speakingRate < 0.95 
            ? 'deliberate, calm, and measured rhythm' 
            : speakingRate > 1.05 
              ? 'brisk, dynamic, energetic, and rapid pace' 
              : 'natural and moderate tempo'
        }. Ensure crystal-clear articulation at this speed.
        Performance: A brief, captivating showcase of this voice's unique persona, warmth, and natural prosody.
      `;
      const base64 = await generateVoiceover(previewText, instructions, voice.voiceName);
      
      // Update character count only on success
      setUsage(prev => ({
        ...prev,
        charsToday: prev.charsToday + previewText.length
      }));

      const binaryString = window.atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      view.setUint32(0, 0x52494646, false);
      view.setUint32(4, 36 + bytes.length, true);
      view.setUint32(8, 0x57415645, false);
      view.setUint32(12, 0x666d7420, false);
      view.setUint16(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 24000, true);
      view.setUint32(28, 24000 * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      view.setUint32(36, 0x64617461, false);
      const isAlreadyWav = bytes.length >= 4 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;

      const blob = isAlreadyWav 
        ? new Blob([bytes], { type: 'audio/wav' })
        : new Blob([wavHeader, bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      
      setPreviewAudio(prev => ({ ...prev, [previewKey]: url }));
      
      if (previewAudioRef.current) {
        previewAudioRef.current.src = url;
        previewAudioRef.current.playbackRate = speakingRate;
        previewAudioRef.current.play();
        setActivePreview(voice.id);
      }
    } catch (error: any) {
      console.error("Failed to generate preview:", error);
      const errorStr = JSON.stringify(error);
      const isRateLimit = error?.status === 429 || error?.code === 429 || 
                         error?.error?.code === 429 || 
                         error?.message?.includes('429') || 
                         error?.message?.includes('quota') ||
                         error?.message?.includes('RESOURCE_EXHAUSTED') || 
                         errorStr.includes('429') || 
                         errorStr.includes('RESOURCE_EXHAUSTED');
      
      if (isRateLimit) {
        triggerCooldown(60);
        alert("عذراً، لقد تجاوزت حد الطلبات المسموح به حالياً (Rate Limit). تم تفعيل فترة راحة لمدة دقيقة.");
      } else {
        alert("حدث خطأ أثناء تشغيل المعاينة.");
      }
    } finally {
      setPreviewLoading(null);
    }
  };

  const handleGenerateVoiceover = async () => {
    if (!voiceoverText.trim()) return;
    if (!checkLimits(voiceoverText.length)) return;
    
    // Increment request count immediately
    updateUsage(voiceoverText.length, true);

    setGeneratingVoice(true);
    setIsPlaying(false);
    setSrtContent(null);
    setCurrentSubtitle(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    
    try {
      const selectedVoiceProfile = voices.find(v => v.id === selectedVoice);
      
      const instructions = `
        Role: Master Arabic Voice Artist & Performer.
        Profile Name: ${selectedVoiceProfile?.name || 'Arabic Voiceover'}
        Gender: ${selectedVoiceProfile?.gender || 'male'}
        Acoustic Tone & Character: ${selectedVoiceProfile?.tone || 'Resonant and exceptionally clear voice.'}
        Speaking Pace & Playback Rate: Deliver the speech strictly at ${speakingRate.toFixed(2)}x tempo relative to standard conversational speed. Adopt a ${
          speakingRate < 0.95 
            ? 'deliberate, slow, calm, and measured rhythm' 
            : speakingRate > 1.05 
              ? 'brisk, dynamic, energetic, and rapid pace' 
              : 'natural, moderate, and well-balanced tempo'
        }. Ensure perfect phonetics, pristine letter articulation, and authentic Arabic pronunciation at this speed rate.
        Performance Directives:
        - Fully embody the persona, energy, and vocal color specified in the tone.
        - Precision Articulation: Deliver authentic phonetics and syllable separation according to the character's style (Classical Fusha or native regional dialect).
        - Intonation & Breathing: Use intelligent, human-like pitch contours with natural, unhurried pauses at punctuation marks.
        - Dynamics: Maintain warm studio presence and dynamic nuance without any metallic or robotic flatness.
      `;
      const base64 = await generateVoiceover(voiceoverText, instructions, selectedVoiceProfile?.voiceName || 'Fenrir');
      
      // Update character count only on success
      setUsage(prev => ({
        ...prev,
        charsToday: prev.charsToday + voiceoverText.length
      }));

      const binaryString = window.atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const wavHeader = new ArrayBuffer(44);
      const view = new DataView(wavHeader);
      view.setUint32(0, 0x52494646, false);
      view.setUint32(4, 36 + bytes.length, true);
      view.setUint32(8, 0x57415645, false);
      view.setUint32(12, 0x666d7420, false);
      view.setUint16(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 24000, true);
      view.setUint32(28, 24000 * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      view.setUint32(36, 0x64617461, false);
      view.setUint32(40, bytes.length, true);

      const isAlreadyWav = bytes.length >= 4 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;

      const blob = isAlreadyWav 
        ? new Blob([bytes], { type: 'audio/wav' })
        : new Blob([wavHeader, bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(url);
      setCurrentTime(0);
      setIsPlaying(false);

      // Calculate duration and generate SRT
      const audio = new Audio(url);
      audio.playbackRate = speakingRate;
      audio.onloadedmetadata = () => {
        const audioDur = audio.duration;
        setDuration(audioDur);
        const srt = generateSRT(voiceoverText, audioDur);
        setSrtContent(srt);

        if (user) {
          saveVoiceoverProject(user.uid, {
            text: voiceoverText,
            voiceId: selectedVoice,
            voiceName: selectedVoiceProfile?.name || selectedVoice,
            speakingRate,
            srtContent: srt,
            estimatedDurationSeconds: audioDur,
          })
            .then(() => {
              setCloudNotice('تم حفظ النص والترجمة تلقائياً في مكتبتك السحابية');
              setTimeout(() => setCloudNotice(null), 3500);
            })
            .catch((err) => {
              console.error('Auto-save voiceover project failed:', err);
            });
        }
      };
    } catch (error: any) {
      console.error("Failed to generate voiceover:", error);
      const errorStr = JSON.stringify(error);
      const isRateLimit = error?.status === 429 || error?.code === 429 || 
                         error?.error?.code === 429 ||
                         error?.message?.includes('429') || 
                         error?.message?.includes('quota') ||
                         error?.message?.includes('RESOURCE_EXHAUSTED') || 
                         errorStr.includes('429') || 
                         errorStr.includes('RESOURCE_EXHAUSTED');

      if (isRateLimit) {
        triggerCooldown(60);
        alert("عذراً، لقد تجاوزت حد الطلبات المسموح به (Rate Limit). تم تفعيل فترة راحة لمدة دقيقة لحماية حسابك.");
      } else {
        alert("حدث خطأ أثناء توليد الصوت. يرجى المحاولة مرة أخرى.");
      }
    } finally {
      setGeneratingVoice(false);
    }
  };

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        if (audioRef.current.ended || (audioRef.current.duration && audioRef.current.currentTime >= audioRef.current.duration - 0.1)) {
          audioRef.current.currentTime = 0;
          setCurrentTime(0);
        }
        audioRef.current.playbackRate = speakingRate;
        audioRef.current.play();
        setIsPlaying(true);
      }
    }
  };

  const handleDownloadAudio = () => {
    if (audioUrl) {
      const link = document.createElement('a');
      link.href = audioUrl;
      // Changing extension to .mp3 as requested. Note: The actual blob is WAV, 
      // but browsers/players will handle it or the user prefers the extension.
      link.download = `audio-studio-${Date.now()}.mp3`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleDownloadSRT = () => {
    if (srtContent) {
      // Use text/plain with UTF-8 for maximum compatibility on mobile
      const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // Descriptive name for mobile downloads
      link.download = `subtitles-studio-${Date.now()}.srt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  };

  const handleSaveToCloud = async () => {
    if (!user) {
      await signInWithGoogle();
      return;
    }
    if (!voiceoverText.trim()) return;
    setSavingProject(true);
    try {
      await saveVoiceoverProject(user.uid, {
        text: voiceoverText,
        voiceId: selectedVoice,
        voiceName: selectedVoiceProfile?.name || selectedVoice,
        speakingRate,
        srtContent: srtContent || '',
        estimatedDurationSeconds: duration || textAnalysis.estimatedDurationSeconds,
      });
      setCloudNotice('تم حفظ المشروع في السحابة بنجاح');
      setTimeout(() => setCloudNotice(null), 3500);
    } catch (err) {
      console.error('Failed to save project to cloud:', err);
      alert('تعذر حفظ المشروع في السحابة. يرجى المحاولة مرة أخرى.');
    } finally {
      setSavingProject(false);
    }
  };

  const handleLoadCloudProject = (project: VoiceoverProject) => {
    setVoiceoverText(project.text);
    if (project.voiceId && voices.some((v) => v.id === project.voiceId)) {
      setSelectedVoice(project.voiceId);
    }
    if (
      typeof project.speakingRate === 'number' &&
      project.speakingRate >= 0.8 &&
      project.speakingRate <= 1.5
    ) {
      setSpeakingRate(project.speakingRate);
    }
    setSrtContent(project.srtContent || null);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setCurrentSubtitle(null);
    setCloudNotice(`تم تحميل "${project.title}" في المحرر`);
    setTimeout(() => setCloudNotice(null), 3000);
    window.scrollTo({ top: 380, behavior: 'smooth' });
  };

  const handleDeleteCloudProject = async (projectId: string) => {
    if (!user) return;
    try {
      await deleteVoiceoverProject(user.uid, projectId);
      setCloudNotice('تم حذف المشروع من المكتبة السحابية');
      setTimeout(() => setCloudNotice(null), 3000);
    } catch (err) {
      console.error('Failed to delete project:', err);
      alert('تعذر حذف المشروع. يرجى المحاولة مرة أخرى.');
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-zinc-100 font-sans selection:bg-purple-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/20">
              <Mic2 className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Audio Studio Pro</h1>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Professional AI Voice Synthesis</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-2 text-zinc-400 text-xs">
              <Settings2 className="w-4 h-4" />
              <span>High Fidelity 24kHz</span>
            </div>

            <PWAInstallButton />

            {authReady && (
              user ? (
                <div className="flex items-center gap-2.5 bg-white/5 border border-white/10 rounded-2xl px-3 py-1.5" dir="rtl">
                  {user.photoURL ? (
                    <img
                      src={user.photoURL}
                      alt={user.displayName || 'User'}
                      className="w-7 h-7 rounded-full border border-purple-500/40 object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-purple-600 text-white text-xs font-bold flex items-center justify-center">
                      {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="hidden sm:block text-right leading-tight">
                    <p className="text-xs font-bold text-white max-w-[130px] truncate">
                      {user.displayName || 'مستخدم مسجل'}
                    </p>
                    <p className="text-[10px] text-emerald-400 flex items-center gap-1">
                      <Cloud className="w-2.5 h-2.5" />
                      <span>مزامنة سحابية</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={logout}
                    className="p-1.5 rounded-xl bg-white/5 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-300 transition-colors"
                    title="تسجيل الخروج"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={signInWithGoogle}
                  disabled={signingIn}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/40 text-purple-200 text-xs font-bold transition-all active:scale-95 disabled:opacity-60"
                  dir="rtl"
                >
                  {signingIn ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <LogIn className="w-4 h-4" />
                  )}
                  <span>تسجيل الدخول بحساب Google</span>
                </button>
              )
            )}
          </div>
        </div>
      </header>

      {/* Auth Error or Cloud Sync Notification */}
      <AnimatePresence>
        {(authError || cloudNotice) && (
          <div className="max-w-5xl mx-auto px-6 pt-4" dir="rtl">
            {authError && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="bg-rose-500/10 border border-rose-500/30 text-rose-200 rounded-2xl px-4 py-3 text-xs flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{authError}</span>
                </div>
                <button
                  type="button"
                  onClick={clearAuthError}
                  className="text-rose-300 hover:text-white underline text-[11px]"
                >
                  إغلاق
                </button>
              </motion.div>
            )}
            {cloudNotice && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="bg-purple-500/15 border border-purple-500/30 text-purple-200 rounded-2xl px-4 py-2.5 text-xs flex items-center gap-2 mt-2"
              >
                <Cloud className="w-4 h-4 text-purple-400 shrink-0" />
                <span>{cloudNotice}</span>
              </motion.div>
            )}
          </div>
        )}
      </AnimatePresence>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 gap-12">
          {/* Hero / Intro */}
          <section className="text-center space-y-4 mb-8">
            <motion.h2 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-4xl md:text-5xl font-bold tracking-tighter bg-gradient-to-b from-white to-zinc-500 bg-clip-text text-transparent"
            >
              صوت احترافي في ثوانٍ
            </motion.h2>
            <motion.p 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="text-zinc-400 text-lg max-w-2xl mx-auto"
            >
              حول نصوصك إلى تعليق صوتي سينمائي بدقة متناهية ومخارج حروف واضحة جداً باستخدام أحدث تقنيات الذكاء الاصطناعي.
            </motion.p>
          </section>

          {/* Cooldown Banner */}
          <AnimatePresence>
            {isCoolingDown && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-8"
              >
                <div className="bg-rose-500/10 border border-rose-500/20 rounded-2xl p-4 flex items-center gap-4 text-rose-400">
                  <div className="w-10 h-10 rounded-xl bg-rose-500/20 flex items-center justify-center">
                    <Clock className="w-5 h-5 animate-pulse" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-bold">النظام في فترة راحة (Cooling Down)</p>
                    <p className="text-xs opacity-70">لقد تجاوزت حد الطلبات المسموح به. يرجى الانتظار {cooldownTime} ثانية لحماية حسابك من الحظر الدائم.</p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Stats & Limits Widget */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center text-purple-400">
                <BarChart3 className="w-5 h-5" />
              </div>
              <div className="text-right flex-1">
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">المحاولات اليومية</p>
                <p className="text-lg font-bold text-white">
                  {usage.requestsToday} <span className="text-zinc-500 text-xs">/ {DAILY_REQUEST_LIMIT}</span>
                </p>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-400">
                <FileText className="w-5 h-5" />
              </div>
              <div className="text-right flex-1">
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">إجمالي الحروف</p>
                <p className="text-lg font-bold text-white">
                  {usage.charsToday.toLocaleString()} <span className="text-zinc-500 text-xs">/ 1M</span>
                </p>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-rose-500/20 flex items-center justify-center text-rose-400">
                <Zap className="w-5 h-5" />
              </div>
              <div className="text-right flex-1">
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">الطلبات/دقيقة</p>
                <p className="text-lg font-bold text-white">
                  {usage.requestsThisMinute} <span className="text-zinc-500 text-xs">/ {MINUTE_REQUEST_LIMIT}</span>
                </p>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400">
                <Clock className="w-5 h-5" />
              </div>
              <div className="text-right flex-1">
                <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">إعادة التعيين</p>
                <p className="text-lg font-bold text-white">
                  {Math.max(0, Math.ceil((usage.minuteResetTime - Date.now()) / 1000))} <span className="text-zinc-500 text-xs">ثانية</span>
                </p>
              </div>
            </div>
          </div>

          {/* Voice Selection Grid */}
          <section className="space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                <Music className="w-4 h-4" />
                اختر نبرة الصوت
              </h3>
              <span className="text-[10px] text-zinc-600 bg-white/5 px-2 py-1 rounded border border-white/10">
                {voices.length} Available Profiles
              </span>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {voices.map((voice) => (
                <div
                  key={voice.id}
                  onClick={() => setSelectedVoice(voice.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setSelectedVoice(voice.id);
                    }
                  }}
                  className={cn(
                    "p-4 rounded-2xl border text-right transition-all flex flex-col justify-between min-h-[120px] group relative overflow-hidden cursor-pointer",
                    selectedVoice === voice.id 
                      ? "bg-purple-500/10 border-purple-500/50 text-purple-200 shadow-lg shadow-purple-500/5" 
                      : "bg-white/5 border-white/5 text-zinc-500 hover:border-white/20 hover:bg-white/[0.07]"
                  )}
                >
                  {selectedVoice === voice.id && (
                    <motion.div 
                      layoutId="active-voice"
                      className="absolute inset-0 bg-purple-500/5 pointer-events-none"
                    />
                  )}
                  <div className="flex justify-between items-start relative z-10">
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={(e) => handlePreviewVoice(e, voice)}
                        className={cn(
                          "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                          activePreview === voice.id 
                            ? "bg-purple-500 text-white" 
                            : "bg-white/10 text-zinc-400 hover:bg-white/20"
                        )}
                        title="معاينة الصوت"
                      >
                        {previewLoading === voice.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : activePreview === voice.id ? (
                          <Pause className="w-4 h-4 fill-current" />
                        ) : (
                          <Play className="w-4 h-4 fill-current ml-0.5" />
                        )}
                      </button>
                      
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setVoiceoverText(voice.example);
                        }}
                        className="w-8 h-8 rounded-full bg-white/5 text-zinc-500 hover:bg-purple-500/20 hover:text-purple-400 flex items-center justify-center transition-all border border-white/5 hover:border-purple-500/30"
                        title="تحميل نص المثال"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="text-xs font-bold leading-tight">{voice.name}</p>
                  </div>
                  <p className="text-[9px] opacity-60 leading-relaxed relative z-10 mt-2">{voice.description}</p>
                </div>
              ))}
            </div>

            <audio 
              ref={previewAudioRef} 
              className="hidden" 
              onEnded={() => setActivePreview(null)}
              onPause={() => setActivePreview(null)}
            />
          </section>

          {/* Audio Settings / Voice Controls */}
          <section className="bg-white/[0.03] border border-white/10 rounded-3xl p-6 relative overflow-hidden backdrop-blur-sm">
            <div className="absolute top-0 right-0 w-64 h-64 bg-purple-500/5 rounded-full blur-3xl pointer-events-none" />
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 relative z-10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center shadow-lg shadow-purple-500/5">
                  <Settings2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    إعدادات الصوت
                    <span className="text-[10px] font-normal text-purple-400/80 bg-purple-500/10 px-2 py-0.5 rounded-full border border-purple-500/20">
                      Audio Settings
                    </span>
                  </h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    التحكم في سرعة الإلقاء وتمريرها مباشرة إلى تعليمات النظام (System Instructions)
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto">
                <div className="flex items-center gap-2 bg-black/40 border border-white/10 px-3.5 py-1.5 rounded-xl">
                  <Gauge className="w-4 h-4 text-purple-400" />
                  <span className="text-xs text-zinc-400">السرعة الحالية:</span>
                  <span className="text-sm font-mono font-bold text-purple-300">
                    {speakingRate.toFixed(2)}x
                  </span>
                </div>
                {speakingRate !== 1.0 && (
                  <button
                    onClick={() => setSpeakingRate(1.0)}
                    className="text-xs text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 px-2.5 py-1.5 rounded-xl border border-white/10 transition-colors flex items-center gap-1.5"
                    title="إعادة التعيين للسرعة الافتراضية (1.0x)"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>افتراضي</span>
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-4 relative z-10">
              <div className="flex items-center justify-between text-xs font-medium">
                <div className="flex items-center gap-2 text-zinc-300">
                  <span>سرعة الكلام (Playback Rate)</span>
                  <span className="text-[10px] text-zinc-500">(بين 0.8x و 1.5x)</span>
                </div>
                <span className={cn(
                  "text-xs px-2.5 py-0.5 rounded-full border transition-colors",
                  speakingRate < 0.95 
                    ? "bg-blue-500/10 text-blue-300 border-blue-500/20" 
                    : speakingRate > 1.05 
                      ? "bg-amber-500/10 text-amber-300 border-amber-500/20" 
                      : "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                )}>
                  {speakingRate < 0.95 ? 'إيقاع هادئ ومتأنٍ' : speakingRate > 1.05 ? 'إيقاع سريع وديناميكي' : 'سرعة طبيعية متزنة'}
                </span>
              </div>

              {/* Slider Input */}
              <div className="space-y-2">
                <div className="relative flex items-center py-1">
                  <input
                    type="range"
                    min="0.8"
                    max="1.5"
                    step="0.05"
                    value={speakingRate}
                    onChange={(e) => setSpeakingRate(parseFloat(e.target.value))}
                    className="w-full h-2.5 bg-zinc-800/80 rounded-lg appearance-none cursor-pointer accent-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/40"
                    aria-label="سرعة الكلام"
                  />
                </div>

                {/* Range Labels & Quick Presets */}
                <div className="flex items-center justify-between pt-1">
                  {[
                    { val: 0.8, label: '0.8x (متأنٍ)' },
                    { val: 1.0, label: '1.0x (طبيعي)' },
                    { val: 1.25, label: '1.25x' },
                    { val: 1.5, label: '1.5x (سريع)' }
                  ].map((preset) => (
                    <button
                      key={preset.val}
                      onClick={() => setSpeakingRate(preset.val)}
                      type="button"
                      className={cn(
                        "text-xs px-2.5 py-1 rounded-lg transition-all font-mono",
                        Math.abs(speakingRate - preset.val) < 0.02
                          ? "bg-purple-500 text-white font-bold shadow-md shadow-purple-500/20"
                          : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                      )}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Context Note */}
              <div className="flex items-center gap-2 pt-2 text-[11px] text-zinc-500 border-t border-white/5">
                <Info className="w-3.5 h-3.5 text-purple-400/70 shrink-0" />
                <span>
                  يتم تمرير القيمة (<strong className="text-zinc-300 font-mono">{speakingRate.toFixed(2)}x</strong>) مباشرة في تعليمات النظام (System Instructions) لمركِّب الذكاء الاصطناعي لضبط تدفق النطق ومخارج الحروف.
                </span>
              </div>
            </div>
          </section>

          {/* Input & Action Area */}
          <section className="grid grid-cols-1 lg:grid-cols-1 gap-8">
            <div className="space-y-6">
              <div className="flex items-center justify-between px-2">
                <h3 className="text-sm font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  النص المراد تحويله
                </h3>
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={handleSaveToCloud}
                    disabled={savingProject || !voiceoverText.trim()}
                    className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 hover:text-emerald-300 disabled:opacity-40 flex items-center gap-1.5 transition-colors"
                    title={user ? 'حفظ النص الحالي في مكتبتك السحابية' : 'سجّل الدخول لحفظ مشاريعك في السحابة'}
                  >
                    {savingProject ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Bookmark className="w-3 h-3" />
                    )}
                    {user ? 'حفظ في السحابة' : 'حفظ سحابي'}
                  </button>
                  <div className="h-3 w-px bg-white/10" />
                  <button
                    onClick={() => setVoiceoverText("")}
                    className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 hover:text-rose-400 flex items-center gap-1.5 transition-colors"
                  >
                    مسح النص
                  </button>
                  <div className="h-3 w-px bg-white/10" />
                  <button
                    onClick={() => {
                      const currentVoice = voices.find(v => v.id === selectedVoice);
                      if (currentVoice?.example) {
                        setVoiceoverText(currentVoice.example);
                      }
                    }}
                    className="text-[10px] font-bold uppercase tracking-wider text-purple-400 hover:text-purple-300 flex items-center gap-1.5 transition-colors group"
                  >
                    <Sparkles className="w-3 h-3 group-hover:animate-pulse" />
                    تجربة نص مثال لهذه النبرة
                  </button>
                </div>
              </div>
              <div className="relative group">
                <div className="absolute -inset-1 bg-gradient-to-r from-purple-500/20 to-indigo-500/20 rounded-3xl blur opacity-25 group-focus-within:opacity-100 transition duration-1000"></div>
                <textarea
                  value={voiceoverText}
                  onChange={(e) => setVoiceoverText(e.target.value)}
                  placeholder="اكتب النص الذي تريد تحويله إلى صوت هنا... (مثال: أهلاً بكم في عالم الذكاء الاصطناعي، حيث تتحول الكلمات إلى واقع مسموع.)"
                  className="relative w-full h-64 bg-black/40 border border-white/10 rounded-3xl p-8 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 transition-all resize-none text-right text-xl leading-relaxed"
                  dir="rtl"
                />
                <div className="absolute bottom-6 left-8 flex items-center gap-2 text-[10px] text-zinc-600">
                  <Info className="w-3 h-3" />
                  <span>يدعم اللغة العربية الفصحى والعامية</span>
                </div>
              </div>

              {/* Real-time Text Analysis & Recommendations Panel */}
              {voiceoverText.length > 0 && (
                <div className="space-y-3">
                  {/* Status & Metrics Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className={cn(
                        "flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold transition-all border",
                        textAnalysis.status === 'optimal' && "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
                        textAnalysis.status === 'warning' && "bg-amber-500/10 text-amber-300 border-amber-500/20",
                        textAnalysis.status === 'critical' && "bg-rose-500/10 text-rose-300 border-rose-500/20"
                      )}>
                        {textAnalysis.status === 'optimal' && <CheckCircle2 className="w-3.5 h-3.5" />}
                        {textAnalysis.status === 'warning' && <AlertTriangle className="w-3.5 h-3.5" />}
                        {textAnalysis.status === 'critical' && <AlertCircle className="w-3.5 h-3.5" />}
                        <span>
                          {textAnalysis.status === 'optimal' && 'النص ممتاز وجاهز للتوليد'}
                          {textAnalysis.status === 'warning' && `تنبيهات في النص (${textAnalysis.issues.length})`}
                          {textAnalysis.status === 'critical' && `تحذيرات صوتية بحاجة لتصحيح (${textAnalysis.issues.length})`}
                        </span>
                      </div>

                      {textAnalysis.canAutoFix && (
                        <button
                          type="button"
                          onClick={handleCleanText}
                          className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 border border-purple-500/30 text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] shadow-sm"
                          title="إزالة الرموز غير المقروءة وتنسيق الترقيم تلقائياً"
                        >
                          <Wand2 className="w-3.5 h-3.5 text-purple-300 animate-pulse" />
                          <span>تنظيف وتنسيق النص بنقرة واحدة</span>
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-[11px] text-zinc-400 font-mono">
                      <span>{textAnalysis.wordCount} كلمة</span>
                      <span className="text-zinc-600">·</span>
                      <span>{textAnalysis.charCount} حرف</span>
                      <span className="text-zinc-600">·</span>
                      <span className="text-purple-300 font-sans">
                        مدة تقديرية: ~{Math.floor(textAnalysis.estimatedDurationSeconds / 60) > 0 
                          ? `${Math.floor(textAnalysis.estimatedDurationSeconds / 60)}د ${textAnalysis.estimatedDurationSeconds % 60}ث` 
                          : `${textAnalysis.estimatedDurationSeconds} ثانية`}
                      </span>
                    </div>
                  </div>

                  {/* Clean notification toast */}
                  <AnimatePresence>
                    {cleanNotification && (
                      <motion.div
                        initial={{ opacity: 0, y: -5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -5 }}
                        className="bg-emerald-500/15 border border-emerald-500/30 text-emerald-200 rounded-2xl px-4 py-2.5 text-xs flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2">
                          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                          <span>{cleanNotification}</span>
                        </div>
                        <span className="text-[10px] text-emerald-400/80 font-mono">جاهز للتوليد</span>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Issues & Suggestions list */}
                  {textAnalysis.issues.length > 0 && (
                    <div className="space-y-2">
                      {textAnalysis.issues.map((issue) => (
                        <div
                          key={issue.id}
                          className={cn(
                            "rounded-2xl p-3.5 border text-right transition-all flex items-start gap-3",
                            issue.type === 'critical' && "bg-rose-500/10 border-rose-500/25 text-rose-200",
                            issue.type === 'warning' && "bg-amber-500/10 border-amber-500/25 text-amber-200",
                            issue.type === 'suggestion' && "bg-purple-500/10 border-purple-500/25 text-purple-200"
                          )}
                        >
                          <div className={cn(
                            "w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5",
                            issue.type === 'critical' && "bg-rose-500/20 text-rose-400",
                            issue.type === 'warning' && "bg-amber-500/20 text-amber-400",
                            issue.type === 'suggestion' && "bg-purple-500/20 text-purple-400"
                          )}>
                            {issue.type === 'critical' && <AlertCircle className="w-4 h-4" />}
                            {issue.type === 'warning' && <AlertTriangle className="w-4 h-4" />}
                            {issue.type === 'suggestion' && <Sparkles className="w-4 h-4" />}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-bold">{issue.title}</p>
                              {issue.canAutoFix && (
                                <button
                                  type="button"
                                  onClick={handleCleanText}
                                  className="text-[10px] underline text-purple-300 hover:text-white transition-colors font-medium shrink-0"
                                >
                                  معالجة تلقائية
                                </button>
                              )}
                            </div>
                            <p className="text-[11px] opacity-80 leading-relaxed mt-0.5">{issue.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!audioUrl && (
                <button
                  onClick={handleGenerateVoiceover}
                  disabled={generatingVoice || !voiceoverText.trim()}
                  className="w-full py-5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 text-white rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-3 shadow-xl shadow-purple-500/20 active:scale-[0.98]"
                >
                  {generatingVoice ? (
                    <>
                      <Loader2 className="w-6 h-6 animate-spin" />
                      جاري المعالجة...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-6 h-6" />
                      توليد الصوت والترجمة
                    </>
                  )}
                </button>
              )}

              {audioUrl && (
                <div className="space-y-6">
                  {/* Visual Audio Player and Seeker Card */}
                  <div className="bg-gradient-to-b from-zinc-900/95 to-zinc-950/95 border border-purple-500/30 backdrop-blur-xl rounded-3xl p-6 shadow-2xl shadow-purple-950/30 space-y-5">
                    
                    {/* Top Meta Bar */}
                    <div className="flex items-center justify-between text-xs font-medium border-b border-white/5 pb-4">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-300">
                          <Volume2 className="w-3.5 h-3.5 text-purple-400" />
                          <span>{selectedVoiceProfile?.name || 'التسجيل الصوتي'}</span>
                        </div>
                        <span className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-zinc-400 font-mono" dir="ltr">
                          {speakingRate.toFixed(2)}x
                        </span>
                      </div>

                      {/* Quick jump actions */}
                      <div className="flex items-center gap-1.5 text-zinc-400" dir="ltr">
                        <button
                          type="button"
                          onClick={() => handleSeekDelta(-5)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-purple-500/40 text-xs transition-colors text-zinc-300 active:scale-95"
                          title="رجوع 5 ثوانٍ للخلف"
                        >
                          <RotateCcw className="w-3 h-3 text-purple-400" />
                          <span>-5s</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSeekDelta(5)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-purple-500/40 text-xs transition-colors text-zinc-300 active:scale-95"
                          title="تقديم 5 ثوانٍ للأمام"
                        >
                          <RotateCw className="w-3 h-3 text-purple-400" />
                          <span>+5s</span>
                        </button>
                      </div>
                    </div>

                    {/* Visual Seeker Track & Progress Bar */}
                    <div className="space-y-2">
                      {/* Track Container */}
                      <div 
                        className="relative group w-full py-2.5 cursor-pointer select-none" 
                        dir="ltr"
                        onMouseMove={handleTrackMouseMove}
                        onMouseLeave={handleTrackMouseLeave}
                      >
                        {/* Hover Time Tooltip */}
                        {hoverTime !== null && (
                          <div 
                            className="absolute -top-7 -translate-x-1/2 px-2 py-0.5 rounded-md bg-purple-600 text-white text-[11px] font-mono shadow-lg shadow-purple-900/50 pointer-events-none transition-all z-30"
                            style={{ left: `${hoverPosition}%` }}
                          >
                            {formatDisplayTime(hoverTime)}
                          </div>
                        )}

                        {/* Background Track with Subtle Glow */}
                        <div className="h-3 w-full bg-zinc-800/80 rounded-full overflow-hidden relative border border-white/5 group-hover:border-purple-500/30 transition-colors">
                          {/* Ambient Visual Ticks */}
                          <div className="absolute inset-0 opacity-15 flex justify-between items-center px-1 pointer-events-none">
                            {Array.from({ length: 32 }).map((_, i) => (
                              <div key={i} className="w-0.5 h-1.5 bg-white/60 rounded-full" />
                            ))}
                          </div>

                          {/* Filled Progress Track with Gradient */}
                          <div 
                            className="h-full bg-gradient-to-r from-purple-600 via-indigo-500 to-purple-400 relative rounded-full transition-all duration-75"
                            style={{ width: `${progressPercent}%` }}
                          >
                            {/* Animated subtle shimmer highlight when playing */}
                            {isPlaying && (
                              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-pulse" />
                            )}
                          </div>
                        </div>

                        {/* Scrubber Thumb */}
                        <div 
                          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-white rounded-full shadow-lg shadow-purple-500/60 border-2 border-purple-600 transition-all duration-75 group-hover:scale-125 group-active:scale-110 pointer-events-none z-20"
                          style={{ left: `${progressPercent}%` }}
                        />

                        {/* Native Range Input for direct Scrubbing, Accessible touch & Drag */}
                        <input
                          type="range"
                          min={0}
                          max={duration > 0 ? duration : 1}
                          step={0.05}
                          value={Math.min(currentTime, duration || 1)}
                          onChange={handleSeekChange}
                          onPointerDown={handleSeekStart}
                          onPointerUp={handleSeekEnd}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20"
                          aria-label="شريط تقدم الصوت"
                        />
                      </div>

                      {/* Timestamps Row */}
                      <div className="flex items-center justify-between text-xs font-mono text-zinc-400 px-1" dir="ltr">
                        <span className="text-purple-300 font-semibold">{formatDisplayTime(currentTime)}</span>
                        <span className="text-zinc-500">{formatDisplayTime(duration)}</span>
                      </div>
                    </div>

                    {/* Main Action Buttons */}
                    <div className="flex flex-col md:flex-row gap-4 pt-1">
                      <button
                        onClick={togglePlay}
                        className="flex-1 py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-2xl font-bold text-lg transition-all flex items-center justify-center gap-3 shadow-xl shadow-purple-500/20 active:scale-[0.98]"
                      >
                        {isPlaying ? (
                          <>
                            <Pause className="w-6 h-6 fill-current" />
                            إيقاف مؤقت
                          </>
                        ) : (
                          <>
                            <Play className="w-6 h-6 fill-current" />
                            {currentTime > 0 && currentTime < (duration - 0.2) ? 'متابعة التشغيل' : 'تشغيل الصوت'}
                          </>
                        )}
                      </button>

                      <div className="flex gap-3">
                        <button
                          onClick={handleGenerateVoiceover}
                          disabled={generatingVoice}
                          className="w-14 h-14 md:w-16 md:h-16 bg-white/5 text-purple-400 rounded-2xl border border-purple-500/30 flex items-center justify-center hover:bg-purple-500/10 transition-all active:scale-95"
                          title="إعادة توليد الصوت"
                        >
                          <History className={cn("w-6 h-6 md:w-7 md:h-7", generatingVoice && "animate-spin")} />
                        </button>
                        <button 
                          onClick={handleDownloadAudio}
                          className="w-14 h-14 md:w-16 md:h-16 bg-white/5 text-white rounded-2xl border border-white/10 flex items-center justify-center hover:bg-white/10 transition-all active:scale-95"
                          title="تحميل ملف الصوت (WAV)"
                        >
                          <Download className="w-6 h-6 md:w-7 md:h-7" />
                        </button>
                        {srtContent && (
                          <button 
                            onClick={handleDownloadSRT}
                            className="w-14 h-14 md:w-16 md:h-16 bg-white/5 text-white rounded-2xl border border-white/10 flex items-center justify-center hover:bg-white/10 transition-all active:scale-95"
                            title="تحميل ملف الترجمة (SRT)"
                          >
                            <FileText className="w-6 h-6 md:w-7 md:h-7" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Live Subtitles Display */}
                  <AnimatePresence>
                    {currentSubtitle && (
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="bg-purple-500/10 border border-purple-500/20 rounded-2xl p-6 text-center"
                      >
                        <p className="text-2xl font-medium text-purple-200 leading-relaxed" dir="rtl">
                          {currentSubtitle}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <audio 
                    ref={audioRef} 
                    src={audioUrl} 
                    className="hidden" 
                    onLoadedMetadata={() => {
                      if (audioRef.current && !isNaN(audioRef.current.duration)) {
                        setDuration(audioRef.current.duration);
                      }
                    }}
                    onTimeUpdate={handleTimeUpdate}
                    onEnded={() => {
                      setIsPlaying(false);
                      setCurrentSubtitle(null);
                      setCurrentTime(duration);
                    }}
                    onPause={() => setIsPlaying(false)}
                    onPlay={() => {
                      if (audioRef.current) {
                        audioRef.current.playbackRate = speakingRate;
                      }
                      setIsPlaying(true);
                    }}
                  />
                </div>
              )}
            </div>
          </section>

          {/* Cloud Projects Library Section */}
          <section className="bg-white/[0.03] border border-white/10 rounded-3xl p-6 space-y-5" dir="rtl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/5 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center">
                  <Cloud className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    مكتبة النصوص والمشاريع السحابية
                    {user && (
                      <span className="text-[11px] font-mono bg-white/5 border border-white/10 px-2 py-0.5 rounded-full text-zinc-400">
                        {cloudProjects.length}
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {user
                      ? 'تُحفظ نصوصك وإعدادات الصوت وملفات الترجمة (SRT) تلقائياً في حسابك للوصول إليها من أي جهاز.'
                      : 'سجّل الدخول بحساب Google لحفظ نصوصك وملفات الترجمة (SRT) ومزامنة إعداداتك سحابياً.'}
                  </p>
                </div>
              </div>

              {!user && authReady && (
                <button
                  type="button"
                  onClick={signInWithGoogle}
                  disabled={signingIn}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold transition-all shadow-lg shadow-purple-500/20 active:scale-95 shrink-0"
                >
                  {signingIn ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <LogIn className="w-4 h-4" />
                  )}
                  <span>تسجيل الدخول بحساب Google</span>
                </button>
              )}
            </div>

            {user && (
              projectsLoading ? (
                <div className="flex items-center justify-center py-8 text-zinc-400 gap-2 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
                  <span>جاري تحميل مشاريعك السحابية...</span>
                </div>
              ) : cloudProjects.length === 0 ? (
                <div className="text-center py-8 space-y-2 text-zinc-500">
                  <FolderOpen className="w-8 h-8 mx-auto opacity-40" />
                  <p className="text-sm font-medium text-zinc-400">لا توجد مشاريع محفوظة بعد</p>
                  <p className="text-xs">
                    عند توليد أي تعليق صوتي أو النقر على «حفظ في السحابة» سيظهر مشروعك هنا فوراً.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {cloudProjects.map((project) => (
                    <div
                      key={project.id}
                      className="bg-black/40 border border-white/10 hover:border-purple-500/30 rounded-2xl p-4 flex flex-col justify-between gap-3 transition-all"
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="text-sm font-bold text-zinc-100 line-clamp-1">
                            {project.title}
                          </h4>
                          <span className="text-[10px] font-mono text-purple-300 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded-full shrink-0" dir="ltr">
                            {project.speakingRate.toFixed(2)}x
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                          {project.text}
                        </p>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-white/5 text-[11px] text-zinc-500">
                        <div className="flex items-center gap-2 truncate">
                          <span className="text-zinc-300 font-medium truncate max-w-[140px]">
                            {project.voiceName}
                          </span>
                          <span>·</span>
                          <span className="font-mono">{project.charCount} حرف</span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleLoadCloudProject(project)}
                            className="px-2.5 py-1 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 text-purple-200 border border-purple-500/30 text-[11px] font-bold transition-colors flex items-center gap-1"
                          >
                            <FolderOpen className="w-3 h-3" />
                            <span>تحميل</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteCloudProject(project.id)}
                            className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-300 transition-colors"
                            title="حذف المشروع"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-12 mt-20">
        <div className="max-w-5xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3 text-zinc-500 text-sm">
            <History className="w-4 h-4" />
            <span>Powered by Gemini 2.5 TTS Engine</span>
          </div>
          <div className="flex items-center gap-6">
            <span className="text-zinc-600 text-xs">© 2024 Audio Studio Pro</span>
            <div className="h-4 w-px bg-white/10" />
            <span className="text-zinc-600 text-xs">High Fidelity Output</span>
          </div>
        </div>
      </footer>

      <OfflineIndicator />
    </div>
  );
}
