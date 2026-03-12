import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#f7f8fa",
        border: "#d9dde5",
        text: "#1f2937"
      }
    }
  },
  plugins: []
} satisfies Config;
