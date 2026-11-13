import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-2xl bg-amber-500/95 backdrop-blur-md border border-amber-300/30 px-4 py-2 text-xs font-bold text-zinc-950 shadow-xl"
      dir="rtl"
    >
      <WifiOff className="w-4 h-4 shrink-0" />
      <span>وضع عدم الاتصال — يتم استخدام النسخة المخزنة مؤقتاً (توليد الصوت يتطلب إنترنت)</span>
    </div>
  );
};
