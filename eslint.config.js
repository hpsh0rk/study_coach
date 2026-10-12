import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const MODEL_SDKS = ["openai", "@anthropic-ai/sdk", "@google/genai", "@google/generative-ai", "ai", "zhipuai", "deepseek"];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", "apps/app/migrations/**", "test-results/**", "playwright-report/**", "containers/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.worker },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Every model call goes through packages/ai so gating, routing and metering cannot be bypassed.
    files: ["**/*.{ts,tsx,js,mjs}"],
    ignores: ["packages/ai/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: MODEL_SDKS.map((name) => ({ name, message: "Model SDKs may only be used inside packages/ai." })),
          patterns: [{ regex: "^@ai-sdk/", message: "Model SDKs may only be used inside packages/ai." }],
        },
      ],
    },
  },
);
