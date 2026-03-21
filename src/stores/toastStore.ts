import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
};

type ToastState = {
  items: ToastItem[];
  pushToast: (message: string, tone?: ToastTone, duration?: number) => void;
  removeToast: (id: string) => void;
};

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  pushToast: (message, tone = "info", duration = 3000) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({
      items: [...state.items, { id, message, tone }]
    }));
    window.setTimeout(() => {
      set((state) => ({
        items: state.items.filter((item) => item.id !== id)
      }));
    }, duration);
  },
  removeToast: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id)
    }))
}));
