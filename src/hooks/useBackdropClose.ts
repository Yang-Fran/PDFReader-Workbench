import { useRef, type PointerEventHandler } from "react";

type BackdropHandlers<T extends HTMLElement> = {
  onPointerDown: PointerEventHandler<T>;
  onPointerUp: PointerEventHandler<T>;
  onPointerCancel: PointerEventHandler<T>;
};

export const useBackdropClose = <T extends HTMLElement>(onClose: () => void): BackdropHandlers<T> => {
  const pointerStartedOnBackdropRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);

  const reset = () => {
    pointerStartedOnBackdropRef.current = false;
    activePointerIdRef.current = null;
  };

  const onPointerDown: PointerEventHandler<T> = (event) => {
    activePointerIdRef.current = event.pointerId;
    pointerStartedOnBackdropRef.current = event.target === event.currentTarget;
  };

  const onPointerUp: PointerEventHandler<T> = (event) => {
    const shouldClose =
      pointerStartedOnBackdropRef.current &&
      activePointerIdRef.current === event.pointerId &&
      event.target === event.currentTarget;
    reset();
    if (shouldClose) {
      onClose();
    }
  };

  const onPointerCancel: PointerEventHandler<T> = () => {
    reset();
  };

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel
  };
};
