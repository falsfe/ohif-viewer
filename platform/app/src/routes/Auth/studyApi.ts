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
    const data = await response.json();
    throw new Error(data?.error?.message ?? 'Failed to fetch user studies.');
  }

  const data = await response.json();
  return data.studyInstanceUids;
}
