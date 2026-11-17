module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
  rules: {
    'no-restricted-syntax': [
      'error',
      { selector: "CallExpression[callee.name='parseFloat'] > Identifier[name=/^(price|quantity|amount|balance)$/i]", message: 'Do not parse money with parseFloat.' },
      { selector: "CallExpression[callee.name='Number'] > Identifier[name=/^(price|quantity|amount|balance)$/i]", message: 'Do not parse money with Number.' }
    ]
  }
};
