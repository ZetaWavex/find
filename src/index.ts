export interface Env {
  FIND_KV: KVNamespace;
  API_SECRET: string;
}

interface RingSignal {
  ring: boolean;
  message: string;
  timestamp: number;
}

interface DeviceRegistration {
  id: string;
  secret: string;
  createdAt: number;
  lastHeartbeat?: number;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
};

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

async function hashSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (path === "/api/register" && request.method === "POST") {
        return handleRegister(request, env);
      }

      if (path === "/api/heartbeat" && request.method === "POST") {
        return handleHeartbeat(request, env);
      }

      if (path === "/api/status" && request.method === "GET") {
        return handleStatus(url, env);
      }

      if (path === "/api/ring" && request.method === "POST") {
        return handleRing(request, env);
      }

      if (path === "/api/stop" && request.method === "POST") {
        return handleStop(request, env);
      }

      if (path === "/api/info" && request.method === "GET") {
        return jsonResponse({
          name: "Find Phone Tool API",
          version: "1.0.0",
          endpoints: {
            register: "POST /api/register",
            heartbeat: "POST /api/heartbeat",
            status: "GET /api/status?id=X&secret=Y",
            ring: "POST /api/ring",
            stop: "POST /api/stop",
          },
        });
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return jsonResponse({ error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ id: string; secret: string }>();
  const id = body.id;
  const secret = body.secret;

  if (!id || !secret) {
    return jsonResponse({ error: "ID and secret required" }, 400);
  }

  const secretHash = await hashSecret(secret);
  const device: DeviceRegistration = {
    id,
    secret: secretHash,
    createdAt: Date.now(),
  };

  await env.FIND_KV.put(`device:${id}`, JSON.stringify(device));
  await env.FIND_KV.put(`ring:${id}`, JSON.stringify({
    ring: false,
    message: "",
    timestamp: Date.now(),
  }));

  return jsonResponse({
    success: true,
    message: "Device registered",
    deviceId: id,
  });
}

async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ id: string; secret: string }>();
  const id = body.id;
  const secret = body.secret;

  if (!id || !secret) {
    return jsonResponse({ error: "ID and secret required" }, 400);
  }

  const deviceRaw = await env.FIND_KV.get(`device:${id}`);
  if (!deviceRaw) {
    return jsonResponse({ error: "Device not registered" }, 404);
  }

  const device = JSON.parse(deviceRaw) as DeviceRegistration;
  const secretHash = await hashSecret(secret);

  if (device.secret !== secretHash) {
    return jsonResponse({ error: "Invalid secret" }, 401);
  }

  device.lastHeartbeat = Date.now();
  await env.FIND_KV.put(`device:${id}`, JSON.stringify(device));

  return jsonResponse({ success: true });
}

async function handleStatus(url: URL, env: Env): Promise<Response> {
  const id = url.searchParams.get("id");
  const secret = url.searchParams.get("secret");

  if (!id || !secret) {
    return jsonResponse({ error: "Missing id or secret" }, 400);
  }

  const deviceRaw = await env.FIND_KV.get(`device:${id}`);
  if (!deviceRaw) {
    return jsonResponse({ error: "Device not registered" }, 404);
  }

  const device = JSON.parse(deviceRaw) as DeviceRegistration;
  const secretHash = await hashSecret(secret);

  if (device.secret !== secretHash) {
    return jsonResponse({ error: "Invalid secret" }, 401);
  }

  const ringRaw = await env.FIND_KV.get(`ring:${id}`);
  let ringData: RingSignal;

  if (ringRaw) {
    ringData = JSON.parse(ringRaw) as RingSignal;
    if (ringData.ring && Date.now() - ringData.timestamp > 5 * 60 * 1000) {
      ringData = { ring: false, message: "", timestamp: Date.now() };
      await env.FIND_KV.put(`ring:${id}`, JSON.stringify(ringData));
    }
  } else {
    ringData = { ring: false, message: "", timestamp: Date.now() };
  }

  const wasRinging = ringData.ring;
  if (wasRinging) {
    ringData = { ...ringData, ring: false };
    await env.FIND_KV.put(`ring:${id}`, JSON.stringify(ringData));
  }

  return jsonResponse({
    ring: wasRinging,
    message: ringData.message,
    timestamp: ringData.timestamp,
  });
}

async function handleRing(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Authorization: Bearer API_SECRET required" }, 401);
  }

  const providedSecret = authHeader.slice(7);
  if (providedSecret !== env.API_SECRET) {
    return jsonResponse({ error: "Invalid API secret" }, 401);
  }

  const body = await request.json<{ id: string; message?: string }>();
  const id = body.id;
  const message = body.message ?? "Phone ringing";

  if (!id) {
    return jsonResponse({ error: "Device ID required" }, 400);
  }

  const signal: RingSignal = {
    ring: true,
    message,
    timestamp: Date.now(),
  };

  await env.FIND_KV.put(`ring:${id}`, JSON.stringify(signal));

  return jsonResponse({
    success: true,
    message: `Ring triggered for ${id}`,
  });
}

async function handleStop(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Authorization: Bearer API_SECRET required" }, 401);
  }

  const providedSecret = authHeader.slice(7);
  if (providedSecret !== env.API_SECRET) {
    return jsonResponse({ error: "Invalid API secret" }, 401);
  }

  const body = await request.json<{ id: string }>();
  const id = body.id;

  if (!id) {
    return jsonResponse({ error: "Device ID required" }, 400);
  }

  await env.FIND_KV.put(`ring:${id}`, JSON.stringify({
    ring: false,
    message: "",
    timestamp: Date.now(),
  }));

  return jsonResponse({
    success: true,
    message: `Ring stopped for ${id}`,
  });
}