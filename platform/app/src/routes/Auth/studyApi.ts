export async function registerStudyOwnershipBatch(
  studyInstanceUids: string[],
  accessToken: string
): Promise<void> {
  const response = await fetch('/api/studies/register-batch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    credentials: 'include',
    body: JSON.stringify({ studyInstanceUids }),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data?.error?.message ?? 'Failed to register study ownership.');
  }
}

export async function getMyStudyUids(accessToken: string): Promise<string[]> {
  const response = await fetch('/api/studies/mine', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401) {
      // Token expired, try refresh
      const { refreshSession } = await import('./authApi');
      const session = await refreshSession();
      const { setAccessToken } = await import('./LocalAuthRoutes');
      setAccessToken(session.accessToken);

      const retryResponse = await fetch('/api/studies/mine', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
        },
        credentials: 'include',
      });

      if (retryResponse.ok) {
        const retryData = await retryResponse.json();
        return retryData.studyInstanceUids;
      }
    }
    throw new Error('Failed to fetch user studies.');
  }

  const data = await response.json();
  return data.studyInstanceUids;
}
