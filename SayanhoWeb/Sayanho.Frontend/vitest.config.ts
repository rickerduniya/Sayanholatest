import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Only files under a __tests__ directory. `src/utils/ConnectorFactory.test.ts`
        // predates the test runner and exports a helper rather than a suite, so a
        // broad `*.test.ts` glob would fail the run on it.
        include: ['src/**/__tests__/**/*.test.ts'],
        environment: 'node'
    }
});
