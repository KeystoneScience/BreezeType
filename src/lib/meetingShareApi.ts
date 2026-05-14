import { buildServerEndpoint } from "@/lib/serverApi";

export interface MeetingPublicShare {
  id: string;
  public_token: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  url: string;
}

export interface MeetingUserShare {
  id: string;
  target_user_id: string | null;
  target_email: string;
  target_name: string | null;
  share_token?: string | null;
  url?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface MeetingSharesResponse {
  public_share: MeetingPublicShare | null;
  user_shares: MeetingUserShare[];
}

const parseJson = async (response: Response) => {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
};

const request = async (
  serverUrl: string,
  path: string,
  authToken: string,
  input: RequestInit = {},
) => {
  const response = await fetch(buildServerEndpoint(serverUrl, path), {
    ...input,
    headers: {
      Authorization: authToken,
      "Content-Type": "application/json",
      ...(input.headers || {}),
    },
  });

  const data = await parseJson(response);
  if (!response.ok || !data?.success) {
    throw new Error(
      data?.message || `Request failed with status ${response.status}.`,
    );
  }

  return data;
};

export const fetchMeetingShares = async (
  serverUrl: string,
  authToken: string,
  syncId: string,
): Promise<MeetingSharesResponse> => {
  const data = await request(
    serverUrl,
    `/meetings/${syncId}/shares`,
    authToken,
    {
      method: "GET",
    },
  );
  return {
    public_share: data.public_share || null,
    user_shares: Array.isArray(data.user_shares) ? data.user_shares : [],
  };
};

export const enablePublicMeetingShare = async (
  serverUrl: string,
  authToken: string,
  syncId: string,
): Promise<MeetingPublicShare | null> => {
  const data = await request(
    serverUrl,
    `/meetings/${syncId}/share/public`,
    authToken,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  return data.public_share || null;
};

export const disablePublicMeetingShare = async (
  serverUrl: string,
  authToken: string,
  syncId: string,
): Promise<void> => {
  await request(serverUrl, `/meetings/${syncId}/share/public`, authToken, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
};

export const shareMeetingToEmail = async (
  serverUrl: string,
  authToken: string,
  syncId: string,
  email: string,
): Promise<void> => {
  await request(serverUrl, `/meetings/${syncId}/share/users`, authToken, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
};

export const revokeMeetingShare = async (
  serverUrl: string,
  authToken: string,
  syncId: string,
  shareId: string,
): Promise<void> => {
  await request(
    serverUrl,
    `/meetings/${syncId}/share/users/${shareId}`,
    authToken,
    {
      method: "DELETE",
      body: JSON.stringify({}),
    },
  );
};
