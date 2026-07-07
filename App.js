import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from 'convex/react';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from './convex/_generated/api';

const park2MeLogo = require('./park2me_logo.png');
const park2MeSmallLogo = require('./assets/park2me-small-logo-horizontal.png');

const colors = {
  black: '#050706',
  panel: '#0d120f',
  panelSoft: '#151c18',
  panelRaised: '#1b241f',
  green: '#22c55e',
  greenSoft: '#173d25',
  orange: '#f59e0b',
  red: '#ef4444',
  white: '#f8fafc',
  muted: '#95a39b',
  dim: '#56635d',
  border: '#243029',
};

const signalTypes = {
  green: {
    color: colors.green,
    icon: 'checkmark',
  },
  orange: {
    color: colors.orange,
    icon: 'time',
  },
  red: {
    color: colors.red,
    icon: 'close',
  },
};

const departureTimes = [2, 5, 8];
const CLIENT_ID_STORAGE_KEY = 'park2me.clientId';
const DRAFT_SPOT_STORAGE_KEY = 'park2me.draftSpot';
const ACTIVE_QUERY_LIMIT = 60;
const MAP_QUERY_CELL_SIZE_DEGREES = 0.01;
const EXPIRE_AFTER_DEPARTURE_MS = 12 * 60 * 1000;
const ORANGE_AFTER_DEPARTURE_MS = 5 * 60 * 1000;
const DRAFT_SPOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SPOT_VERIFICATION_RADIUS_METERS = 80;
const LOCATION_ACCURACY_BUFFER_METERS = 35;
const DEFAULT_CAR_INFO = {
  brand: 'Private vehicle',
  color: 'Hidden',
  plate_slug: 'private',
};

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;

if (!convexUrl) {
  throw new Error('Missing EXPO_PUBLIC_CONVEX_URL. Make sure Convex generated .env.local is loaded by Expo.');
}

const convex = new ConvexReactClient(convexUrl, {
  unsavedChangesWarning: false,
});

function createAnonymousClientId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getClientId() {
  const existingClientId = await AsyncStorage.getItem(CLIENT_ID_STORAGE_KEY);

  if (existingClientId) {
    return existingClientId;
  }

  const nextClientId = createAnonymousClientId();
  await AsyncStorage.setItem(CLIENT_ID_STORAGE_KEY, nextClientId);

  return nextClientId;
}

function createRegion(coords) {
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    latitudeDelta: 0.012,
    longitudeDelta: 0.012,
  };
}

function mapAreaKey(latitude, longitude) {
  const latCell = Math.floor(latitude / MAP_QUERY_CELL_SIZE_DEGREES);
  const lonCell = Math.floor(longitude / MAP_QUERY_CELL_SIZE_DEGREES);

  return `${latCell}:${lonCell}`;
}

function toCoordinate(coords) {
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
  };
}

function distanceBetweenCoordinatesMeters(from, to) {
  const earthRadiusMeters = 6371000;
  const latitudeDelta = ((to.latitude - from.latitude) * Math.PI) / 180;
  const longitudeDelta = ((to.longitude - from.longitude) * Math.PI) / 180;
  const fromLatitude = (from.latitude * Math.PI) / 180;
  const toLatitude = (to.latitude * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function getStatusForTime(now, scheduledDepartureTime) {
  if (now < scheduledDepartureTime) {
    return 'green';
  }

  if (now < scheduledDepartureTime + ORANGE_AFTER_DEPARTURE_MS) {
    return 'orange';
  }

  return 'red';
}

function formatMinutes(milliseconds) {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60000));

  return minutes === 1 ? '1 min' : `${minutes} min`;
}

function formatDistanceMeters(distance) {
  const roundedDistance = Math.round(distance);

  return roundedDistance < 1000 ? `${roundedDistance} m` : `${(roundedDistance / 1000).toFixed(1)} km`;
}

function formatDistanceFromRegion(spot, region) {
  if (!region) {
    return 'nearby';
  }

  const latitudeMeters = (spot.latitude - region.latitude) * 111000;
  const longitudeMeters =
    (spot.longitude - region.longitude) * 111000 * Math.cos((region.latitude * Math.PI) / 180);
  const distance = Math.round(Math.sqrt(latitudeMeters ** 2 + longitudeMeters ** 2));

  return distance < 1000 ? `${distance} m` : `${(distance / 1000).toFixed(1)} km`;
}

function formatSpotTime(scheduledDepartureTime, now) {
  const milliseconds = scheduledDepartureTime - now;

  if (milliseconds > 0) {
    return `Opens in ${formatMinutes(milliseconds)}`;
  }

  return 'Open now';
}

function getSharedSpotDisplay(sharedSpot, now) {
  if (!sharedSpot || now >= sharedSpot.expiresAt) {
    return null;
  }

  const status = getStatusForTime(now, sharedSpot.scheduledDepartureTime);

  return {
    status,
    title: formatSpotTime(sharedSpot.scheduledDepartureTime, now),
    copy: status === 'green' ? 'Your spot is shared.' : 'Thanks. Drivers can see it now.',
  };
}

function mapConvexSpotToSignal(spot, region, now) {
  const status = getStatusForTime(now, spot.scheduled_departure_time);

  return {
    id: spot._id,
    type: status,
    title: formatSpotTime(spot.scheduled_departure_time, now),
    subtitle: formatDistanceFromRegion(spot, region),
    coordinate: {
      latitude: spot.latitude,
      longitude: spot.longitude,
    },
  };
}

function parseDraftSpot(rawDraftSpot) {
  if (!rawDraftSpot) {
    return null;
  }

  try {
    const draftSpot = JSON.parse(rawDraftSpot);
    const isCoordinate =
      Number.isFinite(draftSpot?.latitude) && Number.isFinite(draftSpot?.longitude);
    const isFresh =
      typeof draftSpot?.updatedAt === 'number' &&
      Date.now() - draftSpot.updatedAt <= DRAFT_SPOT_MAX_AGE_MS;

    if (!isCoordinate || !isFresh) {
      return null;
    }

    return {
      latitude: draftSpot.latitude,
      longitude: draftSpot.longitude,
    };
  } catch (error) {
    return null;
  }
}

async function loadDraftSpot() {
  const rawDraftSpot = await AsyncStorage.getItem(DRAFT_SPOT_STORAGE_KEY);
  const draftSpot = parseDraftSpot(rawDraftSpot);

  if (rawDraftSpot && !draftSpot) {
    await AsyncStorage.removeItem(DRAFT_SPOT_STORAGE_KEY);
  }

  return draftSpot;
}

async function saveDraftSpot(coordinate) {
  await AsyncStorage.setItem(
    DRAFT_SPOT_STORAGE_KEY,
    JSON.stringify({
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      updatedAt: Date.now(),
    }),
  );
}

async function openMapUrl(primaryUrl, fallbackUrl) {
  try {
    await Linking.openURL(primaryUrl);
  } catch (error) {
    try {
      await Linking.openURL(fallbackUrl);
    } catch (fallbackError) {
      Alert.alert('Could not open maps', 'Please check that a maps app or browser is available.');
    }
  }
}

export default function App() {
  return (
    <ConvexProvider client={convex}>
      <SafeAreaProvider>
        <ParkingApp />
      </SafeAreaProvider>
    </ConvexProvider>
  );
}

function ParkingApp() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [screen, setScreen] = useState('menu');
  const [showIntro, setShowIntro] = useState(true);
  const [intent, setIntent] = useState('find');
  const [location, setLocation] = useState(null);
  const [region, setRegion] = useState(null);
  const [nearbyQueryPoint, setNearbyQueryPoint] = useState(null);
  const [draftSpotCoordinate, setDraftSpotCoordinate] = useState(null);
  const [selectedTime, setSelectedTime] = useState(5);
  const [selectedSignalId, setSelectedSignalId] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [sharedSpot, setSharedSpot] = useState(null);
  const [isLocating, setIsLocating] = useState(false);
  const [isSharingSpot, setIsSharingSpot] = useState(false);
  const [isCancellingSpot, setIsCancellingSpot] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const activeSpots = useQuery(
    api.parking.getNearbyActiveSpots,
    intent === 'find' && nearbyQueryPoint
      ? {
          latitude: nearbyQueryPoint.latitude,
          longitude: nearbyQueryPoint.longitude,
          limit: ACTIVE_QUERY_LIMIT,
        }
      : 'skip',
  );
  const shareSpot = useMutation(api.parking.shareSpot);
  const cancelMyActiveSpot = useMutation(api.parking.cancelMyActiveSpot);

  const parkingSignals = useMemo(() => {
    if (intent !== 'find' || !activeSpots?.length) {
      return [];
    }

    return activeSpots.map((spot) => mapConvexSpotToSignal(spot, region, now));
  }, [activeSpots, intent, now, region]);
  const bestSignal = intent === 'find' ? parkingSignals[0] : null;
  const selectedSignal = useMemo(
    () =>
      intent === 'find'
        ? parkingSignals.find((signal) => signal.id === selectedSignalId)
        : null,
    [intent, parkingSignals, selectedSignalId],
  );
  const focusedSignal = selectedSignal || bestSignal;
  const sharedSpotDisplay = getSharedSpotDisplay(sharedSpot, now);
  const panelIsCompact = height < 740;

  useEffect(() => {
    const introTimer = setTimeout(() => {
      setShowIntro(false);
    }, 1400);

    return () => clearTimeout(introTimer);
  }, []);

  useEffect(() => {
    let isMounted = true;

    loadDraftSpot()
      .then((savedDraftSpot) => {
        if (isMounted && savedDraftSpot) {
          setDraftSpotCoordinate((currentDraftSpot) => currentDraftSpot || savedDraftSpot);
        }
      })
      .catch((error) => {
        console.error(error);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNow(Date.now());
    }, 15000);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (sharedSpot && now >= sharedSpot.expiresAt) {
      setSharedSpot(null);
    }
  }, [now, sharedSpot]);

  useEffect(() => {
    if (selectedSignalId && !selectedSignal) {
      setSelectedSignalId(null);
    }
  }, [selectedSignal, selectedSignalId]);

  if (showIntro) {
    return (
      <View style={styles.introScreen}>
        <StatusBar style="light" />
        <Image source={park2MeLogo} style={styles.introLogo} resizeMode="contain" />
      </View>
    );
  }

  const handleDraftSpotChange = (coordinate) => {
    const nextCoordinate = toCoordinate(coordinate);

    setDraftSpotCoordinate(nextCoordinate);
    saveDraftSpot(nextCoordinate).catch((error) => {
      console.error(error);
    });
  };

  const handleRegionChangeComplete = (nextRegion) => {
    setRegion(nextRegion);

    if (intent !== 'find') {
      return;
    }

    setNearbyQueryPoint((currentPoint) => {
      if (!currentPoint) {
        return toCoordinate(nextRegion);
      }

      if (
        mapAreaKey(currentPoint.latitude, currentPoint.longitude) ===
        mapAreaKey(nextRegion.latitude, nextRegion.longitude)
      ) {
        return currentPoint;
      }

      return toCoordinate(nextRegion);
    });
  };

  const prepareMap = async (nextIntent = intent) => {
    setIntent(nextIntent);
    setErrorMsg('');
    setIsLocating(true);

    if (!region) {
      setScreen('locating');
    }

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        setErrorMsg('Turn on location to see parking near you.');
        setScreen(region ? 'map' : 'error');
        return;
      }

      const lastKnownLocation = await Location.getLastKnownPositionAsync({
        maxAge: 60000,
        requiredAccuracy: 150,
      });
      const currentLocation =
        lastKnownLocation ||
        (await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        }));
      const currentCoordinate = toCoordinate(currentLocation.coords);
      const nextRegion =
        nextIntent === 'leave' && draftSpotCoordinate
          ? createRegion(draftSpotCoordinate)
          : createRegion(currentCoordinate);

      setLocation(currentLocation.coords);
      setRegion(nextRegion);

      if (nextIntent === 'find') {
        setNearbyQueryPoint(currentCoordinate);
      }

      if (nextIntent === 'leave' && !draftSpotCoordinate) {
        handleDraftSpotChange(currentCoordinate);
      }

      setScreen('map');
    } catch (error) {
      setErrorMsg('We could not find you. Please try again.');
      setScreen(region ? 'map' : 'error');
    } finally {
      setIsLocating(false);
    }
  };

  const handleDriveToSpot = (signal) => {
    if (!signal) {
      Alert.alert('No spot selected', 'Tap a parking spot on the map first.');
      return;
    }

    const { latitude, longitude } = signal.coordinate;
    const destination = `${latitude},${longitude}`;
    const googleMapsWebUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;

    if (Platform.OS === 'ios') {
      const appleMapsUrl = `http://maps.apple.com/?daddr=${destination}&dirflg=d`;
      const googleMapsUrl = `comgooglemaps://?daddr=${destination}&directionsmode=driving`;

      Alert.alert('Drive to this spot', 'Choose your maps app.', [
        {
          text: 'Apple Maps',
          onPress: () => openMapUrl(appleMapsUrl, googleMapsWebUrl),
        },
        {
          text: 'Google Maps',
          onPress: () => openMapUrl(googleMapsUrl, googleMapsWebUrl),
        },
        {
          text: 'Cancel',
          style: 'cancel',
        },
      ]);
      return;
    }

    if (Platform.OS === 'android') {
      openMapUrl(`google.navigation:q=${destination}&mode=d`, googleMapsWebUrl);
      return;
    }

    openMapUrl(googleMapsWebUrl, googleMapsWebUrl);
  };

  const handleDropPin = async (minutes = selectedTime) => {
    if (isSharingSpot) {
      return;
    }

    if (!draftSpotCoordinate) {
      Alert.alert(
        'Place your car pin',
        'Tap the map where your car is parked, then verify when you are near it.',
      );
      return;
    }

    setIsSharingSpot(true);

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        Alert.alert('Location needed', 'Turn on location so we can share your spot.');
        return;
      }

      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const coords = currentLocation.coords;
      const currentCoordinate = toCoordinate(coords);
      const distanceFromCar = distanceBetweenCoordinatesMeters(currentCoordinate, draftSpotCoordinate);
      const accuracyBuffer =
        typeof coords.accuracy === 'number'
          ? Math.min(coords.accuracy, LOCATION_ACCURACY_BUFFER_METERS)
          : 0;
      const allowedDistance = SPOT_VERIFICATION_RADIUS_METERS + accuracyBuffer;

      setLocation(coords);

      if (distanceFromCar > allowedDistance) {
        Alert.alert(
          'Verify at the car',
          `You are about ${formatDistanceMeters(distanceFromCar)} from the car pin. Share it when you are beside the car, or move the pin if it is wrong.`,
        );
        return;
      }

      const verifiedAt = Date.now();
      const scheduledDepartureTime = verifiedAt + minutes * 60 * 1000;
      const expiresAt = scheduledDepartureTime + EXPIRE_AFTER_DEPARTURE_MS;
      const clientId = await getClientId();
      const verificationPayload = {
        verified_at: verifiedAt,
        verification_distance_meters: Math.round(distanceFromCar),
      };

      if (typeof coords.accuracy === 'number') {
        verificationPayload.location_accuracy_meters = Math.round(coords.accuracy);
      }

      setRegion(createRegion(draftSpotCoordinate));

      const spotId = await shareSpot({
        latitude: draftSpotCoordinate.latitude,
        longitude: draftSpotCoordinate.longitude,
        scheduled_departure_time: scheduledDepartureTime,
        client_id: clientId,
        car_info: DEFAULT_CAR_INFO,
        ...verificationPayload,
      });

      setSharedSpot({
        id: spotId,
        scheduledDepartureTime,
        expiresAt,
      });
    } catch (error) {
      console.error(error);
      Alert.alert('Could not share spot', 'Check your connection and try again.');
    } finally {
      setIsSharingSpot(false);
    }
  };

  const handleCancelSharedSpot = async () => {
    if (isCancellingSpot) {
      return;
    }

    setIsCancellingSpot(true);

    try {
      const clientId = await getClientId();
      await cancelMyActiveSpot({ client_id: clientId });
      setSharedSpot(null);
    } catch (error) {
      console.error(error);
      Alert.alert('Could not cancel', 'Check your connection and try again.');
    } finally {
      setIsCancellingSpot(false);
    }
  };

  if (screen === 'locating') {
    return (
      <View style={styles.centerScreen}>
        <StatusBar style="light" />
        <View style={styles.loadingOrb}>
          <ActivityIndicator size="large" color={colors.green} />
        </View>
        <Text style={styles.centerTitle}>Finding you</Text>
        <Text style={styles.centerCopy}>One second. We are opening the map.</Text>
      </View>
    );
  }

  if (screen === 'error') {
    return (
      <View
        style={[
          styles.centerScreen,
          {
            paddingTop: insets.top + 28,
            paddingBottom: insets.bottom + 28,
          },
        ]}
      >
        <StatusBar style="light" />
        <View style={styles.errorIcon}>
          <Ionicons name="location" size={28} color={colors.orange} />
        </View>
        <Text style={styles.centerTitle}>Location is off</Text>
        <Text style={styles.centerCopy}>{errorMsg}</Text>
        <Pressable style={styles.primaryButton} onPress={() => prepareMap(intent)}>
          <Text style={styles.primaryButtonText}>Try again</Text>
        </Pressable>
        <Pressable style={styles.softButton} onPress={() => Linking.openSettings()}>
          <Text style={styles.softButtonText}>Open settings</Text>
        </Pressable>
      </View>
    );
  }

  if (screen === 'map' && region) {
    return (
      <View style={styles.mapScreen}>
        <StatusBar style="light" />
        <MapView
          style={styles.map}
          provider={PROVIDER_DEFAULT}
          region={region}
          onPress={
            intent === 'leave'
              ? (event) => handleDraftSpotChange(event.nativeEvent.coordinate)
              : undefined
          }
          onRegionChangeComplete={handleRegionChangeComplete}
          showsUserLocation
          showsMyLocationButton={false}
          userInterfaceStyle="dark"
        >
          {intent === 'find' &&
            parkingSignals.map((signal) => {
              const signalStyle = signalTypes[signal.type];

              return (
                <Marker
                  key={signal.id}
                  coordinate={signal.coordinate}
                  title={signal.title}
                  description={signal.subtitle}
                  onPress={() => setSelectedSignalId(signal.id)}
                >
                  <View
                    style={[
                      styles.signalMarker,
                      { backgroundColor: signalStyle.color },
                      focusedSignal?.id === signal.id && styles.signalMarkerSelected,
                    ]}
                  >
                    <Ionicons name={signalStyle.icon} size={20} color={colors.white} />
                  </View>
                </Marker>
              );
            })}
          {intent === 'leave' && draftSpotCoordinate && (
            <Marker
              coordinate={draftSpotCoordinate}
              draggable
              title="Car spot"
              description="Drag this pin onto the exact parking space."
              onDragEnd={(event) => handleDraftSpotChange(event.nativeEvent.coordinate)}
            >
              <View style={styles.carMarkerWrap}>
                <View style={styles.carMarker}>
                  <Ionicons name="car" size={22} color={colors.black} />
                </View>
                <View style={styles.carMarkerTip} />
              </View>
            </Marker>
          )}
        </MapView>

        <View
          style={[
            styles.mapTopBar,
            {
              top: insets.top + 12,
              left: Math.max(16, width * 0.04),
              right: Math.max(16, width * 0.04),
            },
          ]}
        >
          <Pressable style={styles.roundButton} onPress={() => setScreen('menu')}>
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <View style={styles.mapTitlePill}>
            <Image source={park2MeSmallLogo} style={styles.mapHeaderLogo} resizeMode="contain" />
            <Text style={styles.mapSubtitle}>
              {intent === 'find'
                ? activeSpots === undefined
                  ? 'Finding parking'
                  : `${parkingSignals.length} fresh spots`
                : draftSpotCoordinate
                  ? 'Car pin saved locally'
                  : 'Tap map for car pin'}
            </Text>
          </View>
          <Pressable style={styles.roundButton} onPress={() => prepareMap(intent)}>
            {isLocating ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Ionicons name="locate" size={21} color={colors.white} />
            )}
          </Pressable>
        </View>

        <View
          style={[
            styles.commandPanel,
            {
              paddingBottom: insets.bottom + 18,
              left: Math.max(12, width * 0.03),
              right: Math.max(12, width * 0.03),
            },
          ]}
        >
          <View style={styles.panelHandle} />

          {intent === 'find' ? (
            <View style={styles.panelBody}>
              <Text style={styles.panelTitle}>{focusedSignal ? focusedSignal.title : 'No fresh spots yet'}</Text>
              <Text style={styles.panelCopy}>
                {focusedSignal
                  ? `${focusedSignal.subtitle} away. Tap another spot to change.`
                  : 'Leave the map open. New spots appear automatically.'}
              </Text>
              <Pressable
                style={[styles.primaryButton, !focusedSignal && styles.buttonDisabled]}
                onPress={() => handleDriveToSpot(focusedSignal)}
                disabled={!focusedSignal}
              >
                <Ionicons name="navigate" size={20} color={colors.black} />
                <Text style={styles.primaryButtonText}>Drive there</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.panelBody}>
              {sharedSpotDisplay ? (
                <View style={styles.liveCard}>
                  <View
                    style={[
                      styles.liveDot,
                      {
                        backgroundColor: signalTypes[sharedSpotDisplay.status].color,
                      },
                    ]}
                  />
                  <View style={styles.liveText}>
                    <Text style={styles.panelTitle}>{sharedSpotDisplay.title}</Text>
                    <Text style={styles.panelCopy}>{sharedSpotDisplay.copy}</Text>
                  </View>
                  <Pressable
                    style={styles.cancelButton}
                    onPress={handleCancelSharedSpot}
                    disabled={isCancellingSpot}
                  >
                    {isCancellingSpot ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Ionicons name="close" size={18} color={colors.white} />
                    )}
                  </Pressable>
                </View>
              ) : (
                <>
                  <Text style={styles.panelTitle}>Mark your parked car</Text>
                  <Text style={styles.panelCopy}>
                    {draftSpotCoordinate
                      ? 'Drag the car pin onto the exact space. We publish only after you verify near the car.'
                      : 'Tap the map where your car is parked.'}
                  </Text>
                </>
              )}

              <View style={styles.pinStatusCard}>
                <View style={styles.pinStatusIcon}>
                  <Ionicons
                    name={draftSpotCoordinate ? 'location' : 'map'}
                    size={19}
                    color={colors.black}
                  />
                </View>
                <View style={styles.pinStatusText}>
                  <Text style={styles.pinStatusTitle}>
                    {draftSpotCoordinate ? 'Draft pin saved on this phone' : 'No car pin yet'}
                  </Text>
                  <Text style={styles.pinStatusCopy}>
                    {draftSpotCoordinate
                      ? 'Convex is not updated until verification.'
                      : 'Tap the map to place it.'}
                  </Text>
                </View>
              </View>

              <View style={styles.timeRow}>
                {departureTimes.map((minutes) => (
                  <Pressable
                    key={minutes}
                    style={[styles.timeChip, selectedTime === minutes && styles.timeChipActive]}
                    onPress={() => setSelectedTime(minutes)}
                  >
                    <Text style={[styles.timeChipText, selectedTime === minutes && styles.timeChipTextActive]}>
                      {minutes} min
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Pressable
                style={[
                  styles.primaryButton,
                  (isSharingSpot || !draftSpotCoordinate) && styles.buttonDisabled,
                ]}
                onPress={() => handleDropPin(selectedTime)}
                disabled={isSharingSpot || !draftSpotCoordinate}
              >
                {isSharingSpot ? (
                  <ActivityIndicator size="small" color={colors.black} />
                ) : (
                  <Ionicons name="checkmark-circle" size={20} color={colors.black} />
                )}
                <Text style={styles.primaryButtonText}>
                  {!draftSpotCoordinate
                    ? 'Place car pin'
                    : sharedSpotDisplay
                      ? 'Verify & update'
                      : 'Verify & share'}
                </Text>
              </Pressable>
            </View>
          )}

          {!panelIsCompact && (
            <Text style={styles.tinyNote}>
              {intent === 'leave' ? 'No live tracking. One verified publish.' : 'Simple. Fresh. Nearby.'}
            </Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.menuScreen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[
        styles.menuContent,
        {
          paddingTop: insets.top + 22,
          paddingBottom: insets.bottom + 30,
        },
      ]}
    >
      <StatusBar style="light" />
      <View style={styles.brandRow}>
        <Image source={park2MeSmallLogo} style={styles.brandLogo} resizeMode="contain" />
      </View>

      <View style={styles.heroCard}>
        <View style={styles.heroGlow} />
        <Text style={styles.heroTitle}>Park easier.</Text>
        <Text style={styles.heroCopy}>Find a spot or give yours when you leave.</Text>
      </View>

      <View style={styles.menuActions}>
        <MenuAction
          icon="search"
          title="Find a spot"
          copy="Open the map."
          onPress={() => prepareMap('find')}
        />
        <MenuAction
          icon="car"
          title="Give parking"
          copy="Help another driver."
          onPress={() => prepareMap('leave')}
        />
      </View>

      <View style={styles.simplePromise}>
        <Ionicons name="leaf" size={20} color={colors.green} />
        <Text style={styles.simplePromiseText}>Fresh spots only. No clutter.</Text>
      </View>
    </ScrollView>
  );
}

function MenuAction({ copy, icon, onPress, title }) {
  return (
    <Pressable style={styles.menuAction} onPress={onPress}>
      <View style={styles.menuActionIcon}>
        <Ionicons name={icon} size={23} color={colors.black} />
      </View>
      <View style={styles.menuActionText}>
        <Text style={styles.menuActionTitle}>{title}</Text>
        <Text style={styles.menuActionCopy}>{copy}</Text>
      </View>
      <Ionicons name="arrow-forward" size={20} color={colors.green} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  introScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
    backgroundColor: colors.black,
  },
  introLogo: {
    width: '100%',
    height: '92%',
    borderRadius: 30,
  },
  centerScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 28,
    backgroundColor: colors.black,
  },
  loadingOrb: {
    width: 86,
    height: 86,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 43,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  errorIcon: {
    width: 74,
    height: 74,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 26,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  centerTitle: {
    color: colors.white,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 0,
    textAlign: 'center',
  },
  centerCopy: {
    maxWidth: 300,
    color: colors.muted,
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
  menuScreen: {
    flex: 1,
    backgroundColor: colors.black,
  },
  menuContent: {
    gap: 18,
    paddingHorizontal: 18,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
  },
  brandLogo: {
    width: 176,
    height: 58,
  },
  heroCard: {
    minHeight: 270,
    justifyContent: 'flex-end',
    gap: 12,
    overflow: 'hidden',
    padding: 22,
    borderRadius: 30,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    boxShadow: '0 22px 44px rgba(0, 0, 0, 0.35)',
  },
  heroGlow: {
    position: 'absolute',
    top: 28,
    right: -36,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: colors.green,
    opacity: 0.22,
  },
  heroTitle: {
    color: colors.white,
    fontSize: 52,
    fontWeight: '900',
    lineHeight: 56,
    letterSpacing: 0,
  },
  heroCopy: {
    maxWidth: 280,
    color: colors.muted,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '700',
  },
  menuActions: {
    gap: 12,
  },
  menuAction: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 24,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  menuActionIcon: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: colors.green,
  },
  menuActionText: {
    flex: 1,
    gap: 3,
  },
  menuActionTitle: {
    color: colors.white,
    fontSize: 19,
    fontWeight: '900',
    letterSpacing: 0,
  },
  menuActionCopy: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '700',
  },
  simplePromise: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    padding: 16,
    borderRadius: 22,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  simplePromiseText: {
    flex: 1,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  mapScreen: {
    flex: 1,
    backgroundColor: colors.black,
  },
  map: {
    flex: 1,
    width: '100%',
  },
  mapTopBar: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  roundButton: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    boxShadow: '0 12px 28px rgba(0, 0, 0, 0.3)',
  },
  mapTitlePill: {
    flex: 1,
    alignItems: 'flex-start',
    gap: 2,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    boxShadow: '0 12px 28px rgba(0, 0, 0, 0.3)',
  },
  mapHeaderLogo: {
    width: 118,
    height: 34,
  },
  mapSubtitle: {
    color: colors.green,
    fontSize: 12,
    fontWeight: '900',
  },
  signalMarker: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 23,
    borderWidth: 4,
    borderColor: colors.black,
    boxShadow: '0 8px 18px rgba(0, 0, 0, 0.32)',
  },
  carMarkerWrap: {
    alignItems: 'center',
  },
  carMarker: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: colors.green,
    borderWidth: 4,
    borderColor: colors.black,
    boxShadow: '0 8px 18px rgba(0, 0, 0, 0.32)',
  },
  carMarkerTip: {
    width: 12,
    height: 12,
    marginTop: -8,
    borderRightWidth: 4,
    borderBottomWidth: 4,
    borderRightColor: colors.black,
    borderBottomColor: colors.black,
    backgroundColor: colors.green,
    transform: [{ rotate: '45deg' }],
  },
  commandPanel: {
    position: 'absolute',
    bottom: 0,
    gap: 14,
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    backgroundColor: colors.black,
    borderWidth: 1,
    borderColor: colors.border,
    boxShadow: '0 -22px 42px rgba(0, 0, 0, 0.42)',
  },
  panelHandle: {
    alignSelf: 'center',
    width: 42,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.panelRaised,
  },
  panelBody: {
    gap: 14,
  },
  panelTitle: {
    color: colors.white,
    fontSize: 27,
    fontWeight: '900',
    letterSpacing: 0,
  },
  panelCopy: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '700',
  },
  liveCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 22,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  liveDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  liveText: {
    flex: 1,
    gap: 2,
  },
  pinStatusCard: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 20,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pinStatusIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.green,
  },
  pinStatusText: {
    flex: 1,
    gap: 2,
  },
  pinStatusTitle: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '900',
  },
  pinStatusCopy: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  cancelButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.panelRaised,
  },
  timeRow: {
    flexDirection: 'row',
    gap: 9,
  },
  timeChip: {
    flex: 1,
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  timeChipActive: {
    backgroundColor: colors.greenSoft,
    borderColor: colors.green,
  },
  timeChipText: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  timeChipTextActive: {
    color: colors.green,
  },
  primaryButton: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: colors.green,
  },
  primaryButtonText: {
    color: colors.black,
    fontSize: 17,
    fontWeight: '900',
  },
  softButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderRadius: 18,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  softButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '900',
  },
  buttonDisabled: {
    opacity: 0.72,
  },
  tinyNote: {
    color: colors.dim,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
});
