const parser = require('@typescript-eslint/parser');
const typescript = require('@typescript-eslint/eslint-plugin');
const stylistic = require('@stylistic/eslint-plugin');
const jsdoc = require('eslint-plugin-jsdoc').default;
const noNull = require('eslint-plugin-no-null');

module.exports = [{
  files: ['src/**/*.ts'],
  ignores: ['src/browser/**'],
  languageOptions: {parser, sourceType: 'module', parserOptions: {project: './tsconfig.json', tsconfigRootDir: __dirname}},
  plugins: {'@typescript-eslint': typescript, '@stylistic': stylistic, jsdoc, 'no-null': noNull},
  rules: {
  "@stylistic/indent": [
    "error",
    "tab",
    {
      "ignoredNodes": [
        "PropertyDefinition"
      ]
    }
  ],
  "@stylistic/member-delimiter-style": [
    "error",
    {
      "multiline": {
        "delimiter": "semi",
        "requireLast": true
      },
      "singleline": {
        "delimiter": "semi",
        "requireLast": false
      }
    }
  ],
  "@typescript-eslint/naming-convention": "error",
  "@typescript-eslint/prefer-namespace-keyword": "error",
  "@stylistic/quotes": [
    "error",
    "double",
    {
      "avoidEscape": true
    }
  ],
  "@stylistic/semi": [
    "error",
    "always"
  ],
  "@stylistic/type-annotation-spacing": "error",
  "@stylistic/brace-style": [
    "error",
    "1tbs"
  ],
  "indent": "off",
  "jsdoc/check-alignment": "error",
  "jsdoc/check-indentation": "error",
  "no-null/no-null": "error",
  "@stylistic/no-trailing-spaces": "error",
  "no-var": "error",
  "prefer-const": "error",
  "quotes": "off",
  "semi": "off",
  "@stylistic/spaced-comment": [
    "error",
    "always",
    {
      "markers": [
        "/"
      ]
    }
  ],
  "@stylistic/keyword-spacing": [
    "error",
    {
      "before": true,
      "after": true
    }
  ],
  "@stylistic/space-infix-ops": "error",
  "@stylistic/comma-spacing": [
    "error",
    {
      "before": false,
      "after": true
    }
  ],
  "@stylistic/semi-spacing": [
    "error",
    {
      "before": false,
      "after": true
    }
  ]
}
}];
