export interface Env {
  PHONE_DATA: KVNamespace;
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
            register: "POST /api/register - 注册新设备",
            heartbeat: "POST /api/heartbeat - 设备心跳",
            status: "GET /api/status?id=DEVICE_ID&secret=SECRET - 查询响铃状态",
            ring: "POST /api/ring - 触发响铃",
            stop: "POST /api/stop - 停止响铃",
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
  const { id, secret } = body;

  if (!id || !secret) {
    return jsonResponse({ error: "设备ID和密钥不能为空" }, 400);
  }

  const secretHash = await hashSecret(secret);
  const device: DeviceRegistration = {
    id,
    secret: secretHash,
    createdAt: Date.now(),
  };

  await env.PHONE_DATA.put(`device:${id}`, JSON.stringify(device));
  await env.PHONE_DATA.put(`ring:${id}`, JSON.stringify({
    ring: false,
    message: "",
    timestamp: Date.now(),
  }));

  return jsonResponse({
    success: true,
    message: "设备注册成功",
    deviceId: id,
  });
}

async function handleHeartbeat(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ id: string; secret: string }>();
  const { id, secret } = body;

  if (!id || !secret) {
    return jsonResponse({ error: "设备ID和密钥不能为空" }, 400);
  }

  const deviceRaw = await env.PHONE_DATA.get(`device:${id}`);
  if (!deviceRaw) {
    return jsonResponse({ error: "设备未注册" }, 404);
  }

  const device = JSON.parse(deviceRaw) as DeviceRegistration;
  const secretHash = await hashSecret(secret);

  if (device.secret !== secretHash) {
    return jsonResponse({ error: "密钥错误" }, 401);
  }

  device.lastHeartbeat = Date.now();
  await env.PHONE_DATA.put(`device:${id}`, JSON.stringify(device));

  return jsonResponse({ success: true });
}

async function handleStatus(url: URL, env: Env): Promise<Response> {
  const id = url.searchParams.get("id");
  const secret = url.searchParams.get("secret");

  if (!id || !secret) {
    return jsonResponse({ error: "缺少参数 id 或 secret" }, 400);
  }

  const deviceRaw = await env.PHONE_DATA.get(`device:${id}`);
  if (!deviceRaw) {
    return jsonResponse({ error: "设备未注册" }, 404);
  }

  const device = JSON.parse(deviceRaw) as DeviceRegistration;
  const secretHash = await hashSecret(secret);

  if (device.secret !== secretHash) {
    return jsonResponse({ error: "密钥错误" }, 401);
  }

  const ringRaw = await env.PHONE_DATA.get(`ring:${id}`);
  let ringData: RingSignal;

  if (ringRaw) {
    ringData = JSON.parse(ringRaw) as RingSignal;
    if (ringData.ring && Date.now() - ringData.timestamp > 5 * 60 * 1000) {
      ringData = { ring: false, message: "", timestamp: Date.now() };
      await env.PHONE_DATA.put(`ring:${id}`, JSON.stringify(ringData));
    }
  } else {
    ringData = { ring: false, message: "", timestamp: Date.now() };
  }

  if (ringData.ring) {
    ringData.ring = false;
    await env.PHONE_DATA.put(`ring:${id}`, JSON.stringify(ringData));
  }

  return jsonResponse({
    ring: ringData.ring,
    message: ringData.message,
    timestamp: ringData.timestamp,
  });
}

async function handleRing(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "需要 Authorization: Bearer API_SECRET" }, 401);
  }

  const providedSecret = authHeader.slice(7);
  if (providedSecret !== env.API_SECRET) {
    return jsonResponse({ error: "API 密钥错误" }, 401);
  }

  const body = await request.json<{ id: string; message?: string }>();
  const { id, message = "手机响铃中" } = body;

  if (!id) {
    return jsonResponse({ error: "需要设备 ID" }, 400);
  }

  const signal: RingSignal = {
    ring: true,
    message,
    timestamp: Date.now(),
  };

  await env.PHONE_DATA.put(`ring:${id}`, JSON.stringify(signal));

  return jsonResponse({
    success: true,
    message: `已触发设备 ${id} 响铃`,
  });
}

async function handleStop(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "需要 Authorization: Bearer API_SECRET" }, 401);
  }

  const providedSecret = authHeader.slice(7);
  if (providedSecret !== env.API_SECRET) {
    return jsonResponse({ error: "API 密钥错误" }, 401);
  }

  const body = await request.json<{ id: string }>();
  const { id } = body;

  if (!id) {
    return jsonResponse({ error: "需要设备 ID" }, 400);
  }

  await env.PHONE_DATA.put(`ring:${id}`, JSON.stringify({
    ring: false,
    message: "",
    timestamp: Date.now(),
  }));

  return jsonResponse({
    success: true,
    message: `已停止设备 ${id} 响铃`,
  });
}