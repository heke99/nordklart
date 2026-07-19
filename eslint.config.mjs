import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
  // CommonJS scripts (.cjs) are executed directly by node in ops tooling and
  // cannot use ESM imports; `require()` is the only correct module mechanism
  // there. Scoped, technically motivated exception per audit item T01.
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // No raw console.* in lib/ or app/api/. Use createLogger from @/lib/logger
  // so log lines carry requestId + structured context. lib/logger.ts and
  // app/api/log/route.ts are the two intentional exemptions because they ARE
  // the logger plumbing.
  {
    files: ["lib/**/*.ts", "lib/**/*.tsx", "app/api/**/*.ts", "app/api/**/*.tsx"],
    ignores: [
      "lib/logger.ts",
      "app/api/log/route.ts",
      // Test files have legitimate console use for assertions / debugging.
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.bench.test.ts",
      "**/*.pg.test.ts",
    ],
    rules: {
      // warn (not error) until the remaining ~20 routes/lib files migrate.
      // Flip to "error" once the count drops to zero so the floor is enforced.
      "no-console": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
