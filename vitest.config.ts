import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // only this project's tests (the Solidity dependencies under contracts/lib ship their own JS tests)
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'contracts/**', 'dist/**'],
  },
});
