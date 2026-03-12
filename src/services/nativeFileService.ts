import { invoke } from "@tauri-apps/api/core";

export const nativeFileService = {
  async readTextFile(path: string) {
    return invoke<string>("read_text_file_any", { path });
  },

  async writeTextFile(path: string, content: string) {
    return invoke<void>("write_text_file_any", { path, content });
  }
};
