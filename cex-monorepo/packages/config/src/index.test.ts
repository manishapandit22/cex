import { describe, expect, it } from 'vitest';
import { configSchema } from './index.js';

describe('@cex/config', () => {
  it('exports its schema', () => expect(configSchema).toBeDefined());
});
