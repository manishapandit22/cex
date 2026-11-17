import { describe, expect, it } from 'vitest';
import { Side } from './index.js';

describe('@cex/types', () => {
  it('exports uppercase enums', () => expect(Side.BUY).toBe('BUY'));
});
