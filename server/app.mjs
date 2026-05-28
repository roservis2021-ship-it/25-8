import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.PORT) || 10000;
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const riderAccountsPath = path.join(dataDir, "rider-accounts.json");
const defaultRiderAccounts = [
  ["1001", { userNumber: "1001", key: "2580", name: "R1" }],
  ["1002", { userNumber: "1002", key: "2581", name: "R2" }],
];

const riders = new Map();
const orders = new Map();
const clients = new Map();
const riderAccounts = loadRiderAccounts();
const riderSessions = new Map();
const adminSessions = new Map();
const activity = [];

const adminAccount = {
  user: process.env.ADMIN_USER || "admin",
  key: process.env.ADMIN_KEY || "WON-admin-8Q4V-2026-verde",
};
const riderRates = { m: 5, p: 3, c: 60 };
const paymentTimeoutMs = 5 * 60 * 1000;
const maxLocationAccuracyMeters = 250;
const liveLocationTimeoutMs = 10 * 60 * 1000;

function loadRiderAccounts() {
  try {
    if (fs.existsSync(riderAccountsPath)) {
      const stored = JSON.parse(fs.readFileSync(riderAccountsPath, "utf8"));
      return new Map(stored.map((account) => [String(account.userNumber), account]));
    }
  } catch {}
  return new Map(defaultRiderAccounts);
}

function persistRiderAccounts() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(riderAccountsPath, JSON.stringify([...riderAccounts.values()], null, 2));
  } catch (error) {
    console.error("Could not persist rider accounts", error);
  }
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizedPhone(value) {
  const raw = String(value || "").trim();
  const digits = phoneDigits(raw);
  if (raw.startsWith("+34") && digits.startsWith("34")) return digits.slice(2);
  if (digits.startsWith("0034")) return digits.slice(4);
  if (digits.startsWith("34") && digits.length === 11) return digits.slice(2);
  return digits;
}

function isValidPhone(value) {
  const digits = normalizedPhone(value);
  return digits.length >= 9 && digits.length <= 15;
}

function normalizeLocation(location) {
  if (!location) return null;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  const accuracy = Number(location.accuracy || 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (accuracy && accuracy > maxLocationAccuracyMeters) return null;
  return {
    lat,
    lng,
    accuracy: accuracy || null,
    updatedAt: Number(location.updatedAt || Date.now()),
  };
}

function isFreshLiveLocation(entry, now = Date.now()) {
  return entry?.location && Number(entry.updatedAt || 0) >= now - liveLocationTimeoutMs;
}

function pruneLiveState() {
  const now = Date.now();
  for (const [id, client] of clients.entries()) {
    if (client.active && !isFreshLiveLocation(client, now)) {
      clients.set(id, { ...client, active: false, location: null, updatedAt: now });
    }
  }

  for (const [id, rider] of riders.entries()) {
    if (!isFreshLiveLocation(rider, now)) {
      riders.set(id, { ...rider, status: "inactive", location: null, updatedAt: now });
    }
  }
}

function closeExistingRiderSessions(userNumber, exceptToken = "") {
  for (const [token, riderId] of riderSessions.entries()) {
    if (riderId === userNumber && token !== exceptToken) riderSessions.delete(token);
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function distanceKm(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const earthKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.sqrt(h));
}

function getRiderEarnings(order) {
  return (order.items || []).reduce((sum, item) => {
    const rate = riderRates[String(item.id || "").toLowerCase()] || 0;
    return sum + rate * (Number(item.quantity) || 0);
  }, 0);
}

function publicOrder(order) {
  return {
    id: order.id,
    status: order.status,
    customerName: order.customerName,
    address: order.address,
    items: order.items || [],
    total: order.total || 0,
    riderEarnings: getRiderEarnings(order),
    riderId: order.riderId || null,
    createdAt: order.createdAt,
  };
}

function getLiveCustomer(order) {
  if (!order.customerId) return null;
  return clients.get(order.customerId) || null;
}

function riderOrder(order) {
  const liveCustomer = getLiveCustomer(order);
  const canTrack = ["paid", "on_route"].includes(order.status);
  return {
    ...publicOrder(order),
    customerPhone: liveCustomer?.phone || order.customerPhone || "",
    location: canTrack ? liveCustomer?.location || order.location || null : null,
    customerLocationUpdatedAt: canTrack ? liveCustomer?.updatedAt || null : null,
  };
}

function adminOrder(order) {
  return {
    ...publicOrder(order),
    location: order.location || null,
    customerId: order.customerId || null,
    acceptedAt: order.acceptedAt || null,
    paidAt: order.paidAt || null,
    deliveredAt: order.deliveredAt || null,
    nearbyRiders: order.nearbyRiders || [],
  };
}

function logActivity(type, summary, data = {}) {
  activity.unshift({
    id: `activity-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    summary,
    data,
    createdAt: Date.now(),
  });
  if (activity.length > 100) activity.length = 100;
}

function expireUnpaidOrders() {
  const now = Date.now();
  for (const [id, order] of orders.entries()) {
    if (order.status !== "pending_payment") continue;
    if (!order.acceptedAt || now - order.acceptedAt < paymentTimeoutMs) continue;
    orders.delete(id);
    logActivity("order_expired", `Pedido caducado: ${id}`, { orderId: id });
  }
}

function getSessionRider(body = {}, requestUrl = "") {
  const url = new URL(requestUrl || "/", "http://localhost");
  const token = body.sessionToken || url.searchParams.get("sessionToken");
  const userNumber = riderSessions.get(token);
  if (!userNumber) return null;
  return riderAccounts.get(userNumber) || null;
}

function closeRiderSession(body = {}) {
  const token = body.sessionToken || "";
  const userNumber = riderSessions.get(token);
  if (!userNumber) return null;
  riderSessions.delete(token);
  return riderAccounts.get(userNumber) || null;
}

function getAdminSession(body = {}, requestUrl = "") {
  const url = new URL(requestUrl || "/", "http://localhost");
  const token = body.adminToken || url.searchParams.get("adminToken");
  return token ? adminSessions.get(token) || null : null;
}

function getBusinessSummary(allOrders) {
  const paidOrders = allOrders.filter((order) =>
    ["paid", "on_route", "delivered"].includes(order.status),
  );
  const gross = paidOrders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  const riderPayout = paidOrders.reduce((sum, order) => sum + getRiderEarnings(order), 0);
  return { gross, riderPayout, net: gross - riderPayout, paidOrders: paidOrders.length };
}

function getRiderAdminEarnings() {
  return [...riderAccounts.values()].map((rider) => {
    const riderOrders = [...orders.values()].filter((order) => order.riderId === rider.userNumber);
    const paidOrders = riderOrders.filter((order) =>
      ["paid", "on_route", "delivered"].includes(order.status),
    );
    const gross = paidOrders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    const net = paidOrders.reduce((sum, order) => sum + getRiderEarnings(order), 0);
    return {
      riderId: rider.userNumber,
      riderName: rider.name,
      gross,
      net,
      businessNet: gross - net,
      orders: riderOrders.length,
      paidOrders: paidOrders.length,
    };
  });
}

function getRiderEarningsSummary(riderId) {
  const assignedOrders = [...orders.values()].filter((order) => order.riderId === riderId);
  const paidOrders = assignedOrders.filter((order) =>
    ["paid", "on_route", "delivered"].includes(order.status),
  );
  return {
    current: assignedOrders.reduce((sum, order) => sum + getRiderEarnings(order), 0),
    paid: paidOrders.reduce((sum, order) => sum + getRiderEarnings(order), 0),
    orders: assignedOrders.length,
  };
}

function hasActiveRiderOrder(riderId, ignoredOrderId = "") {
  return [...orders.values()].some((order) => {
    return (
      order.id !== ignoredOrderId &&
      order.riderId === riderId &&
      ["paid", "on_route"].includes(order.status)
    );
  });
}

async function handleApi(request, response, pathname) {
  pruneLiveState();
  expireUnpaidOrders();

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "won-render-api" });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    const body = await readBody(request);
    if (String(body.user || "") !== adminAccount.user || String(body.key || "") !== adminAccount.key) {
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }
    const adminToken = `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    adminSessions.set(adminToken, { user: adminAccount.user, createdAt: Date.now() });
    logActivity("admin_login", "Admin ha entrado");
    sendJson(response, 200, { adminToken });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/dashboard") {
    if (!getAdminSession({}, request.url)) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }
    const activeSince = Date.now() - liveLocationTimeoutMs;
    const allOrders = [...orders.values()].sort((a, b) => b.createdAt - a.createdAt);
    const activeClients = [...clients.values()].filter((client) => {
      return client.active && client.location && client.updatedAt >= activeSince;
    });
    const liveRiders = [...riders.values()].map((rider) => {
      if (!isFreshLiveLocation(rider)) return { ...rider, status: "inactive", location: null };
      return rider;
    });
    sendJson(response, 200, {
      clients: activeClients,
      riders: liveRiders,
      orders: allOrders.map(adminOrder),
      requestedOrders: allOrders
        .filter((order) => order.status === "searching_rider")
        .map(adminOrder),
      acceptedOrders: allOrders
        .filter((order) => ["pending_payment", "paid", "on_route", "delivered"].includes(order.status))
        .map(adminOrder),
      business: getBusinessSummary(allOrders),
      riderEarnings: getRiderAdminEarnings(),
      riderAccounts: [...riderAccounts.values()].map((rider) => ({
        userNumber: rider.userNumber,
        name: rider.name,
        active: true,
      })),
      activity,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/riders") {
    const body = await readBody(request);
    if (!getAdminSession(body, request.url)) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }
    const userNumber = String(body.userNumber || "").trim();
    const key = String(body.key || "").trim();
    const name = String(body.name || "").trim();
    if (!userNumber || !key || !name) {
      sendJson(response, 400, { error: "missing_fields" });
      return;
    }
    riderAccounts.set(userNumber, { userNumber, key, name });
    persistRiderAccounts();
    logActivity("admin_rider_created", `Admin anadio rider ${name}`, { riderId: userNumber });
    sendJson(response, 201, { rider: { userNumber, name, active: true } });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/admin\/riders\/[^/]+\/delete$/)) {
    const id = pathname.split("/")[4];
    const body = await readBody(request);
    if (!getAdminSession(body, request.url)) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }
    riderAccounts.delete(id);
    persistRiderAccounts();
    riders.delete(id);
    for (const [token, riderId] of riderSessions.entries()) {
      if (riderId === id) riderSessions.delete(token);
    }
    logActivity("admin_rider_deleted", `Admin borro rider ${id}`, { riderId: id });
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/clients/status") {
    const body = await readBody(request);
    const clientId = String(body.clientId || `client-${Date.now()}`);
    const client = {
      id: clientId,
      name: body.name || "",
      phone: normalizedPhone(body.phone),
      contactRequested: Boolean(body.contactRequested),
      location: normalizeLocation(body.location),
      active: Boolean(body.active),
      updatedAt: Date.now(),
    };
    clients.set(clientId, client);
    logActivity("client_status", `Cliente ${client.name || clientId} activo`, {
      clientId,
      name: client.name,
      contactRequested: client.contactRequested,
    });
    sendJson(response, 200, { client });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rider/login") {
    const body = await readBody(request);
    const account = riderAccounts.get(String(body.userNumber || ""));
    if (!account || account.key !== String(body.key || "")) {
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }
    const sessionToken = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    closeExistingRiderSessions(account.userNumber);
    riderSessions.set(sessionToken, account.userNumber);
    logActivity("rider_login", `Rider ${account.name} ha entrado`, { riderId: account.userNumber });
    sendJson(response, 200, {
      sessionToken,
      rider: { id: account.userNumber, name: account.name, status: "inactive" },
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rider/status") {
    const body = await readBody(request);
    const account = getSessionRider(body);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }
    const rider = {
      id: account.userNumber,
      name: account.name,
      status: body.active ? "available" : "inactive",
      location: normalizeLocation(body.location),
      updatedAt: Date.now(),
    };
    if (body.active && !rider.location) {
      sendJson(response, 400, { error: "invalid_location" });
      return;
    }
    riders.set(rider.id, rider);
    logActivity("rider_status", `Rider ${rider.name} esta ${rider.status}`, {
      riderId: rider.id,
      status: rider.status,
    });
    sendJson(response, 200, { rider });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rider/logout") {
    const body = await readBody(request);
    const account = closeRiderSession(body);
    if (!account) {
      sendJson(response, 200, { ok: true });
      return;
    }
    const current = riders.get(account.userNumber) || {
      id: account.userNumber,
      name: account.name,
    };
    const rider = {
      ...current,
      id: account.userNumber,
      name: account.name,
      status: "inactive",
      location: normalizeLocation(body.location) || current.location || null,
      updatedAt: Date.now(),
    };
    riders.set(rider.id, rider);
    logActivity("rider_logout", `Rider ${rider.name} ha salido`, { riderId: rider.id });
    sendJson(response, 200, { rider });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rider/location") {
    const body = await readBody(request);
    const account = getSessionRider(body);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }

    const current = riders.get(account.userNumber) || {
      id: account.userNumber,
      name: account.name,
      status: "inactive",
    };
    const rider = {
      ...current,
      id: account.userNumber,
      name: account.name,
      location: normalizeLocation(body.location) || current.location || null,
      updatedAt: Date.now(),
    };
    riders.set(rider.id, rider);
    sendJson(response, 200, { rider });
    return;
  }

  if (request.method === "GET" && pathname === "/api/rider/orders") {
    const account = getSessionRider({}, request.url);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }
    const rider = riders.get(account.userNumber);
    const availableOrders = [...orders.values()].filter((order) => {
      return order.status === "searching_rider" && rider && rider.status === "available";
    });
    const assignedOrders = [...orders.values()].filter((order) => order.riderId === account.userNumber);
    sendJson(response, 200, {
      rider: rider || { id: account.userNumber, status: "inactive" },
      earnings: getRiderEarningsSummary(account.userNumber),
      orders: [...availableOrders.map(publicOrder), ...assignedOrders.map(riderOrder)],
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/orders") {
    const body = await readBody(request);
    const customerPhone = normalizedPhone(body.customerPhone);
    if (!isValidPhone(customerPhone)) {
      sendJson(response, 400, { error: "invalid_phone" });
      return;
    }
    const location = normalizeLocation(body.location);
    if (!location) {
      sendJson(response, 400, { error: "invalid_location" });
      return;
    }
    const id = `order-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const order = {
      id,
      status: "searching_rider",
      customerName: body.customerName,
      customerPhone,
      address: body.address,
      items: body.items || [],
      total: body.total || 0,
      location,
      customerId: body.customerId || null,
      riderId: null,
      createdAt: Date.now(),
      acceptedAt: null,
      paidAt: null,
      deliveredAt: null,
    };
    order.nearbyRiders = [...riders.values()]
      .filter((rider) => rider.status === "available" && distanceKm(order.location, rider.location) <= 2)
      .map((rider) => rider.id);
    orders.set(id, order);
    logActivity("order_created", `Nuevo pedido de ${order.customerName || "cliente"}`, {
      orderId: order.id,
      total: order.total,
    });
    sendJson(response, 201, { order: publicOrder(order), nearbyRiders: order.nearbyRiders });
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/api/orders/")) {
    const id = pathname.split("/").pop();
    const order = orders.get(id);
    if (!order) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    sendJson(response, 200, { order: publicOrder(order) });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/accept$/)) {
    const id = pathname.split("/")[3];
    const body = await readBody(request);
    const account = getSessionRider(body);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }
    const order = orders.get(id);
    const rider = riders.get(account.userNumber);
    if (!order || !rider || rider.status !== "available" || order.status !== "searching_rider") {
      sendJson(response, 409, { error: "not_available" });
      return;
    }
    order.status = "pending_payment";
    order.riderId = rider.id;
    order.acceptedAt = Date.now();
    logActivity("order_accepted", `Pedido aceptado por ${rider.name || rider.id}`, {
      orderId: order.id,
      riderId: rider.id,
    });
    sendJson(response, 200, { order: publicOrder(order), rider });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/pay$/)) {
    const id = pathname.split("/")[3];
    const order = orders.get(id);
    if (!order) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (order.status !== "pending_payment") {
      sendJson(response, 409, { error: "payment_not_available" });
      return;
    }
    order.status = "paid";
    order.paidAt = Date.now();
    const rider = riders.get(order.riderId);
    if (rider) rider.status = "busy";
    logActivity("order_paid", `Pedido pagado: ${order.id}`, { orderId: order.id });
    sendJson(response, 200, { order: publicOrder(order) });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/start$/)) {
    const id = pathname.split("/")[3];
    const body = await readBody(request);
    const account = getSessionRider(body);
    const order = orders.get(id);
    if (!account || !order || order.status !== "paid" || order.riderId !== account.userNumber) {
      sendJson(response, 409, { error: "delivery_not_available" });
      return;
    }
    order.status = "on_route";
    logActivity("order_on_route", `Entrega iniciada: ${order.id}`, { orderId: order.id });
    sendJson(response, 200, { order: publicOrder(order) });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/deliver$/)) {
    const id = pathname.split("/")[3];
    const body = await readBody(request);
    const account = getSessionRider(body);
    const order = orders.get(id);
    const rider = account ? riders.get(account.userNumber) : null;
    if (!account || !order || order.status !== "on_route" || order.riderId !== account.userNumber) {
      sendJson(response, 409, { error: "delivery_confirmation_not_available" });
      return;
    }
    order.status = "delivered";
    order.deliveredAt = Date.now();
    if (rider) rider.status = hasActiveRiderOrder(account.userNumber, id) ? "busy" : "available";
    logActivity("order_delivered", `Pedido entregado: ${order.id}`, { orderId: order.id });
    sendJson(response, 200, { order: publicOrder(order), rider });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    response.end();
    return;
  }

  if (pathname.startsWith("/api/")) {
    handleApi(request, response, pathname).catch((error) => {
      sendJson(response, 500, { error: "server_error", message: error.message });
    });
    return;
  }

  sendJson(response, 200, { ok: true, service: "won-render-api" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`WON API listening on ${port}`);
});
