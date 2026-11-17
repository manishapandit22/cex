import { PrismaClient } from '@prisma/client';
const globalForPrisma = globalThis;
/** Indicates that the generated Prisma client can be imported by workspace consumers. */
export const dbPackageReady = true;
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production')
    globalForPrisma.prisma = prisma;
export * from '@prisma/client';
//# sourceMappingURL=index.js.map