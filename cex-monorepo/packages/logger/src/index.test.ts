import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

describe('@cex/logger', () => {
  it('creates a logger', () => expect(createLogger('test')).toBeDefined());
});
