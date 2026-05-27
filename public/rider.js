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
const toast = document.querySelector("#toast");

let active = false;
let poll = null;
let sessionToken = sessionStorage.getItem("riderSessionToken") || "";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/rider-sw.js").catch(() => {});
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

function renderState(status) {
  const isAvailable = status === "available";
  const isBusy = status === "busy";
  active = isAvailable || isBusy;
  riderState.textContent = isBusy ? "OCUPADO" : isAvailable ? "ACTIVO" : "INACTIVO";
  activeToggle.textContent = isAvailable ? "DESACTIVAR" : "ACTIVAR";
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

async function syncStatus(nextActive = active) {
  const location = await getLocation();
  const { rider } = await api("/api/rider/status", {
    method: "POST",
    body: JSON.stringify(withSession({ active: nextActive, location })),
  });
  renderState(rider.status);
  return rider;
}

async function loadOrders() {
  if (!sessionToken) return;
  const { rider, earnings, orders } = await api(
    `/api/rider/orders?sessionToken=${encodeURIComponent(sessionToken)}`,
  );
  renderState(rider.status);
  renderEarnings(earnings);
  renderOrders(orders);
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
  loadOrders().catch(() => renderOrders([]));
  startPolling();
}

function logout() {
  stopPolling();
  sessionToken = "";
  active = false;
  sessionStorage.removeItem("riderSessionToken");
  loginForm.reset();
  renderState("inactive");
  renderEarnings();
  renderOrders([]);
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
