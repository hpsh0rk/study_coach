export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

export async function api<T = unknown>(path: string, init: { method?: string; body?: Json | Blob | File; headers?: Record<string, string> } = {}): Promise<T> {
  const isBinary = init.body instanceof Blob;
  const res = await fetch(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: {
      "x-kj-csrf": "1",
      ...(init.body && !isBinary ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : isBinary ? (init.body as Blob) : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, err?.code ?? "HTTP", err?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export interface Me {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "teacher";
  mustChangePassword: boolean;
}
