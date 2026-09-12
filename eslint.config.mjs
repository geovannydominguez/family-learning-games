import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "cdk.out/**",
      "next-env.d.ts",
      // Static assets only (icons, the offline fallback page, the Service
      // Worker script) — not TypeScript/React application source.
      "public/**",
    ],
  },
];

export default eslintConfig;
