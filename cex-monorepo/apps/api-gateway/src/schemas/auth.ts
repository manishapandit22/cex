import { z } from 'zod';

const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const password = z.string().min(10).max(256);

export const signUpSchema = z.object({ email, password }).strict().superRefine(({ email: address, password: secret }, context) => {
  if (address === secret.toLowerCase()) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Password must not equal email.', path: ['password'] });
});

export const signInSchema = z.object({ email, password }).strict();
export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
