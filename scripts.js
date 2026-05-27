const products = [
  {
    id: "m",
    name: "M",
    price: 7,
    tone: "#159447",
    softTone: "#183228",
    texture: "plant-texture",
    mark: "M",
  },
  {
    id: "p",
    name: "P",
    price: 5,
    tone: "#f0c531",
    softTone: "#332d17",
    texture: "sand-texture",
    mark: "P",
  },
  {
    id: "c",
    name: "C",
    price: 65,
    tone: "#ffffff",
    softTone: "#2e2e2e",
    texture: "scale-texture",
    circleClass: "dark-letter",
    mark: "C",
  },
];

const cart = new Map();
const money = new Intl.NumberFormat("es-ES", {
  style: "currency",
  currency: "EUR",
});

const productGrid = document.querySelector("#productGrid");
const cartList = document.querySelector("#cartList");
const totalEl = document.querySelector("#total");
const paymentForm = document.querySelector("#paymentForm");
const orderStatus = document.querySelector("#orderStatus");
const confirmButton = document.querySelector("#confirmButton");
const payButton = document.querySelector("#payButton");
const toast = document.querySelector("#toast");
const entryGate = document.querySelector("#entryGate");
const entryForm = document.querySelector("#entryForm");
const entryName = document.querySelector("#entryName");
const entryPhone = document.querySelector("#entryPhone");
const paymentName = paymentForm.elements.name;

let customerLocation = null;
let customerName = "";
let activeOrderId = null;
let orderPoll = null;
let clientHeartbeat = null;
let clientWatchId = null;
let lastClientLocationSentAt = 0;
let lastClientLocationSent = null;
let customerId = localStorage.getItem("customerId") || "";
const fallbackLocation = { lat: 28.1235, lng: -15.4366 };
const apiBase = window.WON_API_BASE || (window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "");

function formatMoney(value) {
  return money.format(value);
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

async function syncClient(active = true) {
  if (!customerId) {
    customerId = `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("customerId", customerId);
  }

  await api("/api/clients/status", {
    method: "POST",
    body: JSON.stringify({
      clientId: customerId,
      name: customerName,
      phone: entryPhone.value.trim(),
      contactRequested: true,
      location: customerLocation,
      active,
    }),
  });
}

function distanceMeters(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
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

function maybeSyncClientLocation(force = false) {
  const now = Date.now();
  const moved = distanceMeters(lastClientLocationSent, customerLocation);
  if (!force && moved < 8 && now - lastClientLocationSentAt < 5000) return;

  lastClientLocationSent = customerLocation ? { ...customerLocation } : null;
  lastClientLocationSentAt = now;
  syncClient(true).catch(() => {});
}

function startClientHeartbeat() {
  if (clientHeartbeat) window.clearInterval(clientHeartbeat);
  clientHeartbeat = window.setInterval(() => {
    if (!customerName) return;
    maybeSyncClientLocation(true);
  }, 15_000);
}

function startClientLocationWatch() {
  if (clientWatchId || !navigator.geolocation || !window.isSecureContext) return;

  clientWatchId = navigator.geolocation.watchPosition(
    (position) => {
      customerLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      if (customerName) maybeSyncClientLocation();
    },
    () => {},
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 1000 },
  );
}

function renderProducts() {
  productGrid.innerHTML = products
    .map(
      (product) => `
        <article class="product-card">
          <div class="product-image ${product.texture}" style="--soft-tone: ${product.softTone}">
            <span class="product-circle ${product.circleClass || ""}" style="--tone: ${product.tone}">${product.mark}</span>
          </div>
          <div class="product-body">
            <div>
              <h4>${product.name}</h4>
            </div>
            <div class="product-meta">
              <span class="price">${formatMoney(product.price)} / gr</span>
              <details class="gram-selector">
                <summary>AÑADIR</summary>
                <div class="product-qty" aria-label="gr de ${product.name}">
                  <button type="button" data-product-dec="${product.id}">-</button>
                  <strong data-product-qty="${product.id}">${cart.get(product.id) || 0} gr</strong>
                  <button type="button" data-product-inc="${product.id}">+</button>
                </div>
              </details>
            </div>
          </div>
        </article>
      `,
    )
    .join("");
}

function getCartSummary() {
  const items = [...cart.entries()].map(([id, quantity]) => {
    const product = products.find((entry) => entry.id === id);
    return { ...product, quantity, lineTotal: product.price * quantity };
  });
  const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
  return { items, total };
}

function updateProductCounters() {
  products.forEach((product) => {
    const counter = productGrid.querySelector(`[data-product-qty="${product.id}"]`);
    if (counter) counter.textContent = `${cart.get(product.id) || 0} gr`;
  });
}

function renderCart() {
  const summary = getCartSummary();

  totalEl.textContent = formatMoney(summary.total);

  if (summary.items.length === 0) {
    cartList.innerHTML = "";
    updateProductCounters();
    return;
  }

  cartList.innerHTML = summary.items
    .map(
      (item) => `
        <div class="cart-item">
          <div>
            <strong>${item.name}</strong>
            <span>${item.quantity} g - ${formatMoney(item.lineTotal)}</span>
          </div>
          <div class="qty-controls" aria-label="Cantidad de ${item.name}">
            <button type="button" data-dec="${item.id}">-</button>
            <strong>${item.quantity} g</strong>
            <button type="button" data-inc="${item.id}">+</button>
          </div>
        </div>
      `,
    )
    .join("");
  updateProductCounters();
}

function setOrderStatus(message) {
  orderStatus.textContent = message || "";
}

function stopOrderPolling() {
  if (orderPoll) window.clearInterval(orderPoll);
  orderPoll = null;
}

function resetExpiredOrder() {
  activeOrderId = null;
  confirmButton.disabled = false;
  confirmButton.classList.remove("hidden");
  payButton.classList.add("hidden");
  payButton.disabled = false;
  setOrderStatus("Solicitud caducada por falta de pago. Puedes confirmar otra vez.");
  stopOrderPolling();
}

function handleOrderState(order) {
  if (order.status === "searching_rider") {
    setOrderStatus("Buscando activo cercano...");
    confirmButton.disabled = true;
    payButton.classList.add("hidden");
  }

  if (order.status === "pending_payment") {
    setOrderStatus("Aceptado. Pago disponible.");
    confirmButton.classList.add("hidden");
    payButton.classList.remove("hidden");
    showToast("Solicitud aceptada. Ya puedes pagar.");
    stopOrderPolling();
  }

  if (order.status === "paid") {
    setOrderStatus("Pago confirmado. Esperando inicio.");
    payButton.classList.add("hidden");
  }

  if (order.status === "on_route") {
    setOrderStatus("Entrega iniciada.");
    stopOrderPolling();
  }

  if (order.status === "delivered") {
    setOrderStatus("Pedido entregado.");
    stopOrderPolling();
  }
}

function startOrderPolling(orderId) {
  stopOrderPolling();
  orderPoll = window.setInterval(async () => {
    try {
      const { order } = await api(`/api/orders/${orderId}`);
      handleOrderState(order);
    } catch (error) {
      if (error.status === 404) {
        resetExpiredOrder();
        return;
      }

      setOrderStatus("No se pudo actualizar el estado.");
    }
  }, 2500);
}

function addToCart(id) {
  cart.set(id, (cart.get(id) || 0) + 1);
  renderCart();
}

function updateQuantity(id, delta) {
  const next = (cart.get(id) || 0) + delta;
  if (next <= 0) {
    cart.delete(id);
  } else {
    cart.set(id, next);
  }
  renderCart();
}

function enterApp(name) {
  customerName = name;
  paymentName.value = name;
  if (!customerLocation) customerLocation = fallbackLocation;
  entryGate.classList.add("hidden");
  maybeSyncClientLocation(true);
  startClientHeartbeat();
  startClientLocationWatch();
  showToast(`Bienvenido, ${name}.`);
}

function requestLocation(name) {
  if (!navigator.geolocation || !window.isSecureContext) {
    showToast("No se pudo pedir ubicacion segura. Usando zona aproximada.");
    enterApp(name);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      customerLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      startClientLocationWatch();
      enterApp(name);
    },
    () => {
      showToast("No se pudo acceder a tu ubicacion. Usando zona aproximada.");
      enterApp(name);
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
  );
}

entryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = entryName.value.trim();
  const phone = entryPhone.value.trim();

  if (!name) {
    showToast("Escribe tu nombre para entrar.");
    return;
  }

  if (!phone) {
    showToast("Escribe tu telefono para entrar.");
    return;
  }

  requestLocation(name);
});

cartList.addEventListener("click", (event) => {
  const increment = event.target.closest("[data-inc]");
  const decrement = event.target.closest("[data-dec]");

  if (increment) updateQuantity(increment.dataset.inc, 1);
  if (decrement) updateQuantity(decrement.dataset.dec, -1);
});

productGrid.addEventListener("click", (event) => {
  const increment = event.target.closest("[data-product-inc]");
  const decrement = event.target.closest("[data-product-dec]");

  if (increment) updateQuantity(increment.dataset.productInc, 1);
  if (decrement) updateQuantity(decrement.dataset.productDec, -1);
});

paymentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const summary = getCartSummary();

  if (summary.items.length === 0) {
    showToast("Anade al menos un producto antes de pagar.");
    return;
  }

  const formData = new FormData(paymentForm);
  const orderPayload = {
    customerName,
    customerId,
    address: formData.get("address"),
    items: summary.items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    total: summary.total,
    location: customerLocation,
  };

  confirmButton.disabled = true;
  setOrderStatus("Creando solicitud...");

  api("/api/orders", {
    method: "POST",
    body: JSON.stringify(orderPayload),
  })
    .then(({ order }) => {
      activeOrderId = order.id;
      handleOrderState(order);
      startOrderPolling(order.id);
    })
    .catch(() => {
      confirmButton.disabled = false;
      setOrderStatus("No se pudo crear la solicitud.");
    });
});

payButton.addEventListener("click", () => {
  if (!activeOrderId) return;

  payButton.disabled = true;
  setOrderStatus("Procesando pago...");

  api(`/api/orders/${activeOrderId}/pay`, { method: "POST", body: "{}" })
    .then(({ order }) => {
      cart.clear();
      renderCart();
      handleOrderState(order);
      showToast("Pago confirmado.");
      startOrderPolling(order.id);
    })
    .catch((error) => {
      if (error.status === 404) {
        resetExpiredOrder();
        return;
      }

      payButton.disabled = false;
      setOrderStatus("No se pudo confirmar el pago.");
    });
});

renderProducts();
renderCart();
