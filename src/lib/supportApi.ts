import { getServerEndpoint } from "@/lib/serverApi";

export interface SupportScreenshot {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface SubmitSupportMessageInput {
  authToken: string;
  message: string;
  appVersion: string;
  screenshots: SupportScreenshot[];
  metadata: Record<string, unknown>;
}

const parseJson = async (response: Response) => {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
};

export const submitSupportMessage = async ({
  authToken,
  message,
  appVersion,
  screenshots,
  metadata,
}: SubmitSupportMessageInput) => {
  const response = await fetch(getServerEndpoint("/survey-responses"), {
    method: "POST",
    headers: {
      Authorization: authToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      appVersion,
      screenshots: screenshots.map((screenshot) => ({
        fileName: screenshot.fileName,
        contentType: screenshot.contentType,
        sizeBytes: screenshot.sizeBytes,
        dataUrl: screenshot.dataUrl,
      })),
      metadata,
    }),
  });

  const data = await parseJson(response);
  if (!response.ok || !data?.success) {
    throw new Error(
      data?.message || `Request failed with status ${response.status}.`,
    );
  }

  return data;
};
