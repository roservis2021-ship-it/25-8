const apiBase = window.WON_API_BASE || (window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "");
const money = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });

const loginGate = document.querySelector("#adminLoginGate");
const loginForm = document.querySelector("#adminLoginForm");
const adminUser = document.querySelector("#adminUser");
const adminKey = document.querySelector("#adminKey");
const logoutButton = document.querySelector("#adminLogoutButton");
const newRiderForm = document.querySelector("#newRiderForm");
const toast = document.querySelector("#toast");

const activeClients = document.querySelector("#activeClients");
const activeRiders = document.querySelector("#activeRiders");
const businessGross = document.querySelector("#businessGross");
const businessNet = document.querySelector("#businessNet");
const activityList = document.querySelector("#activityList");
const clientsList = document.querySelector("#clientsList");
const ridersList = document.querySelector("#ridersList");
const ordersList = document.querySelector("#ordersList");
const earningsList = document.querySelector("#earningsList");
const riderAccountsList = document.querySelector("#riderAccountsList");
const adminTabs = document.querySelectorAll("[data-admin-view]");
const adminPanels = document.querySelectorAll("[data-admin-panel]");
const adminMap = document.querySelector("#adminMap");
const mapEmpty = document.querySelector("#mapEmpty");

let adminToken = sessionStorage.getItem("adminSessionToken") || "";
let poll = null;
let lastActivityId = "";
let leafletMap = null;
let leafletLayer = null;
let leafletDidInitialFit = false;
let leafletUserMoved = false;

adminTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const nextView = tab.dataset.adminView;
    adminTabs.forEach((entry) => entry.classList.toggle("active", entry === tab));
    adminPanels.forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.adminPanel !== nextView);
    });
    if (nextView === "map" && leafletMap) {
      window.setTimeout(() => leafletMap.invalidateSize(), 80);
    }
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/admin-sw.js?v=6")
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
  if (!response.ok) {
    const error = new Error(payload.error || "api_error");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function withAdmin(body = {}) {
  return { ...body, adminToken };
}

function coord(location) {
  if (!location) return "Sin ubicacion";
  return `${Number(location.lat).toFixed(5)}, ${Number(location.lng).toFixed(5)}`;
}

function mapsLink(location) {
  if (!location) return "";
  return "";
}

function time(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function renderEmpty(target, message) {
  target.innerHTML = `<p class="rider-note">${message}</p>`;
}

function renderActivity(activity) {
  if (!activity.length) {
    renderEmpty(activityList, "Sin movimientos todavia.");
    return;
  }

  if (lastActivityId && activity[0].id !== lastActivityId) showToast(activity[0].summary);
  lastActivityId = activity[0].id;

  activityList.innerHTML = activity
    .map(
      (item) => `
        <article class="admin-row">
          <strong>${item.summary}</strong>
          <span>${item.type} - ${time(item.createdAt)}</span>
        </article>
      `,
    )
    .join("");
}

function renderClients(clients) {
  if (!clients.length) {
    renderEmpty(clientsList, "Sin clientes activos con ubicacion compartida.");
    return;
  }

  clientsList.innerHTML = clients
    .map(
      (client) => `
        <article class="admin-row live-row">
          <div class="live-title">
            <i class="status-dot online"></i>
            <strong>${client.name || "Cliente"}</strong>
          </div>
          <span>${coord(client.location)}</span>
          ${
            client.contactRequested
              ? `<em>Solicita contacto${client.phone ? `: ${client.phone}` : ""}</em>`
              : ""
          }
        </article>
      `,
    )
    .join("");
}

function renderRiders(riders) {
  if (!riders.length) {
    renderEmpty(ridersList, "Sin riders registrados en tiempo real.");
    return;
  }

  ridersList.innerHTML = riders
    .map(
      (rider) => `
        <article class="admin-row live-row">
          <div class="live-title">
            <i class="status-dot ${rider.status === "available" ? "rider-online" : "offline"}"></i>
            <strong>${rider.name || rider.id}</strong>
          </div>
          <span>${rider.status || "inactive"} - ${coord(rider.location)}</span>
        </article>
      `,
    )
    .join("");
}

function renderOrders(orders) {
  if (!orders.length) {
    renderEmpty(ordersList, "Sin pedidos registrados.");
    return;
  }

  ordersList.innerHTML = orders
    .map((order) => {
      const items = (order.items || []).map((item) => `${item.quantity} gr ${item.name}`).join(" / ");
      return `
        <article class="admin-row">
          <strong>${money.format(order.total || 0)} - ${order.status}</strong>
          <span>${order.customerName || "Cliente"} / ${order.address || "Sin referencia"}</span>
          <span>${items || "Sin lineas"} / Rider: ${order.riderId || "sin asignar"}</span>
          <em>${coord(order.location)}</em>
        </article>
      `;
    })
    .join("");
}

function getMapBounds(points) {
  const lats = points.map((point) => Number(point.location.lat));
  const lngs = points.map((point) => Number(point.location.lng));
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    minLat: minLat === maxLat ? minLat - 0.002 : minLat,
    maxLat: minLat === maxLat ? maxLat + 0.002 : maxLat,
    minLng: minLng === maxLng ? minLng - 0.002 : minLng,
    maxLng: minLng === maxLng ? maxLng + 0.002 : maxLng,
  };
}

function renderMap(clients, riders) {
  const clientPoints = clients
    .filter((client) => client.location)
    .map((client) => ({ type: "client", label: client.name || "Cliente", location: client.location }));
  const riderPoints = riders
    .filter((rider) => rider.location)
    .map((rider) => ({
      type: rider.status === "available" ? "rider-online" : "offline",
      label: rider.name || rider.id,
      location: rider.location,
    }));
  const points = [...clientPoints, ...riderPoints];

  if (window.L) {
    renderLeafletMap(points);
    return;
  }

  adminMap.querySelectorAll(".map-pin").forEach((pin) => pin.remove());
  mapEmpty.classList.toggle("hidden", points.length > 0);
  if (!points.length) return;

  const bounds = getMapBounds(points);
  points.forEach((point) => {
    const x = ((Number(point.location.lng) - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * 86 + 7;
    const y = (1 - (Number(point.location.lat) - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 78 + 11;
    const pin = document.createElement("button");
    pin.className = `map-pin ${point.type}`;
    pin.type = "button";
    pin.style.left = `${x}%`;
    pin.style.top = `${y}%`;
    pin.setAttribute("aria-label", `${point.label} ${coord(point.location)}`);
    pin.innerHTML = `<span>${point.label}</span>`;
    adminMap.appendChild(pin);
  });
}

function getLeafletIcon(type) {
  return L.divIcon({
    className: `leaflet-status-marker ${type}`,
    html: "<span></span>",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function initLeafletMap() {
  if (leafletMap || !window.L) return;

  leafletMap = L.map(adminMap, {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: true,
  }).setView([28.1235, -15.4366], 14);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(leafletMap);

  leafletLayer = L.layerGroup().addTo(leafletMap);
  leafletMap.on("zoomstart movestart", () => {
    leafletUserMoved = true;
  });
}

function renderLeafletMap(points) {
  initLeafletMap();
  if (!leafletMap || !leafletLayer) return;

  leafletLayer.clearLayers();
  mapEmpty.classList.toggle("hidden", points.length > 0);
  if (!points.length) return;

  const bounds = [];
  points.forEach((point) => {
    const lat = Number(point.location.lat);
    const lng = Number(point.location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    bounds.push([lat, lng]);
    L.marker([lat, lng], { icon: getLeafletIcon(point.type) })
      .bindPopup(`<strong>${point.label}</strong><br>${coord(point.location)}`)
      .addTo(leafletLayer);
  });

  if (leafletDidInitialFit || leafletUserMoved) {
    window.setTimeout(() => leafletMap.invalidateSize(), 80);
    return;
  }

  if (bounds.length === 1) {
    leafletMap.setView(bounds[0], 16);
  } else if (bounds.length > 1) {
    leafletMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  }

  leafletDidInitialFit = bounds.length > 0;
  window.setTimeout(() => leafletMap.invalidateSize(), 80);
}

function renderEarnings(earnings) {
  if (!earnings.length) {
    renderEmpty(earningsList, "Sin ganancias por rider todavia.");
    return;
  }

  earningsList.innerHTML = earnings
    .map(
      (entry) => `
        <article class="admin-row">
          <strong>${entry.riderName || entry.riderId}</strong>
          <span>Bruta: ${money.format(entry.gross || 0)} / Neta rider: ${money.format(entry.net || 0)}</span>
          <em>Neto negocio: ${money.format(entry.businessNet || 0)} / Pedidos: ${entry.paidOrders || 0}</em>
        </article>
      `,
    )
    .join("");
}

function renderAccounts(accounts) {
  if (!accounts.length) {
    renderEmpty(riderAccountsList, "No hay riders creados.");
    return;
  }

  riderAccountsList.innerHTML = accounts
    .map(
      (rider) => `
        <article class="admin-row account-row">
          <div>
            <strong>${rider.name}</strong>
            <span>${rider.userNumber}</span>
          </div>
          <button class="ghost-button" type="button" data-delete-rider="${rider.userNumber}">Borrar</button>
        </article>
      `,
    )
    .join("");
}

function renderDashboard(data) {
  activeClients.textContent = data.clients.length;
  activeRiders.textContent = data.riders.filter((rider) => rider.status === "available").length;
  businessGross.textContent = money.format(data.business.gross || 0);
  businessNet.textContent = money.format(data.business.net || 0);
  renderActivity(data.activity);
  renderClients(data.clients);
  renderRiders(data.riders);
  renderOrders(data.orders);
  renderEarnings(data.riderEarnings);
  renderAccounts(data.riderAccounts);
  renderMap(data.clients, data.riders);
}

async function loadDashboard() {
  if (!adminToken) return;
  const data = await api(`/api/admin/dashboard?adminToken=${encodeURIComponent(adminToken)}`);
  renderDashboard(data);
}

function startPolling() {
  if (poll) window.clearInterval(poll);
  poll = window.setInterval(() => loadDashboard().catch(() => {}), 2500);
}

function unlockDashboard() {
  loginGate.classList.add("hidden");
  loadDashboard().catch(() => showToast("No se pudo cargar admin."));
  startPolling();
}

function logout() {
  if (poll) window.clearInterval(poll);
  poll = null;
  adminToken = "";
  sessionStorage.removeItem("adminSessionToken");
  loginGate.classList.remove("hidden");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const { adminToken: token } = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ user: adminUser.value.trim(), key: adminKey.value.trim() }),
    });
    adminToken = token;
    sessionStorage.setItem("adminSessionToken", adminToken);
    unlockDashboard();
  } catch {
    showToast("Credenciales admin no validas.");
  }
});

newRiderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(newRiderForm);

  try {
    await api("/api/admin/riders", {
      method: "POST",
      body: JSON.stringify(
        withAdmin({
          name: formData.get("name"),
          userNumber: formData.get("userNumber"),
          key: formData.get("key"),
        }),
      ),
    });
    newRiderForm.reset();
    showToast("Rider anadido.");
    await loadDashboard();
  } catch {
    showToast("No se pudo anadir rider.");
  }
});

riderAccountsList.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("[data-delete-rider]");
  if (!deleteButton) return;

  try {
    await api(`/api/admin/riders/${deleteButton.dataset.deleteRider}/delete`, {
      method: "POST",
      body: JSON.stringify(withAdmin()),
    });
    showToast("Rider borrado.");
    await loadDashboard();
  } catch {
    showToast("No se pudo borrar rider.");
  }
});

logoutButton.addEventListener("click", logout);

if (adminToken) unlockDashboard();
