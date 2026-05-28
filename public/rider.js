const fallbackLocation = { lat: 28.1236, lng: -15.4364 };
const apiBase = window.WON_API_BASE || (window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "");
const money = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });

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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/rider-sw.js?v=7")
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

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation || !window.isSecureContext) {
      resolve(fallbackLocation);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        }),
      () => resolve(fallbackLocation),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  });
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

function startRiderLocationWatch() {
  if (riderWatchId || !navigator.geolocation || !window.isSecureContext) return;

  riderWatchId = navigator.geolocation.watchPosition(
    (position) => {
      riderLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      updateRiderLocation().catch(() => {});
    },
    () => {},
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 1000 },
  );
}

function stopRiderLocationWatch() {
  if (riderWatchId && navigator.geolocation) navigator.geolocation.clearWatch(riderWatchId);
  riderWatchId = null;
}

async function updateRiderLocation() {
  if (!sessionToken || !riderLocation) return;
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

  document.body.classList.toggle("rider-delivery-mode", Boolean(isDeliveryScreen));
  riderMapPanel.classList.toggle("hidden", !shouldShow);
  deliveryDoneButton.classList.toggle("hidden", !isDeliveryScreen);
  deliveryDoneButton.dataset.deliver = isDeliveryScreen ? order.id : "";
  if (!shouldShow) {
    lastLiveDistance = null;
    liveOrderId = "";
    riderMapUserMoved = false;
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
  const location = await getLocation();
  riderLocation = location;
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
  syncStatus(false).catch(() => showToast("No se pudo acceder a la ubicacion."));
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
  try {
    await syncStatus(!active);
    await loadOrders();
    startPolling();
  } catch {
    showToast("No se pudo cambiar el estado.");
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
