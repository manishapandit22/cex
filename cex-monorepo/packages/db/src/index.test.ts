import { describe, expect, it } from 'vitest';
import { dbPackageReady } from './index.js';

describe('@cex/db', () => {
  it('imports successfully', () => expect(dbPackageReady).toBe(true));
});
