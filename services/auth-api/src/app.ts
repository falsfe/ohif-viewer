import express from 'express';
import cors from 'cors';

import { createAuthRouter } from './auth/auth.routes';
import { errorMiddleware } from './middleware/error.middleware';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/health', (_request, response) => {
  response.status(200).json({ status: 'ok' });
});

app.use('/api/auth', createAuthRouter());
app.use(errorMiddleware);

export default app;
