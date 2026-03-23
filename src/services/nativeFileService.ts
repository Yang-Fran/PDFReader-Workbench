import { invoke } from "@tauri-apps/api/core";

export const nativeFileService = {
  async readTextFile(path: string) {
    return invoke<string>("read_text_file_any", { path });
  },

  async writeTextFile(path: string, content: string) {
    return invoke<void>("write_text_file_any", { path, content });
  },

  async writeBinaryFile(path: string, bytes: Uint8Array | number[]) {
    return invoke<void>("write_binary_file_any", { path, bytes: Array.from(bytes) });
  }
};
