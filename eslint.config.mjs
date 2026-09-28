import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Shared config for TypeScript packages. apps/web has its own config (Next.js rules).
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.turbo/**",
      ".worktrees/**",
      ".loop-evidence/**",
      "legacy/**",
      "apps/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
);
