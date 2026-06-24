export async function downloadSmtpCredential(domain: string): Promise<void> {
  const response = await fetch(`/v1/sender-pool/credentials/${encodeURIComponent(domain)}/download`, {
    method: "GET"
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  const blob = await response.blob();
  triggerDownload(
    blob,
    fileNameFromDisposition(response.headers.get("content-disposition")) ?? `smtp-credentials-${domain}.md`
  );
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: string; message?: string };
    return payload.message ?? payload.error ?? response.statusText;
  } catch {
    return text || response.statusText;
  }
}

function fileNameFromDisposition(value: string | null): string | null {
  const match = value?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
}
