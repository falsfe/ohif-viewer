import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_PORT = 4001;

function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort === '') {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }

  const parsedPort = Number.parseInt(rawPort, 10);

  if (parsedPort <= 0 || parsedPort > 65535) {
    throw new Error('PORT must be a whole number between 1 and 65535.');
  }

  return parsedPort;
}

export const env = {
  port: parsePort(process.env.PORT),
};
