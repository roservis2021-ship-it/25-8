const crypto = require("crypto");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const riderAccounts = new Map([
  ["1001", { userNumber: "1001", key: "2580", name: "R1" }],
  ["1002", { userNumber: "1002", key: "2581", name: "R2" }],
]);

const adminAccount = {
  user: process.env.ADMIN_USER || "admin",
  key: process.env.ADMIN_KEY || "2580",
};

const riderRates = {
  m: 5,
  p: 3,
  c: 60,
};

const paymentTimeoutMs = 5 * 60 * 1000;

function sendJson(response, status, payload) {
  response.status(status).set({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  response.send(JSON.stringify(payload));
}

function getBody(request) {
  return request.body && typeof request.body === "object" ? request.body : {};
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

function normalizePath(request) {
  const url = new URL(request.url, "http://localhost");
  return url.pathname.startsWith("/api") ? url.pathname : `/api${url.pathname}`;
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
    createdAt: order.createdAt || null,
  };
}

function riderOrder(order, liveClients = new Map()) {
  const liveCustomer = order.customerId ? liveClients.get(order.customerId) : null;
  const canTrack = ["paid", "on_route"].includes(order.status);
  return {
    ...publicOrder(order),
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

async function getRiderAccount(userNumber) {
  const key = String(userNumber || "");
  const doc = await db.collection("riderAccounts").doc(key).get();
  if (doc.exists && doc.data().active === false) return null;
  if (doc.exists && doc.data().active !== false) return { userNumber: key, ...doc.data() };
  return riderAccounts.get(key) || null;
}

async function logActivity(type, summary, data = {}) {
  await db.collection("activity").add({
    type,
    summary,
    data,
    createdAt: Date.now(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

function getAdminToken(body = {}, requestUrl = "", request = null) {
  const url = new URL(requestUrl || "/", "http://localhost");
  const authHeader = request ? String(request.headers.authorization || "") : "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);
  return body.adminToken || url.searchParams.get("adminToken");
}

async function getAdminSession(body = {}, requestUrl = "", request = null) {
  const token = getAdminToken(body, requestUrl, request);
  if (!token) return null;

  const session = await db.collection("adminSessions").doc(String(token)).get();
  return session.exists ? { id: session.id, ...session.data() } : null;
}

async function expireUnpaidOrders() {
  const expiresBefore = Date.now() - paymentTimeoutMs;
  const snapshot = await db
    .collection("orders")
    .where("status", "==", "pending_payment")
    .where("acceptedAt", "<", expiresBefore)
    .limit(25)
    .get();

  if (snapshot.empty) return;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

async function findNearbyRiders(order) {
  const snapshot = await db.collection("riders").where("status", "==", "available").get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((rider) => distanceKm(order.location, rider.location) <= 2);
}

async function getSessionRider(body = {}, requestUrl = "") {
  const url = new URL(requestUrl || "/", "http://localhost");
  const token = body.sessionToken || url.searchParams.get("sessionToken");
  if (!token) return null;

  const session = await db.collection("riderSessions").doc(String(token)).get();
  if (!session.exists) return null;

  const account = await getRiderAccount(session.data().userNumber);
  return account || null;
}

async function getRiderEarningsSummary(riderId) {
  const snapshot = await db.collection("orders").where("riderId", "==", riderId).get();
  const assignedOrders = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const paidOrders = assignedOrders.filter((order) =>
    ["paid", "on_route", "delivered"].includes(order.status),
  );

  return {
    current: assignedOrders.reduce((sum, order) => sum + getRiderEarnings(order), 0),
    paid: paidOrders.reduce((sum, order) => sum + getRiderEarnings(order), 0),
    orders: assignedOrders.length,
  };
}

async function hasActiveRiderOrder(riderId, ignoredOrderId = "") {
  const snapshot = await db
    .collection("orders")
    .where("riderId", "==", riderId)
    .where("status", "in", ["paid", "on_route"])
    .limit(10)
    .get();

  return snapshot.docs.some((doc) => doc.id !== ignoredOrderId);
}

async function listRiderAccounts() {
  const stored = await db.collection("riderAccounts").get();
  const accounts = new Map(riderAccounts);

  stored.docs.forEach((doc) => {
    const data = doc.data();
    if (data.active === false) {
      accounts.delete(doc.id);
      return;
    }
    accounts.set(doc.id, { userNumber: doc.id, ...data });
  });

  return [...accounts.values()].map((account) => ({
    userNumber: account.userNumber,
    name: account.name,
    active: account.active !== false,
  }));
}

function getBusinessSummary(orders) {
  const paidOrders = orders.filter((order) =>
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

function getRiderAdminEarnings(riderAccountsList, orders) {
  return riderAccountsList.map((rider) => {
    const riderOrders = orders.filter((order) => order.riderId === rider.userNumber);
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
  await expireUnpaidOrders();

  if (request.method === "POST" && pathname === "/api/rider/login") {
    const body = getBody(request);
    const account = await getRiderAccount(body.userNumber);
    if (!account || account.key !== String(body.key || "")) {
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }

    const sessionToken = crypto.randomUUID();
    await db.collection("riderSessions").doc(sessionToken).set({
      userNumber: account.userNumber,
      createdAt: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    sendJson(response, 200, {
      sessionToken,
      rider: { id: account.userNumber, name: account.name, status: "inactive" },
    });
    await logActivity("rider_login", `Rider ${account.name} ha entrado`, {
      riderId: account.userNumber,
      riderName: account.name,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/clients/status") {
    const body = getBody(request);
    const clientId = String(body.clientId || crypto.randomUUID());
    const client = {
      id: clientId,
      name: body.name || "",
      phone: body.phone || "",
      contactRequested: Boolean(body.contactRequested),
      location: body.location || null,
      active: Boolean(body.active),
      updatedAt: Date.now(),
    };

    await db.collection("clients").doc(clientId).set(client, { merge: true });
    await logActivity("client_status", `Cliente ${client.name || clientId} activo`, {
      clientId,
      name: client.name,
      contactRequested: client.contactRequested,
    });
    sendJson(response, 200, { client });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rider/status") {
    const body = getBody(request);
    const account = await getSessionRider(body);
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

    await db.collection("riders").doc(rider.id).set(rider, { merge: true });
    await logActivity("rider_status", `Rider ${rider.name} esta ${rider.status}`, {
      riderId: rider.id,
      status: rider.status,
      location: rider.location,
    });
    sendJson(response, 200, { rider });
    return;
  }

  if (request.method === "POST" && pathname === "/api/rider/location") {
    const body = getBody(request);
    const account = await getSessionRider(body);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }

    const riderRef = db.collection("riders").doc(account.userNumber);
    const riderDoc = await riderRef.get();
    const current = riderDoc.exists ? { id: riderDoc.id, ...riderDoc.data() } : {};
    const rider = {
      ...current,
      id: account.userNumber,
      name: account.name,
      status: current.status || "inactive",
      location: body.location || current.location || null,
      updatedAt: Date.now(),
    };

    await riderRef.set(
      {
        name: rider.name,
        status: rider.status,
        location: rider.location,
        updatedAt: rider.updatedAt,
        updatedAtServer: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    sendJson(response, 200, { rider });
    return;
  }

  if (request.method === "GET" && pathname === "/api/rider/orders") {
    const account = await getSessionRider({}, request.url);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }

    const riderId = account.userNumber;
    const riderDoc = await db.collection("riders").doc(riderId).get();
    const rider = riderDoc.exists ? { id: riderDoc.id, ...riderDoc.data() } : null;

    const searchingSnapshot = await db
      .collection("orders")
      .where("status", "==", "searching_rider")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const assignedSnapshot = await db.collection("orders").where("riderId", "==", riderId).get();

    const availableOrders = searchingSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((order) => {
        if (!rider || rider.status !== "available") return false;
        return distanceKm(order.location, rider.location) <= 2;
      });
    const assignedOrders = assignedSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const liveClientIds = [
      ...new Set(
        assignedOrders
          .filter((order) => ["paid", "on_route"].includes(order.status) && order.customerId)
          .map((order) => order.customerId),
      ),
    ];
    const liveClientDocs = await Promise.all(
      liveClientIds.map((clientId) => db.collection("clients").doc(clientId).get()),
    );
    const liveClients = new Map(
      liveClientDocs
        .filter((doc) => doc.exists)
        .map((doc) => [doc.id, { id: doc.id, ...doc.data() }]),
    );

    sendJson(response, 200, {
      rider: rider || { id: riderId, status: "inactive" },
      earnings: await getRiderEarningsSummary(riderId),
      orders: [...availableOrders.map(publicOrder), ...assignedOrders.map((order) => riderOrder(order, liveClients))],
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/orders") {
    const body = getBody(request);
    const ref = db.collection("orders").doc();
    const order = {
      id: ref.id,
      status: "searching_rider",
      customerName: body.customerName || "",
      address: body.address || "",
      items: Array.isArray(body.items) ? body.items : [],
      total: Number(body.total) || 0,
      location: body.location || null,
      customerId: body.customerId || null,
      riderId: null,
      createdAt: Date.now(),
      acceptedAt: null,
      paidAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    const nearbyRiders = await findNearbyRiders(order);
    await ref.set({ ...order, nearbyRiders: nearbyRiders.map((rider) => rider.id) });
    await logActivity("order_created", `Nuevo pedido de ${order.customerName || "cliente"}`, {
      orderId: order.id,
      customerName: order.customerName,
      total: order.total,
      nearbyRiders: nearbyRiders.map((rider) => rider.id),
    });

    sendJson(response, 201, {
      order: publicOrder(order),
      nearbyRiders: nearbyRiders.map((rider) => rider.id),
    });
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/api/orders/")) {
    const id = pathname.split("/").pop();
    const doc = await db.collection("orders").doc(id).get();
    if (!doc.exists) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    sendJson(response, 200, { order: publicOrder({ id: doc.id, ...doc.data() }) });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/accept$/)) {
    const id = pathname.split("/")[3];
    const body = getBody(request);
    const account = await getSessionRider(body);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }

    const result = await db.runTransaction(async (transaction) => {
      const orderRef = db.collection("orders").doc(id);
      const riderRef = db.collection("riders").doc(account.userNumber);
      const [orderDoc, riderDoc] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(riderRef),
      ]);
      const order = orderDoc.exists ? { id: orderDoc.id, ...orderDoc.data() } : null;
      const rider = riderDoc.exists ? { id: riderDoc.id, ...riderDoc.data() } : null;

      if (
        !order ||
        !rider ||
        rider.status !== "available" ||
        order.status !== "searching_rider" ||
        distanceKm(order.location, rider.location) > 2
      ) {
        return null;
      }

      const nextOrder = {
        ...order,
        status: "pending_payment",
        riderId: rider.id,
        acceptedAt: Date.now(),
      };
      transaction.update(orderRef, {
        status: nextOrder.status,
        riderId: nextOrder.riderId,
        acceptedAt: nextOrder.acceptedAt,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { order: nextOrder, rider };
    });

    if (!result) {
      sendJson(response, 409, { error: "not_available" });
      return;
    }

    sendJson(response, 200, { order: publicOrder(result.order), rider: result.rider });
    await logActivity("order_accepted", `Pedido aceptado por ${result.rider.name || result.rider.id}`, {
      orderId: result.order.id,
      riderId: result.rider.id,
      riderName: result.rider.name,
    });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/pay$/)) {
    const id = pathname.split("/")[3];
    const result = await db.runTransaction(async (transaction) => {
      const orderRef = db.collection("orders").doc(id);
      const orderDoc = await transaction.get(orderRef);
      const order = orderDoc.exists ? { id: orderDoc.id, ...orderDoc.data() } : null;

      if (!order) return { missing: true };
      if (order.status !== "pending_payment") return null;

      const nextOrder = { ...order, status: "paid", paidAt: Date.now() };
      transaction.update(orderRef, {
        status: nextOrder.status,
        paidAt: nextOrder.paidAt,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (order.riderId) {
        transaction.set(
          db.collection("riders").doc(order.riderId),
          { status: "busy", updatedAt: Date.now() },
          { merge: true },
        );
      }

      return { order: nextOrder };
    });

    if (result && result.missing) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!result) {
      sendJson(response, 409, { error: "payment_not_available" });
      return;
    }

    sendJson(response, 200, { order: publicOrder(result.order) });
    await logActivity("order_paid", `Pedido pagado: ${result.order.id}`, {
      orderId: result.order.id,
      riderId: result.order.riderId,
      total: result.order.total,
    });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/start$/)) {
    const id = pathname.split("/")[3];
    const body = getBody(request);
    const account = await getSessionRider(body);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }

    const ref = db.collection("orders").doc(id);
    const doc = await ref.get();
    const order = doc.exists ? { id: doc.id, ...doc.data() } : null;
    if (!order || order.status !== "paid" || order.riderId !== account.userNumber) {
      sendJson(response, 409, { error: "delivery_not_available" });
      return;
    }

    const nextOrder = { ...order, status: "on_route" };
    await ref.update({ status: nextOrder.status, updatedAt: FieldValue.serverTimestamp() });
    sendJson(response, 200, { order: publicOrder(nextOrder) });
    await logActivity("order_on_route", `Entrega iniciada: ${nextOrder.id}`, {
      orderId: nextOrder.id,
      riderId: nextOrder.riderId,
    });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/orders\/[^/]+\/deliver$/)) {
    const id = pathname.split("/")[3];
    const body = getBody(request);
    const account = await getSessionRider(body);
    if (!account) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }

    const ref = db.collection("orders").doc(id);
    const doc = await ref.get();
    const order = doc.exists ? { id: doc.id, ...doc.data() } : null;
    if (!order || order.status !== "on_route" || order.riderId !== account.userNumber) {
      sendJson(response, 409, { error: "delivery_confirmation_not_available" });
      return;
    }

    const nextOrder = { ...order, status: "delivered", deliveredAt: Date.now() };
    const riderStatus = (await hasActiveRiderOrder(account.userNumber, id)) ? "busy" : "available";
    await Promise.all([
      ref.update({
        status: nextOrder.status,
        deliveredAt: nextOrder.deliveredAt,
        updatedAt: FieldValue.serverTimestamp(),
      }),
      db.collection("riders").doc(account.userNumber).set(
        { status: riderStatus, updatedAt: Date.now() },
        { merge: true },
      ),
    ]);

    sendJson(response, 200, {
      order: publicOrder(nextOrder),
      rider: { id: account.userNumber, status: riderStatus },
    });
    await logActivity("order_delivered", `Pedido entregado: ${nextOrder.id}`, {
      orderId: nextOrder.id,
      riderId: nextOrder.riderId,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    const body = getBody(request);
    if (String(body.user || "") !== adminAccount.user || String(body.key || "") !== adminAccount.key) {
      sendJson(response, 401, { error: "invalid_credentials" });
      return;
    }

    const adminToken = crypto.randomUUID();
    await db.collection("adminSessions").doc(adminToken).set({
      user: adminAccount.user,
      createdAt: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await logActivity("admin_login", "Admin ha entrado", {});
    sendJson(response, 200, { adminToken });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/dashboard") {
    const session = await getAdminSession({}, request.url, request);
    if (!session) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }

    const activeSince = Date.now() - 15 * 60 * 1000;
    const [clientsSnapshot, ridersSnapshot, ordersSnapshot, activitySnapshot, riderAccountsList] =
      await Promise.all([
        db.collection("clients").where("active", "==", true).get(),
        db.collection("riders").get(),
        db.collection("orders").orderBy("createdAt", "desc").limit(100).get(),
        db.collection("activity").orderBy("createdAt", "desc").limit(50).get(),
        listRiderAccounts(),
      ]);

    const clients = clientsSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((client) => client.updatedAt >= activeSince && client.location);
    const riders = ridersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const orders = ordersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const activity = activitySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    sendJson(response, 200, {
      clients,
      riders,
      orders: orders.map(adminOrder),
      requestedOrders: orders.filter((order) => order.status === "searching_rider").map(adminOrder),
      acceptedOrders: orders
        .filter((order) => ["pending_payment", "paid", "on_route", "delivered"].includes(order.status))
        .map(adminOrder),
      business: getBusinessSummary(orders),
      riderEarnings: getRiderAdminEarnings(riderAccountsList, orders),
      riderAccounts: riderAccountsList,
      activity,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/riders") {
    const body = getBody(request);
    const session = await getAdminSession(body, request.url, request);
    if (!session) {
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

    const account = {
      userNumber,
      key,
      name,
      active: true,
      createdAt: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await db.collection("riderAccounts").doc(userNumber).set(account, { merge: true });
    await logActivity("admin_rider_created", `Admin anadio rider ${name}`, {
      riderId: userNumber,
      riderName: name,
    });
    sendJson(response, 201, {
      rider: { userNumber, name, active: true },
    });
    return;
  }

  if (request.method === "POST" && pathname.match(/^\/api\/admin\/riders\/[^/]+\/delete$/)) {
    const id = pathname.split("/")[4];
    const body = getBody(request);
    const session = await getAdminSession(body, request.url, request);
    if (!session) {
      sendJson(response, 401, { error: "not_authenticated" });
      return;
    }

    const batch = db.batch();
    batch.set(
      db.collection("riderAccounts").doc(id),
      { active: false, deletedAt: Date.now(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    batch.delete(db.collection("riders").doc(id));

    const sessions = await db.collection("riderSessions").where("userNumber", "==", id).get();
    sessions.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    await logActivity("admin_rider_deleted", `Admin borro rider ${id}`, { riderId: id });
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

exports.api = onRequest(
  {
    region: "europe-west1",
    cors: true,
  },
  async (request, response) => {
    if (request.method === "OPTIONS") {
      response.status(204).set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      response.end();
      return;
    }

    try {
      await handleApi(request, response, normalizePath(request));
    } catch (error) {
      console.error(error);
      sendJson(response, 500, { error: "server_error", message: error.message });
    }
  },
);
