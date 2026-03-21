import { createPortal } from "react-dom";
import { useToastStore } from "../../stores/toastStore";

const toneClassName = (tone: "info" | "success" | "error") => {
  switch (tone) {
    case "success":
      return "border-emerald-300/80 bg-emerald-50/95 text-emerald-800";
    case "error":
      return "border-rose-300/80 bg-rose-50/95 text-rose-800";
    default:
      return "border-slate-300/80 bg-white/95 text-slate-800";
  }
};

export function ToastViewport() {
  const items = useToastStore((state) => state.items);
  const removeToast = useToastStore((state) => state.removeToast);

  if (items.length === 0) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[160] flex items-start justify-center px-4 pt-10">
      <div className="flex max-w-md flex-col items-center gap-3">
        {items.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto min-w-[220px] rounded-xl border px-4 py-3 text-center text-sm font-medium shadow-2xl backdrop-blur ${toneClassName(item.tone)}`}
            onClick={() => removeToast(item.id)}
          >
            {item.message}
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}
