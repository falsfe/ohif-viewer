const getBaseUrl = (): string => {
  const config = (window as any).config;
  return config?.auth?.apiBaseUrl ?? 'http://localhost:4001';
};

export async function login(usernameOrEmail: string, password: string): Promise<{
  accessToken: string;
  user: { id: string; username: string; email: string };
}> {
  const response = await fetch(`${getBaseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ usernameOrEmail, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message ?? 'Login failed.');
  }

  return data;
}

export async function register(
  username: string,
  email: string,
  password: string,
  confirmPassword: string
): Promise<void> {
  const response = await fetch(`${getBaseUrl()}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password, confirmPassword }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message ?? 'Registration failed.');
  }
}

export async function refreshSession(): Promise<{
  accessToken: string;
  user: { id: string; username: string; email: string };
}> {
  const response = await fetch(`${getBaseUrl()}/api/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message ?? 'Session expired.');
  }

  return data;
}

export async function logout(): Promise<void> {
  await fetch(`${getBaseUrl()}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
}
