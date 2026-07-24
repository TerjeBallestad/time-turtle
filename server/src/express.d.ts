// Augments Express's Request with the authenticated user attached by requireUser.
import type { User } from '../../shared/types.ts';

declare global {
  namespace Express {
    interface Request {
      user: User;
    }
  }
}

export {};
