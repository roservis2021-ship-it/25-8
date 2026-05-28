const apiBase = window.WON_API_BASE || (window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "");
const money = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const MAX_GPS_ACCURACY_METERS = 120;
const IDEAL_GPS_ACCURACY_METERS = 45;
const MAX_LOCATION_AGE_MS = 20_000;
const MAX_JUMP_SPEED_MPS = 45;

const loginGate = document.querySelector("#riderLoginGate");
const loginForm = document.querySelector("#riderLoginForm");
const userNumber = document.querySelector("#userNumber");
const userKey = document.querySelector("#userKey");
const logoutButton = document.querySelector("#logoutButton");
const activeToggle = document.querySelector("#activeToggle");
const riderState = document.querySelector("#riderState");
const riderNote = document.querySelector("#riderNote");
const riderOrders = document.querySelector("#riderOrders");
const currentEarnings = document.querySelector("#currentEarnings");
const paidEarnings = document.querySelector("#paidEarnings");
const riderMapPanel = document.querySelector("#riderMapPanel");
const riderMapEl = document.querySelector("#riderMap");
const riderMapEmpty = document.querySelector("#riderMapEmpty");
const riderMapDistance = document.querySelector("#riderMapDistance");
const riderMapTrend = document.querySelector("#riderMapTrend");
const contactCustomerButton = document.querySelector("#contactCustomerButton");
const deliveryDoneButton = document.querySelector("#deliveryDoneButton");
const toast = document.querySelector("#toast");

let active = false;
let poll = null;
let sessionToken = sessionStorage.getItem("riderSessionToken") || "";
let riderLocation = null;
let riderWatchId = null;
let riderMap = null;
let riderMapLayer = null;
let lastLiveDistance = null;
let liveOrderId = "";
let riderMapUserMoved = false;
let lastRiderLocationSentAt = 0;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/rider-sw.js?v=10")
      .then((registration) => registration.update())
      .catch(() => {});
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "api_error");
  return payload;
}

function withSession(body = {}) {
  return { ...body, sessionToken };
}

function distanceMeters(a, b) {
  if (!a || !b) return null;
  const earthMeters = 6371000;
  const dLat = ((Number(b.lat) - Number(a.lat)) * Math.PI) / 180;
  const dLng = ((Number(b.lng) - Number(a.lng)) * Math.PI) / 180;
  const lat1 = (Number(a.lat) * Math.PI) / 180;
  const lat2 = (Number(b.lat) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthMeters * Math.asin(Math.sqrt(h));
}

function locationFromPosition(position) {
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy || null,
    updatedAt: position.timestamp || Date.now(),
  };
}

function isFreshLocation(location) {
  return location && Date.now() - Number(location.updatedAt || 0) <= MAX_LOCATION_AGE_MS;
}

function isAccurateLocation(location) {
  return (
    location &&
    Number.isFinite(Number(location.lat)) &&
    Number.isFinite(Number(location.lng)) &&
    Number(location.accuracy || Number.POSITIVE_INFINITY) <= MAX_GPS_ACCURACY_METERS
  );
}

function isPlausibleLocation(next, previous = riderLocation) {
  if (!previous || !next) return true;
  const seconds = Math.max(1, (Number(next.updatedAt || Date.now()) - Number(previous.updatedAt || Date.now())) / 1000);
  const distance = distanceMeters(previous, next) || 0;
  const tolerance = Math.max(Number(previous.accuracy || 0), Number(next.accuracy || 0), 25);
  return distance <= tolerance || distance / seconds <= MAX_JUMP_SPEED_MPS;
}

function acceptRiderLocation(location) {
  if (!isFreshLocation(location) || !isAccurateLocation(location) || !isPlausibleLocation(location)) {
    return false;
  }
  riderLocation = location;
  return true;
}

function requestAccurateLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation || !window.isSecureContext) {
      reject(new Error("gps_unavailable"));
      return;
    }

    let best = null;
    let settled = false;
    let watchId = null;
    const finish = (location) => {
      if (settled) return;
      settled = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (acceptRiderLocation(location)) {
        resolve(riderLocation);
      } else {
        reject(new Error("gps_not_accurate"));
      }
    };

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const location = locationFromPosition(position);
        if (!isFreshLocation(location) || !isPlausibleLocation(location, best || riderLocation)) return;
        if (!best || Number(location.accuracy || Infinity) < Number(best.accuracy || Infinity)) best = location;
        if (Number(location.accuracy || Infinity) <= IDEAL_GPS_ACCURACY_METERS) finish(location);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
    );

    window.setTimeout(() => {
      if (best && Number(best.accuracy || Infinity) <= MAX_GPS_ACCURACY_METERS) {
        finish(best);
      } else {
        finish(null);
      }
    }, 10_000);
  });
}

function startRiderLocationWatch() {
  if (riderWatchId || !navigator.geolocation || !window.isSecureContext) return;

  riderWatchId = navigator.geolocation.watchPosition(
    (position) => {
      if (acceptRiderLocation(locationFromPosition(position))) {
        updateRiderLocation().catch(() => {});
      }
    },
    () => {},
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 },
  );
}

function stopRiderLocationWatch() {
  if (riderWatchId && navigator.geolocation) navigator.geolocation.clearWatch(riderWatchId);
  riderWatchId = null;
}

async function updateRiderLocation() {
  if (!sessionToken || !riderLocation) return;
  const now = Date.now();
  if (now - lastRiderLocationSentAt < 2_500) return;
  lastRiderLocationSentAt = now;
  await api("/api/rider/location", {
    method: "POST",
    body: JSON.stringify(withSession({ location: riderLocation })),
  });
}

function renderState(status) {
  const isAvailable = status === "available";
  const isBusy = status === "busy";
  active = isAvailable || isBusy;
  riderState.textContent = isBusy ? "OCUPADO" : isAvailable ? "ACTIVO" : "INACTIVO";
  activeToggle.classList.toggle("is-active", isAvailable);
  activeToggle.classList.toggle("is-busy", isBusy);
  activeToggle.setAttribute(
    "aria-label",
    isBusy ? "Rider ocupado" : isAvailable ? "Desactivar jornada" : "Activar jornada",
  );
  activeToggle.title = isBusy ? "Ocupado" : isAvailable ? "Desactivar" : "Activar";
  activeToggle.disabled = isBusy || !sessionToken;
  riderNote.textContent = isBusy
    ? "Pedido pagado asignado. Completa la entrega para volver a estar activo."
    : isAvailable
      ? "Disponible para solicitudes en 2 km. Los pedidos sin pago no bloquean tu jornada."
      : "Activa tu jornada para recibir solicitudes cercanas.";
}

function renderEarnings(earnings = {}) {
  currentEarnings.textContent = money.format(earnings.current || 0);
  paidEarnings.textContent = money.format(earnings.paid || 0);
}

function renderOrders(orders) {
  if (!orders.length) {
    riderOrders.innerHTML = `<p class="rider-note">Sin solicitudes por ahora.</p>`;
    return;
  }

  riderOrders.innerHTML = orders
    .map((order) => {
      const items = order.items.map((item) => `${item.quantity} gr ${item.name}`).join(" / ");
      const phone = String(order.customerPhone || "").replace(/\D/g, "");
      const phoneLine = phone
        ? `<a class="rider-phone-link" href="tel:${phone}">Llamar cliente: ${phone}</a>`
        : "";
      const actions = {
        searching_rider: `<button type="button" data-accept="${order.id}">ACEPTAR</button>`,
        pending_payment: `<span class="order-badge">ESPERANDO PAGO</span>`,
        paid: `<button type="button" data-start="${order.id}">INICIAR</button>`,
        on_route: `<button type="button" data-deliver="${order.id}">CONFIRMAR ENTREGA</button>`,
        delivered: `<span class="order-badge">ENTREGADO</span>`,
      };

      return `
        <article class="rider-order-card">
          <div>
            <strong>${money.format(order.total)}</strong>
            <span>${items}</span>
            <small>${order.address || "Sin referencia"}</small>
            ${phoneLine}
            <em>Ganas: ${money.format(order.riderEarnings || 0)}</em>
          </div>
          ${actions[order.status] || ""}
        </article>
      `;
    })
    .join("");
}

function getLeafletIcon(type) {
  return L.divIcon({
    className: `leaflet-status-marker ${type}`,
    html: "<span></span>",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function initRiderMap() {
  if (riderMap || !window.L || !riderMapEl) return;

  riderMap = L.map(riderMapEl, {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: true,
  }).setView([28.1235, -15.4366], 15);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(riderMap);

  riderMapLayer = L.layerGroup().addTo(riderMap);
  riderMap.on("zoomstart movestart", () => {
    riderMapUserMoved = true;
  });
}

function renderLiveMap(order, rider = {}) {
  const customerLocation = order?.location || null;
  const currentRiderLocation = rider.location || riderLocation;
  const shouldShow = order && ["paid", "on_route"].includes(order.status);
  const isDeliveryScreen = order?.status === "on_route";
  const orderChanged = order?.id && order.id !== liveOrderId;
  const customerPhone = String(order?.customerPhone || "").replace(/\D/g, "");

  document.body.classList.toggle("rider-delivery-mode", Boolean(isDeliveryScreen));
  riderMapPanel.classList.toggle("hidden", !shouldShow);
  contactCustomerButton.classList.toggle("hidden", !isDeliveryScreen || !customerPhone);
  contactCustomerButton.href = customerPhone ? `tel:${customerPhone}` : "#";
  deliveryDoneButton.classList.toggle("hidden", !isDeliveryScreen);
  deliveryDoneButton.dataset.deliver = isDeliveryScreen ? order.id : "";
  if (!shouldShow) {
    lastLiveDistance = null;
    liveOrderId = "";
    riderMapUserMoved = false;
    contactCustomerButton.href = "#";
    document.body.classList.remove("rider-delivery-mode");
    return;
  }

  if (orderChanged) {
    liveOrderId = order.id;
    riderMapUserMoved = false;
  }

  initRiderMap();
  if (!riderMap || !riderMapLayer) return;

  window.setTimeout(() => riderMap.invalidateSize({ pan: false }), 80);
  if (isDeliveryScreen) {
    window.setTimeout(() => riderMap.invalidateSize({ pan: false }), 300);
  }
  riderMapLayer.clearLayers();
  const points = [];

  if (customerLocation) {
    points.push([Number(customerLocation.lat), Number(customerLocation.lng)]);
    L.marker(points[points.length - 1], { icon: getLeafletIcon("client") })
      .bindPopup(`<strong>${order.customerName || "Cliente"}</strong>`)
      .addTo(riderMapLayer);
  }

  if (currentRiderLocation) {
    points.push([Number(currentRiderLocation.lat), Number(currentRiderLocation.lng)]);
    L.marker(points[points.length - 1], { icon: getLeafletIcon("rider-online") })
      .bindPopup("<strong>Tu posicion</strong>")
      .addTo(riderMapLayer);
  }

  riderMapEmpty.classList.toggle("hidden", points.length > 0);
  if (!riderMapUserMoved) {
    if (points.length === 1) riderMap.setView(points[0], 17);
    if (points.length > 1) riderMap.fitBounds(points, { padding: [36, 36], maxZoom: 17 });
  }

  const distance = distanceMeters(currentRiderLocation, customerLocation);
  if (distance == null) {
    riderMapDistance.textContent = "--";
    riderMapTrend.textContent = "Esperando ubicaciones.";
    return;
  }

  riderMapDistance.textContent =
    distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;

  if (lastLiveDistance == null || Math.abs(lastLiveDistance - distance) < 8) {
    riderMapTrend.textContent = "Movimiento estable.";
  } else {
    riderMapTrend.textContent = distance < lastLiveDistance ? "Te estas acercando." : "Te estas alejando.";
  }
  lastLiveDistance = distance;
}

async function syncStatus(nextActive = active) {
  const location = nextActive ? await requestAccurateLocation() : riderLocation;
  const { rider } = await api("/api/rider/status", {
    method: "POST",
    body: JSON.stringify(withSession({ active: nextActive, location })),
  });
  renderState(rider.status);
  return rider;
}

async function setInactiveBeforeLogout() {
  if (!sessionToken) return;
  try {
    await api("/api/rider/logout", {
      method: "POST",
      body: JSON.stringify(withSession({ location: riderLocation })),
    });
  } catch {
    try {
      await api("/api/rider/status", {
        method: "POST",
        body: JSON.stringify(withSession({ active: false, location: riderLocation })),
      });
    } catch {}
  }
}

async function loadOrders() {
  if (!sessionToken) return;
  const { rider, earnings, orders } = await api(
    `/api/rider/orders?sessionToken=${encodeURIComponent(sessionToken)}`,
  );
  renderState(rider.status);
  renderEarnings(earnings);
  renderOrders(orders);
  const liveOrder = orders.find((order) => ["paid", "on_route"].includes(order.status));
  renderLiveMap(liveOrder, rider);
}

function startPolling() {
  if (poll) window.clearInterval(poll);
  poll = window.setInterval(loadOrders, 2500);
}

function stopPolling() {
  if (poll) window.clearInterval(poll);
  poll = null;
}

function unlockDashboard() {
  loginGate.classList.add("hidden");
  activeToggle.disabled = false;
  startRiderLocationWatch();
  syncStatus(false).catch(() => {});
  loadOrders().catch(() => renderOrders([]));
  startPolling();
}

async function logout() {
  await setInactiveBeforeLogout();
  stopPolling();
  stopRiderLocationWatch();
  sessionToken = "";
  active = false;
  sessionStorage.removeItem("riderSessionToken");
  loginForm.reset();
  renderState("inactive");
  renderEarnings();
  renderOrders([]);
  renderLiveMap(null);
  loginGate.classList.remove("hidden");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const { sessionToken: token } = await api("/api/rider/login", {
      method: "POST",
      body: JSON.stringify({
        userNumber: userNumber.value.trim(),
        key: userKey.value.trim(),
      }),
    });
    sessionToken = token;
    sessionStorage.setItem("riderSessionToken", sessionToken);
    unlockDashboard();
  } catch {
    showToast("Credenciales no validas.");
  }
});

activeToggle.addEventListener("click", async () => {
  activeToggle.disabled = true;
  try {
    await syncStatus(!active);
    await loadOrders();
    startPolling();
  } catch (error) {
    showToast("Activa la ubicacion precisa y espera una senal GPS estable.");
  } finally {
    activeToggle.disabled = activeToggle.classList.contains("is-busy") || !sessionToken;
  }
});

logoutButton.addEventListener("click", logout);

deliveryDoneButton.addEventListener("click", async () => {
  if (!deliveryDoneButton.dataset.deliver) return;

  try {
    await api(`/api/orders/${deliveryDoneButton.dataset.deliver}/deliver`, {
      method: "POST",
      body: JSON.stringify(withSession()),
    });
    document.body.classList.remove("rider-delivery-mode");
    showToast("Entrega confirmada.");
    await loadOrders();
  } catch {
    showToast("La accion no esta disponible.");
  }
});

riderOrders.addEventListener("click", async (event) => {
  const accept = event.target.closest("[data-accept]");
  const start = event.target.closest("[data-start]");
  const deliver = event.target.closest("[data-deliver]");

  try {
    if (accept) {
      await api(`/api/orders/${accept.dataset.accept}/accept`, {
        method: "POST",
        body: JSON.stringify(withSession()),
      });
      showToast("Pedido aceptado.");
    }

    if (start) {
      await api(`/api/orders/${start.dataset.start}/start`, {
        method: "POST",
        body: JSON.stringify(withSession()),
      });
      showToast("Entrega iniciada.");
    }

    if (deliver) {
      await api(`/api/orders/${deliver.dataset.deliver}/deliver`, {
        method: "POST",
        body: JSON.stringify(withSession()),
      });
      showToast("Entrega confirmada.");
    }

    await loadOrders();
  } catch {
    showToast("La accion no esta disponible.");
  }
});

renderState("inactive");
renderEarnings();
renderOrders([]);
if (sessionToken) unlockDashboard();
