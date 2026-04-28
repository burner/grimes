import { defineConfig } from "eslint/config"
import js from "@eslint/js"
import tseslint from "typescript-eslint"
import unicorn from "eslint-plugin-unicorn"

export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      ".grimes/**",
      "reflection-3.ts",
      "reflection-3.test-helpers.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,
  unicorn.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "eqeqeq": ["error", "always"],
      "curly": ["error", "all"],
      "no-console": "error",
      "no-template-curly-in-string": "error",
      "no-unneeded-ternary": "error",
      "no-useless-return": "error",
      "prefer-arrow-callback": "error",
      "prefer-template": "error",
      "yoda": "error",

      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
          allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing: false,
        },
      ],
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: false, number: false, boolean: false } },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { requireDefaultForNonUnion: true },
      ],
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/consistent-generic-constructors": "error",
      "@typescript-eslint/method-signature-style": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/no-meaningless-void-operator": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      "unicorn/error-message": "error",
      "unicorn/no-useless-undefined": "error",
      "unicorn/prefer-string-slice": "error",
      "unicorn/prefer-string-replace-all": "error",
      "unicorn/prefer-ternary": ["error", "only-single-line"],
      "unicorn/no-null": "off",
      "unicorn/prevent-abbreviations": "off",
      "unicorn/filename-case": "off",
      "unicorn/no-useless-spread": "error",
      "unicorn/consistent-function-scoping": "error",
      "unicorn/prefer-top-level-await": "error",
    },
  },
])
