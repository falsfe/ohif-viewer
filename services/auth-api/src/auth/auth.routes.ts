import { Router } from 'express';

import { createAuthController } from './auth.controller';

export function createAuthRouter(): Router {
  const controller = createAuthController();
  const router = Router();

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.get('/me', controller.me);
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);

  return router;
}
