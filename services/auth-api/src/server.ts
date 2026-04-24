import app from './app';
import { env } from './config/env';

app.listen(env.port, () => {
  // Keep bootstrap output explicit for local verification.
  console.log(`auth-api listening on http://localhost:${env.port}`);
});
