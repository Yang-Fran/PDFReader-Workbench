import { invoke } from "@tauri-apps/api/core";

const ts = () => new Date().toISOString().replace("T", " ").replace("Z", "");

const emit = async (level: "INFO" | "WARN" | "ERROR", message: string) => {
  const line = `${ts()} [${level}] ${message}`;
  try {
    await invoke("log_event", { line });
  } catch {
    // Fallback when tauri invoke is unavailable (e.g. browser mode).
    // eslint-disable-next-line no-console
    console.log(line);
  }
};

export const debugLogger = {
  info(message: string) {
    void emit("INFO", message);
  },
  warn(message: string) {
    void emit("WARN", message);
  },
  error(message: string) {
    void emit("ERROR", message);
  }
};

