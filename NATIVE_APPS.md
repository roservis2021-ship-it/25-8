# Apps nativas Admin y Rider

Se prepararon dos proyectos Capacitor separados:

- Rider: `native/rider`
- Admin: `native/admin`

Estas apps se pueden compilar como APK/AAB para Android y como IPA para iOS. No se instalan desde el navegador como PWA.

## Android

Requisitos:

- Android Studio
- JDK 17
- Android SDK instalado

Comandos:

```bash
cd native/rider
npm install
npx cap sync android
npx cap open android
```

```bash
cd native/admin
npm install
npx cap sync android
npx cap open android
```

Desde Android Studio puedes generar:

- APK debug para pruebas
- AAB firmado para Play Store

La compilacion por consola requiere Java 17:

```bash
cd native/rider/android
gradlew assembleDebug
```

```bash
cd native/admin/android
gradlew assembleDebug
```

## iOS

iOS requiere macOS con Xcode y cuenta Apple Developer.

En Mac:

```bash
cd native/rider
npm install
npx cap add ios
npx cap sync ios
npx cap open ios
```

```bash
cd native/admin
npm install
npx cap add ios
npx cap sync ios
npx cap open ios
```

Desde Xcode se genera el archivo para TestFlight/App Store.

## Permisos

Android ya tiene permisos:

- `ACCESS_COARSE_LOCATION`
- `ACCESS_FINE_LOCATION`
- `INTERNET`

La app usa la API publicada en Render mediante `www/config.js`.
