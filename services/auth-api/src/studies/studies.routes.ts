import { Router } from 'express';

import { createStudiesController } from './studies.controller';
import { requireAuth } from '../middleware/auth.middleware';

export function createStudiesRouter(): Router {
  const controller = createStudiesController();
  const router = Router();

  router.use(requireAuth);

  router.post('/register', controller.register);
  router.post('/register-batch', controller.registerBatch);
  router.get('/mine', controller.getMyStudies);

  return router;
}
