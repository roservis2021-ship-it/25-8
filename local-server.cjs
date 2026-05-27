const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT) || 8000;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
};

const riders = new Map();
const orders = new Map();
const clients = new Map();
const riderAccounts = new Map([
  ["1001", { userNumber: "1001", key: "2580", name: "R1" }],
  ["1002", { userNumber: "1002", key: "2581", name: "R2" }],
]);
const riderSessions = new Map();
const adminSessions = new Map();
const activity = [];
const adminAccount = { user: "admin", key: "2580" };
const riderRates = {
  m: 5,
  p: 3,
  c: 60,
};
const paymentTimeoutMs = 5 * 60 * 1000;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
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

function findNearbyRiders(order) {
  expireUnpaidOrders();
  return [...riders.values()].filter((rider) => {
    if (rider.status !== "available") return false;
    return distanceKm(order.location, rider.location) <= 2;
  });
}

function expireUnpaidOrders() {
  const now = Date.now();

  for (const [id, order] of orders.entries()) {
    if (order.status !== "pending_payment") continue;
    if (!order.acceptedAt || now - order.acceptedAt < paymentTimeoutMs) continue;

    orders.delete(id);
  }
}

function publicOrder(order) {
  return {
    id: order.id,
    status: order.status,
    customerName: order.customerName,
    address: order.address,
    items: order.items,
    total: order.total,
    riderEarnings: getRiderEarnings(order),
    riderId: order.riderId,
    createdAt: order.createdAt,
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

function getRiderEarnings(order) {
  return (order.items || []).reduce((sum, item) => {
    const rate = riderRates[String(item.id || "").toLowerCase()] || 0;
    return sum + rate * (Number(item.quantity) || 0);
  }, 0);
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

function hasPaidRiderOrder(riderId) {
  return [...orders.values()].some((order) => {
    return order.riderId === riderId && ["paid", "on_route"].includes(order.status);
  });
}

function createSession(userNumber) {
  const token = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  riderSessions.set(token, userNumber);
  return token;
}

function getSessionRider(body = {}, requestUrl = "") {
  const url = new URL(requestUrl, "http://localhost");
  const token = body.sessionToken || url.searchParams.get("sessionToken");
  const userNumber = riderSessions.get(token);
  if (!userNumber) return null;
  return riderAccounts.get(userNumber) || null;
}

function getAdminSession(body = {}, requestUrl = "") {
  const url = new URL(requestUrl, "http://localhost");
  const token = body.adminToken || url.searchParams.get("adminToken");
  if (!token) return null;
  return adminSessions.get(token) || null;
}

function getBusinessSummary(allOrders) {
  const paidOrders = allOrders.filter((order) =>
    ["paid", "on_route", "delivered"].includes(order.status),
  );
  const gross = paidOrders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  const riderPayout = paidOrders.reduce((sum, order) => sum + getRiderEarnings(order), 0);

  return {
    gross,
    riderPayout,
    net: gross - riderPayout,
    paidOrders: paidOrders.length,
  };
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

async function handleApi(request, response, pathname) {
  try {
    expireUnpaidOrders();

    if (request.method === "POST" && pathname === "/api/rider/login") {
      const body = await readBody(request);
      const account = riderAccounts.get(String(body.userNumber || ""));
      if (!account || account.key !== String(body.key || "")) {
        sendJson(response, 401, { error: "invalid_credentials" });
        return;
      }

      const sessionToken = createSession(account.userNumber);
      sendJson(response, 200, {
        sessionToken,
        rider: { id: account.userNumber, name: account.name, status: "inactive" },
      });
      logActivity("rider_login", `Rider ${account.name} ha entrado`, {
        riderId: account.userNumber,
        riderName: account.name,
      });
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

    if (request.method === "POST" && pathname === "/api/clients/status") {
      const body = await readBody(request);
      const clientId = String(body.clientId || `client-${Date.now()}`);
      const client = {
        id: clientId,
        name: body.name || "",
        phone: body.phone || "",
        contactRequested: Boolean(body.contactRequested),
        location: body.location || null,
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

    if (request.method === "GET" && pathname === "/api/admin/dashboard") {
      const account = getAdminSession({}, request.url);
      if (!account) {
        sendJson(response, 401, { error: "not_authenticated" });
        return;
      }

      const activeSince = Date.now() - 15 * 60 * 1000;
      const allOrders = [...orders.values()].sort((a, b) => b.createdAt - a.createdAt);
      const activeClients = [...clients.values()].filter((client) => {
        return client.active && client.location && client.updatedAt >= activeSince;
      });
      const riderAccountsList = [...riderAccounts.values()].map((rider) => ({
        userNumber: rider.userNumber,
        name: rider.name,
        active: true,
      }));

      sendJson(response, 200, {
        clients: activeClients,
        riders: [...riders.values()],
        orders: allOrders.map(adminOrder),
        requestedOrders: allOrders
          .filter((order) => order.status === "searching_rider")
          .map(adminOrder),
        acceptedOrders: allOrders
          .filter((order) => ["pending_payment", "paid", "on_route", "delivered"].includes(order.status))
          .map(adminOrder),
        business: getBusinessSummary(allOrders),
        riderEarnings: getRiderAdminEarnings(),
        riderAccounts: riderAccountsList,
        activity,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/admin/riders") {
      const body = await readBody(request);
      const account = getAdminSession(body, request.url);
      if (!account) {
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

      const rider = { userNumber, key, name };
      riderAccounts.set(userNumber, rider);
      logActivity("admin_rider_created", `Admin anadio rider ${name}`, {
        riderId: userNumber,
        riderName: name,
      });
      sendJson(response, 201, { rider: { userNumber, name, active: true } });
      return;
    }

    if (request.method === "POST" && pathname.match(/^\/api\/admin\/riders\/[^/]+\/delete$/)) {
      const id = pathname.split("/")[4];
      const body = await readBody(request);
      const account = getAdminSession(body, request.url);
      if (!account) {
        sendJson(response, 401, { error: "not_authenticated" });
        return;
      }

      riderAccounts.delete(id);
      riders.delete(id);
      for (const [token, riderId] of riderSessions.entries()) {
        if (riderId === id) riderSessions.delete(token);
      }
      logActivity("admin_rider_deleted", `Admin borro rider ${id}`, { riderId: id });
      sendJson(response, 200, { ok: true });
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
        location: body.location || null,
        updatedAt: Date.now(),
      };
      riders.set(rider.id, rider);
      logActivity("rider_status", `Rider ${rider.name} esta ${rider.status}`, {
        riderId: rider.id,
        status: rider.status,
        location: rider.location,
      });
      sendJson(response, 200, { rider });
      return;
    }

    if (request.method === "GET" && pathname === "/api/rider/orders") {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const account = getSessionRider({}, request.url);
      if (!account) {
        sendJson(response, 401, { error: "not_authenticated" });
        return;
      }
      const riderId = account.userNumber;
      const rider = riders.get(riderId);
      const availableOrders = [...orders.values()].filter((order) => {
        if (order.status !== "searching_rider") return false;
        if (!rider || rider.status !== "available") return false;
        return distanceKm(order.location, rider.location) <= 2;
      });
      const assignedOrders = [...orders.values()].filter((order) => order.riderId === riderId);
      sendJson(response, 200, {
        rider: rider || { id: riderId, status: "inactive" },
        earnings: getRiderEarningsSummary(riderId),
        orders: [...availableOrders, ...assignedOrders].map(publicOrder),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/orders") {
      const body = await readBody(request);
      const id = `order-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const order = {
        id,
        status: "searching_rider",
        customerName: body.customerName,
        address: body.address,
        items: body.items || [],
        total: body.total || 0,
        location: body.location || null,
        customerId: body.customerId || null,
        riderId: null,
        createdAt: Date.now(),
        acceptedAt: null,
        paidAt: null,
      };
      order.nearbyRiders = findNearbyRiders(order).map((rider) => rider.id);
      orders.set(id, order);
      logActivity("order_created", `Nuevo pedido de ${order.customerName || "cliente"}`, {
        orderId: order.id,
        customerName: order.customerName,
        total: order.total,
        nearbyRiders: order.nearbyRiders,
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
      rider.status = "available";
      logActivity("order_accepted", `Pedido aceptado por ${rider.name || rider.id}`, {
        orderId: order.id,
        riderId: rider.id,
        riderName: rider.name,
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
      logActivity("order_paid", `Pedido pagado: ${order.id}`, {
        orderId: order.id,
        riderId: order.riderId,
        total: order.total,
      });
      sendJson(response, 200, { order: publicOrder(order) });
      return;
    }

    if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/start$/)) {
      const id = pathname.split("/")[3];
      const body = await readBody(request);
      const account = getSessionRider(body);
      if (!account) {
        sendJson(response, 401, { error: "not_authenticated" });
        return;
      }
      const order = orders.get(id);
      if (!order || order.status !== "paid" || order.riderId !== account.userNumber) {
        sendJson(response, 409, { error: "delivery_not_available" });
        return;
      }
      order.status = "on_route";
      logActivity("order_on_route", `Entrega iniciada: ${order.id}`, {
        orderId: order.id,
        riderId: order.riderId,
      });
      sendJson(response, 200, { order: publicOrder(order) });
      return;
    }

    if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/deliver$/)) {
      const id = pathname.split("/")[3];
      const body = await readBody(request);
      const account = getSessionRider(body);
      if (!account) {
        sendJson(response, 401, { error: "not_authenticated" });
        return;
      }
      const order = orders.get(id);
      const rider = riders.get(account.userNumber);
      if (!order || order.status !== "on_route" || order.riderId !== account.userNumber) {
        sendJson(response, 409, { error: "delivery_confirmation_not_available" });
        return;
      }
      order.status = "delivered";
      order.deliveredAt = Date.now();
      if (rider) rider.status = hasPaidRiderOrder(account.userNumber) ? "busy" : "available";
      logActivity("order_delivered", `Pedido entregado: ${order.id}`, {
        orderId: order.id,
        riderId: order.riderId,
      });
      sendJson(response, 200, { order: publicOrder(order), rider });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 500, { error: "server_error", message: error.message });
  }
}

function serveStatic(request, response, pathname) {
  const target = path.resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);

  if (!target.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(target, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": types[path.extname(target)] || "application/octet-stream",
    });
    response.end(content);
  });
}

http
  .createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      response.end();
      return;
    }

    if (pathname.startsWith("/api/")) {
      handleApi(request, response, pathname);
      return;
    }

    serveStatic(request, response, pathname);
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`25/8 cliente: http://localhost:${port}`);
    console.log(`25/8 repartidor: http://localhost:${port}/rider.html`);
    console.log(`25/8 admin: http://localhost:${port}/admin.html`);
    console.log("Deja esta ventana abierta mientras lo pruebas.");
  });
