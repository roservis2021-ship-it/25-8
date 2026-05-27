# WON Firebase backend

Estructura preparada para Firebase Hosting, Cloud Functions y Firestore.

## Carpetas

- `public/`: frontend estatico servido por Firebase Hosting.
- `public/rider.html`: PWA instalable para riders en Android e iOS.
- `public/admin.html`: PWA instalable para el canal admin.
- `functions/`: API HTTP con las mismas rutas `/api/...` que usaba el servidor local.
- `firestore.rules`: Firestore cerrado al cliente. La API accede con Admin SDK.

## Desarrollo local

1. Instala dependencias:

   ```bash
   cd functions
   npm install
   ```

2. Inicia emuladores desde la raiz del proyecto:

   ```bash
   firebase emulators:start --only hosting,functions,firestore
   ```

3. Abre:

   - Cliente: `http://127.0.0.1:5000`
   - Repartidor: `http://127.0.0.1:5000/rider.html`
   - Admin: `http://127.0.0.1:5000/admin.html`

## App rider instalable

El panel rider ya incluye `rider.webmanifest`, service worker e iconos PNG. En Android se instala desde el aviso del navegador o desde el menu de Chrome. En iPhone se instala desde Safari con Compartir > Anadir a pantalla de inicio.

La app rider necesita HTTPS para geolocalizacion real e instalacion fiable. Firebase Hosting ya sirve HTTPS en produccion.

Tambien esta sincronizada en la raiz del proyecto para pruebas con `local-server.cjs`.

La app admin tambien incluye manifest, service worker e iconos. En desarrollo usa usuario `admin` y clave `2580` si no defines `ADMIN_USER` y `ADMIN_KEY` en el entorno de Functions. Cambia esos valores antes de produccion.

El admin recibe un feed de actividad de cliente/rider/pedidos en tiempo casi real por polling. Para notificaciones push con la app cerrada, el siguiente paso es integrar Firebase Cloud Messaging.

## Produccion

1. Crea el proyecto en Firebase y activa Firestore.
2. El proyecto Firebase configurado es `project-3225006933365389191`.
3. Antes de produccion, crea `functions/.env` tomando `functions/.env.example` como base y cambia la clave admin.
4. Despliega:

   ```bash
   firebase deploy --only hosting,functions,firestore:rules
   ```

## Produccion sin Blaze: Render API

Cloud Functions requiere plan Blaze. Para evitarlo, el backend tambien esta preparado para Render en `server/`.

1. Sube este proyecto a GitHub.
2. En Render crea un Web Service usando:

   - Root directory: `server`
   - Build command: `npm install`
   - Start command: `npm start`

3. Variables de entorno en Render:

   - `ADMIN_USER`: `admin`
   - `ADMIN_KEY`: una clave fuerte
   - `ALLOWED_ORIGIN`: `https://project-3225006933365389191.web.app`

4. Cuando Render te de una URL tipo `https://won-api.onrender.com`, cambia `public/config.js`:

   ```js
   window.WON_API_BASE = "https://won-api.onrender.com";
   ```

5. Vuelve a desplegar Firebase Hosting:

   ```bash
   firebase deploy --only hosting
   ```

## Notas actuales

- Las cuentas de repartidor siguen definidas en `functions/index.js`.
- El cobro `/pay` confirma pago de forma simulada. Para produccion real, conviene integrar Stripe, Redsys o Bizum antes de abrirlo al publico.
- Los pedidos pendientes de pago caducan a los 5 minutos cuando entra una nueva llamada API.
