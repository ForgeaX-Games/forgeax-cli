const API_BASE = "";

let onAuthRequired: (() => void) | null = null;

export function setAuthHandler(handler: () => void) {
  onAuthRequired = handler;
}

function getToken(): string | null {
  return localStorage.getItem("gateway_token");
}

export function setToken(token: string) {
  localStorage.setItem("gateway_token", token);
}

export function clearToken() {
  localStorage.removeItem("gateway_token");
}

export function hasToken(): boolean {
  return !!localStorage.getItem("gateway_token");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (init?.body && typeof init.body === "string") {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    onAuthRequired?.();
    throw new Error("Unauthorized — please set your Gateway token in Settings");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  if (res.headers.get("content-type")?.startsWith("text/")) {
    return (await res.text()) as unknown as T;
  }
  return res.json();
}

/**
 * Call a worker command via the gateway HTTP commands transport.
 * Unwraps the `{ result: { ok, data | error } }` envelope so callers see plain data.
 *
 * `args` is positional — `args[0]` is the first positional arg, etc. (matches
 * CommandModule contract in src/capability/command/types.ts).
 */
async function cmdQuery<T = unknown>(
  instanceId: string,
  name: string,
  args: string[] = [],
): Promise<T> {
  const { result } = await request<{ result: { ok: boolean; data?: T; error?: string } }>(
    `/api/instances/${instanceId}/commands/${name}/query`,
    { method: "POST", body: JSON.stringify({ args }) },
  );
  if (!result.ok) throw new Error(result.error ?? `${name} failed`);
  return result.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  cmdQuery,
};
