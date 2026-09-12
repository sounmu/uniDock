import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  {
    ignores: [
      "node_modules/**",
      ".wxt/**",
      ".output/**",
      ".store-build/**",
      "release/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
