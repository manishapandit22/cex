import { describe, expect, it } from 'vitest';
import { Side } from '@cex/types';

describe('@cex/engine', () => {
  it('imports Side from @cex/types', () => expect(Side.BUY).toBe('BUY'));
});
