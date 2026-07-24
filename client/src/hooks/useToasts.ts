import React from 'react';

export interface ToastItem {
  id: number;
  msg: string;
}

// Transient toast messages. Each toast auto-dismisses after 2.4s.
export function useToasts() {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const toast = (msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, msg }]);
    setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 2400);
  };
  return { toasts, toast };
}
