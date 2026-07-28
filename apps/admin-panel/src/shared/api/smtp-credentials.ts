import { READ_ENDPOINTS } from "./read-boundary.ts";

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

/**
 * Baja en un solo ZIP el .md de cada dominio configurado del pool.
 *
 * Un request, un evento de auditoría y un slot de rate limit — a diferencia de
 * iterar los 70+ dominios con downloadSmtpCredential. El paquete no trae claves
 * SSH privadas: esas se siguen bajando por dominio.
 */
export async function downloadAllSmtpCredentials(): Promise<void> {
  const response = await fetch(READ_ENDPOINTS.senderPoolCredentialsBulkDownload, {
    method: "GET"
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  const blob = await response.blob();
  triggerDownload(
    blob,
    fileNameFromDisposition(response.headers.get("content-disposition")) ??
      `smtp-credentials-${new Date().toISOString().slice(0, 10)}.zip`
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
