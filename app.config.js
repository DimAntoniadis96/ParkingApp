// Dynamic Expo config.
//
// This exists so the Android Google Maps API key is injected from the
// environment instead of being hard-committed. react-native-maps needs a
// Google Maps key to render the map on Android release builds (iOS uses Apple
// Maps and needs no key).
//
// Provide the key in ONE of these ways for a build:
//   1. Recommended: create an EAS secret named GOOGLE_MAPS_ANDROID_API_KEY
//        eas secret:create --scope project --name GOOGLE_MAPS_ANDROID_API_KEY --value "AIza..."
//   2. Or add it to the build profile "env" in eas.json.
//   3. Or export it locally before `npx expo run:android`.
//
// If the key is absent, the config still builds — the Android map just won't
// render until a key is supplied.

const appJson = require('./app.json');

module.exports = () => {
  const config = { ...appJson.expo };
  const googleMapsAndroidApiKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;

  if (googleMapsAndroidApiKey) {
    config.android = {
      ...config.android,
      config: {
        ...(config.android && config.android.config),
        googleMaps: {
          apiKey: googleMapsAndroidApiKey,
        },
      },
    };
  }

  return config;
};
