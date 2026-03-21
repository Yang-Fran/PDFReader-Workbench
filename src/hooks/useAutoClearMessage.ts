import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

export const useAutoClearMessage = (
  message: string,
  setMessage: Dispatch<SetStateAction<string>>,
  delay = 5000,
  onClear?: () => void
) => {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => {
      setMessage("");
      onClear?.();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [delay, message, onClear, setMessage]);
};
