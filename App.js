import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
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
import { ConvexProvider, ConvexReactClient, useConvex, useMutation, useQuery } from 'convex/react';
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from 'react-native-maps';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from './convex/_generated/api';

const park2MeLogo = require('./park2me_logo.png');
const park2MeSmallLogo = require('./assets/park2me-small-logo-horizontal.png');

const colors = {
  // Premium glass dark palette. Panels are translucent so the live map glows
  // through them; borders are hairline white for that frosted-glass edge.
  black: '#04070d',
  night: '#070b12',
  panel: 'rgba(15, 21, 30, 0.86)',
  panelSoft: 'rgba(255, 255, 255, 0.055)',
  panelRaised: 'rgba(255, 255, 255, 0.10)',
  green: '#2fd06e',
  greenDeep: '#16a34a',
  greenSoft: 'rgba(47, 208, 110, 0.16)',
  greenGlow: 'rgba(47, 208, 110, 0.30)',
  orange: '#f7ad2b',
  orangeSoft: 'rgba(247, 173, 43, 0.16)',
  red: '#f2555a',
  redSoft: 'rgba(242, 85, 90, 0.16)',
  white: '#f2f6fc',
  muted: '#9aa8b6',
  dim: '#5a6672',
  border: 'rgba(255, 255, 255, 0.10)',
  borderStrong: 'rgba(255, 255, 255, 0.17)',
  hairline: 'rgba(255, 255, 255, 0.06)',
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

const departureWindows = [
  { id: '1-3', label: '1-3 min', min: 1, max: 3 },
  { id: '5-8', label: '5-8 min', min: 5, max: 8 },
  { id: '10-15', label: '10-15 min', min: 10, max: 15 },
];
const arrivalFeedbackOptions = [
  { id: 'parked', label: 'Yes, I parked', icon: 'checkmark', primary: true },
  { id: 'found_not_taken', label: 'Found, did not park', icon: 'remove' },
  { id: 'not_found', label: 'Could not find it', icon: 'close' },
];
const arrivalFeedbackMessages = {
  parked: 'Great. This helps us trust spots like this.',
  found_not_taken: 'Thanks. This helps us understand what happened at the spot.',
  not_found: 'Thanks. We will use this to improve freshness.',
};
const CLIENT_ID_STORAGE_KEY = 'park2me.clientId';
const DRAFT_SPOT_STORAGE_KEY = 'park2me.draftSpot';
const ACTIVE_QUERY_LIMIT = 60;
const MAP_QUERY_CELL_SIZE_DEGREES = 0.01;
const DRAFT_SPOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const NAVIGATION_ARRIVAL_RADIUS_METERS = 25;
const NAVIGATION_UPDATE_DISTANCE_METERS = 5;
const NAVIGATION_UPDATE_INTERVAL_MS = 2500;
const LOCATION_WATCH_DISTANCE_METERS = 8;
const LOCATION_WATCH_INTERVAL_MS = 4000;
const NAVIGATION_REGION_MIN_DELTA = 0.004;
const NAVIGATION_REGION_PADDING = 1.8;
const CITY_DRIVING_METERS_PER_SECOND = 5;
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

function createNavigationRegion(from, to) {
  const latitudeDelta = Math.max(
    Math.abs(from.latitude - to.latitude) * NAVIGATION_REGION_PADDING,
    NAVIGATION_REGION_MIN_DELTA,
  );
  const longitudeDelta = Math.max(
    Math.abs(from.longitude - to.longitude) * NAVIGATION_REGION_PADDING,
    NAVIGATION_REGION_MIN_DELTA,
  );

  return {
    latitude: (from.latitude + to.latitude) / 2,
    longitude: (from.longitude + to.longitude) / 2,
    latitudeDelta,
    longitudeDelta,
  };
}

function mapAreaKey(latitude, longitude) {
  const latCell = Math.floor(latitude / MAP_QUERY_CELL_SIZE_DEGREES);
  const lonCell = Math.floor(longitude / MAP_QUERY_CELL_SIZE_DEGREES);

  return `${latCell}:${lonCell}`;
}

function getNextNearbyQueryPoint(currentPoint, nextPoint) {
  if (!currentPoint) {
    return nextPoint;
  }

  if (
    mapAreaKey(currentPoint.latitude, currentPoint.longitude) ===
    mapAreaKey(nextPoint.latitude, nextPoint.longitude)
  ) {
    return currentPoint;
  }

  return nextPoint;
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

function bearingBetweenCoordinatesDegrees(from, to) {
  const fromLatitude = (from.latitude * Math.PI) / 180;
  const toLatitude = (to.latitude * Math.PI) / 180;
  const longitudeDelta = ((to.longitude - from.longitude) * Math.PI) / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function formatBearingDirection(degrees) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  return directions[Math.round(degrees / 45) % directions.length];
}

function formatMinutes(milliseconds) {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60000));

  return minutes === 1 ? '1 min' : `${minutes} min`;
}

function formatDistanceMeters(distance) {
  const roundedDistance = Math.round(distance);

  return roundedDistance < 1000 ? `${roundedDistance} m` : `${(roundedDistance / 1000).toFixed(1)} km`;
}

function formatEstimatedEta(distance) {
  return formatMinutes((distance / CITY_DRIVING_METERS_PER_SECOND) * 1000);
}

function distanceFromRegionMeters(spot, region) {
  if (!region) {
    return null;
  }

  const latitudeMeters = (spot.latitude - region.latitude) * 111000;
  const longitudeMeters =
    (spot.longitude - region.longitude) * 111000 * Math.cos((region.latitude * Math.PI) / 180);

  return Math.sqrt(latitudeMeters ** 2 + longitudeMeters ** 2);
}

function formatAgo(timestamp, now) {
  if (typeof timestamp !== 'number') {
    return null;
  }

  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));

  if (seconds < 45) {
    return 'just now';
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);

  return hours === 1 ? '1 hr ago' : `${hours} hr ago`;
}

function formatSpotTime(scheduledDepartureTime, now) {
  const milliseconds = scheduledDepartureTime - now;

  if (milliseconds > 0) {
    return `Opens in ${formatMinutes(milliseconds)}`;
  }

  return 'Open now';
}

function formatClockTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getSharedSpotDisplay(sharedSpot, now) {
  if (!sharedSpot || now >= sharedSpot.expiresAt) {
    return null;
  }

  if (sharedSpot.openConfirmedAt) {
    return {
      status: 'green',
      title: 'Verified open',
      copy: 'Drivers can see this as an open parking spot for the next few minutes.',
      needsDepartureConfirmation: false,
    };
  }

  const needsDepartureConfirmation = now >= sharedSpot.scheduledDepartureTime;

  return {
    status: 'orange',
    title: needsDepartureConfirmation ? 'Did you leave?' : 'Opening soon',
    copy: needsDepartureConfirmation
      ? 'Confirm so nearby drivers know the space is actually open.'
      : `Drivers see this as opening by ${formatClockTime(sharedSpot.scheduledDepartureTime)}.`,
    needsDepartureConfirmation,
  };
}

function mapConvexSpotToSignal(spot, region, now) {
  const isVerifiedOpen = spot.availability_status === 'verified_open';
  const isAwaitingConfirmation = !isVerifiedOpen && now >= spot.scheduled_departure_time;
  const distanceMeters = distanceFromRegionMeters(spot, region);
  const distanceLabel = distanceMeters === null ? 'nearby' : formatDistanceMeters(distanceMeters);
  const etaLabel = distanceMeters === null ? '—' : formatEstimatedEta(distanceMeters);
  const confirmedAgo = formatAgo(spot.open_confirmed_at, now);
  const sharedAgo = formatAgo(spot.created_at, now);

  const freshnessLabel = isVerifiedOpen
    ? `Confirmed ${confirmedAgo ?? 'open'}`
    : isAwaitingConfirmation
      ? `Awaiting confirmation • ${sharedAgo ?? 'just now'}`
      : `${formatSpotTime(spot.scheduled_departure_time, now)} • ${sharedAgo ?? 'just now'}`;

  return {
    id: spot._id,
    type: isVerifiedOpen ? 'green' : 'orange',
    title: isVerifiedOpen
      ? 'Verified open'
      : isAwaitingConfirmation
        ? 'Awaiting confirmation'
        : 'Parking opening',
    subtitle: isVerifiedOpen
      ? `Verified open now • ${distanceLabel}`
      : isAwaitingConfirmation
        ? `Not verified yet • driver confirmation pending • ${distanceLabel}`
        : `Not verified yet • opens by ${formatClockTime(spot.scheduled_departure_time)} • ${distanceLabel}`,
    detail: isVerifiedOpen
      ? 'This driver confirmed they left.'
      : isAwaitingConfirmation
        ? 'Not verified open yet.'
        : `${spot.departure_window_label || formatSpotTime(spot.scheduled_departure_time, now)} window. Not verified open yet.`,
    isVerifiedOpen,
    opensAt: spot.scheduled_departure_time,
    departureWindowLabel: spot.departure_window_label,
    distanceMeters,
    distanceLabel,
    etaLabel,
    freshnessLabel,
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

async function clearDraftSpot() {
  await AsyncStorage.removeItem(DRAFT_SPOT_STORAGE_KEY);
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
  const [selectedDepartureWindow, setSelectedDepartureWindow] = useState(departureWindows[1]);
  const [selectedSignalId, setSelectedSignalId] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [sharedSpot, setSharedSpot] = useState(null);
  const [isLocating, setIsLocating] = useState(false);
  const [isSharingSpot, setIsSharingSpot] = useState(false);
  const [isSettingCarLocation, setIsSettingCarLocation] = useState(false);
  const [isVerifyingSpot, setIsVerifyingSpot] = useState(false);
  const [isCancellingSpot, setIsCancellingSpot] = useState(false);
  const [isConfirmingDeparture, setIsConfirmingDeparture] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [navigationSpot, setNavigationSpot] = useState(null);
  const [isStartingNavigation, setIsStartingNavigation] = useState(false);
  const [isSendingArrivalFeedback, setIsSendingArrivalFeedback] = useState(false);
  const [arrivalFeedback, setArrivalFeedback] = useState(null);
  const [navigationError, setNavigationError] = useState('');
  const [leaveFlowStep, setLeaveFlowStep] = useState('chooseLocation');
  const [verifiedSpot, setVerifiedSpot] = useState(null);
  const [clientId, setClientId] = useState(null);
  const convexClient = useConvex();

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
  const confirmMySpotLeft = useMutation(api.parking.confirmMySpotLeft);
  const cancelMyActiveSpot = useMutation(api.parking.cancelMyActiveSpot);
  const recordNavigationFeedback = useMutation(api.parking.recordNavigationFeedback);

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
  const focusedSignal = navigationSpot || selectedSignal || bestSignal;
  const sharedSpotDisplay = getSharedSpotDisplay(sharedSpot, now);
  const panelIsCompact = height < 740;
  const userCoordinate = location ? toCoordinate(location) : null;
  const navigationDistance =
    navigationSpot && userCoordinate
      ? distanceBetweenCoordinatesMeters(userCoordinate, navigationSpot.coordinate)
      : null;
  const navigationBearing =
    navigationSpot && userCoordinate
      ? bearingBetweenCoordinatesDegrees(userCoordinate, navigationSpot.coordinate)
      : null;
  const navigationRouteCoordinates =
    navigationSpot && userCoordinate ? [userCoordinate, navigationSpot.coordinate] : [];
  const navigationHasArrived =
    typeof navigationDistance === 'number' && navigationDistance <= NAVIGATION_ARRIVAL_RADIUS_METERS;
  const navigationDirection =
    typeof navigationBearing === 'number' ? formatBearingDirection(navigationBearing) : '--';
  const arrivalFeedbackIsComplete =
    navigationSpot && arrivalFeedback?.spotId === navigationSpot.id;
  const arrivalFeedbackCopy = arrivalFeedbackIsComplete
    ? arrivalFeedbackMessages[arrivalFeedback.outcome] || 'Thanks for the feedback.'
    : 'Did you find it and take the parking? One tap helps improve Park2Me.';
  const leaveMapSubtitle = sharedSpotDisplay
    ? 'Parking shared'
    : leaveFlowStep === 'chooseLocation'
      ? 'Choose car location'
      : leaveFlowStep === 'placeManual'
        ? 'Tap exact parking space'
        : leaveFlowStep === 'verifyLocation'
          ? 'Verify car location'
          : leaveFlowStep === 'chooseTime'
            ? 'Choose leaving time'
            : 'Ready to publish';
  const mapSubtitle = navigationSpot
    ? navigationHasArrived
      ? 'Arrived at spot'
      : 'In-app GPS active'
    : intent === 'find'
      ? activeSpots === undefined
        ? 'Finding parking'
        : `${parkingSignals.length} fresh spots`
      : leaveMapSubtitle;
  const visibleCarPinCoordinate =
    sharedSpotDisplay && sharedSpot?.coordinate ? sharedSpot.coordinate : draftSpotCoordinate;
  const carPinIsVisible =
    intent === 'leave' &&
    visibleCarPinCoordinate &&
    (Boolean(sharedSpotDisplay) || leaveFlowStep !== 'chooseLocation');
  const carPinIsDraggable = !sharedSpotDisplay && leaveFlowStep === 'verifyLocation';

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
    let isMounted = true;

    getClientId()
      .then((id) => {
        if (isMounted) {
          setClientId(id);
        }
      })
      .catch((error) => {
        console.error(error);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Restore the user's own active share after an app restart so "Give parking"
  // reopens on the live spot instead of losing it. Single indexed read.
  useEffect(() => {
    if (!clientId) {
      return undefined;
    }

    let isActive = true;

    convexClient
      .query(api.parking.getMyActiveSpot, { client_id: clientId })
      .then((spot) => {
        if (!isActive || !spot) {
          return;
        }

        setSharedSpot((currentSpot) =>
          currentSpot || {
            id: spot._id,
            coordinate: {
              latitude: spot.latitude,
              longitude: spot.longitude,
            },
            scheduledDepartureTime: spot.scheduled_departure_time,
            departureWindowLabel: spot.departure_window_label,
            expiresAt: spot.expires_at,
            openConfirmedAt: spot.open_confirmed_at,
          },
        );
      })
      .catch((error) => {
        console.error(error);
      });

    return () => {
      isActive = false;
    };
  }, [clientId, convexClient]);

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

  useEffect(() => {
    setArrivalFeedback(null);
    setIsSendingArrivalFeedback(false);
  }, [navigationSpot?.id]);

  useEffect(() => {
    if (!navigationSpot || intent !== 'find' || screen !== 'map') {
      return undefined;
    }

    let isActive = true;
    let subscription = null;

    const startNavigationWatcher = async () => {
      setNavigationError('');
      setIsStartingNavigation(true);

      try {
        const { status } = await Location.requestForegroundPermissionsAsync();

        if (status !== 'granted') {
          if (isActive) {
            setNavigationError('Turn on location to use in-app GPS.');
          }
          return;
        }

        const currentLocation = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.BestForNavigation,
        });

        if (!isActive) {
          return;
        }

        const currentCoordinate = toCoordinate(currentLocation.coords);

        setLocation(currentLocation.coords);
        setNearbyQueryPoint((currentPoint) =>
          getNextNearbyQueryPoint(currentPoint, currentCoordinate),
        );
        setRegion(createNavigationRegion(currentCoordinate, navigationSpot.coordinate));

        const nextSubscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            distanceInterval: NAVIGATION_UPDATE_DISTANCE_METERS,
            timeInterval: NAVIGATION_UPDATE_INTERVAL_MS,
          },
          (nextLocation) => {
            const nextCoordinate = toCoordinate(nextLocation.coords);

            setLocation(nextLocation.coords);
            setNearbyQueryPoint((currentPoint) =>
              getNextNearbyQueryPoint(currentPoint, nextCoordinate),
            );
            setRegion(createNavigationRegion(nextCoordinate, navigationSpot.coordinate));
          },
          (reason) => {
            console.warn(reason);
            setNavigationError('Live location paused. Tap Recenter to retry.');
          },
        );

        if (!isActive) {
          nextSubscription.remove();
          return;
        }

        subscription = nextSubscription;
      } catch (error) {
        console.error(error);

        if (isActive) {
          setNavigationError('We could not start in-app GPS. Try again.');
        }
      } finally {
        if (isActive) {
          setIsStartingNavigation(false);
        }
      }
    };

    startNavigationWatcher();

    return () => {
      isActive = false;

      if (subscription) {
        subscription.remove();
      }
    };
  }, [intent, navigationSpot, screen]);

  // Keep the user's position live while the map is open (outside turn-by-turn
  // navigation, which runs its own high-accuracy watcher). This keeps the blue
  // dot, recenter, distances and "share my location" accurate as they move,
  // without hijacking the map — panning to browse other areas still works.
  useEffect(() => {
    if (screen !== 'map' || navigationSpot) {
      return undefined;
    }

    let isActive = true;
    let subscription = null;

    const startLocationWatcher = async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();

        if (status !== 'granted') {
          return;
        }

        const nextSubscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            distanceInterval: LOCATION_WATCH_DISTANCE_METERS,
            timeInterval: LOCATION_WATCH_INTERVAL_MS,
          },
          (nextLocation) => {
            if (isActive) {
              setLocation(nextLocation.coords);
            }
          },
        );

        if (!isActive) {
          nextSubscription.remove();
          return;
        }

        subscription = nextSubscription;
      } catch (error) {
        console.warn(error);
      }
    };

    startLocationWatcher();

    return () => {
      isActive = false;

      if (subscription) {
        subscription.remove();
      }
    };
  }, [screen, navigationSpot]);

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
    setVerifiedSpot(null);
    saveDraftSpot(nextCoordinate).catch((error) => {
      console.error(error);
    });
  };

  const handleRegionChangeComplete = (nextRegion) => {
    setRegion(nextRegion);

    if (intent !== 'find') {
      return;
    }

    const queryCoordinate =
      navigationSpot && userCoordinate ? userCoordinate : toCoordinate(nextRegion);

    setNearbyQueryPoint((currentPoint) => getNextNearbyQueryPoint(currentPoint, queryCoordinate));
  };

  const stopInAppNavigation = () => {
    setNavigationSpot(null);
    setNavigationError('');
    setIsStartingNavigation(false);
    setArrivalFeedback(null);
    setIsSendingArrivalFeedback(false);
  };

  const prepareMap = async (nextIntent = intent) => {
    setIntent(nextIntent);
    setErrorMsg('');
    setIsLocating(true);

    if (nextIntent !== 'find') {
      stopInAppNavigation();
    }

    if (nextIntent === 'leave') {
      setLeaveFlowStep('chooseLocation');
      setVerifiedSpot(null);
    }

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
      const nextRegion = createRegion(currentCoordinate);

      setLocation(currentLocation.coords);
      setRegion(nextRegion);

      if (nextIntent === 'find') {
        setNearbyQueryPoint(currentCoordinate);
      }

      setScreen('map');
    } catch (error) {
      setErrorMsg('We could not find you. Please try again.');
      setScreen(region ? 'map' : 'error');
    } finally {
      setIsLocating(false);
    }
  };

  const handleBackToMenu = () => {
    stopInAppNavigation();
    setScreen('menu');
  };

  const handleStartInAppNavigation = (signal) => {
    if (!signal) {
      Alert.alert('No spot selected', 'Tap a parking spot on the map first.');
      return;
    }

    setSelectedSignalId(signal.id);
    setNavigationSpot(signal);
    setArrivalFeedback(null);
    setIsSendingArrivalFeedback(false);

    if (userCoordinate) {
      setRegion(createNavigationRegion(userCoordinate, signal.coordinate));
    } else {
      setRegion(createRegion(signal.coordinate));
    }
  };

  const handleRecenterNavigation = () => {
    if (!navigationSpot) {
      return;
    }

    if (userCoordinate) {
      setRegion(createNavigationRegion(userCoordinate, navigationSpot.coordinate));
      return;
    }

    prepareMap('find');
  };

  const handleArrivalFeedback = async (outcome) => {
    if (isSendingArrivalFeedback || !navigationSpot) {
      return;
    }

    setIsSendingArrivalFeedback(true);

    try {
      const clientId = await getClientId();
      const feedbackPayload = {
        client_id: clientId,
        spot_id: navigationSpot.id,
        outcome,
      };

      if (typeof navigationDistance === 'number') {
        feedbackPayload.distance_meters = Math.round(navigationDistance);
      }

      await recordNavigationFeedback(feedbackPayload);

      setArrivalFeedback({
        spotId: navigationSpot.id,
        outcome,
      });
    } catch (error) {
      console.error(error);
      Alert.alert('Could not send feedback', 'Check your connection and try again.');
    } finally {
      setIsSendingArrivalFeedback(false);
    }
  };

  const handleRecenterToUser = async () => {
    if (userCoordinate) {
      setRegion(createRegion(userCoordinate));
      return;
    }

    setIsLocating(true);

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        Alert.alert('Location needed', 'Turn on location so we can recenter the map.');
        return;
      }

      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const currentCoordinate = toCoordinate(currentLocation.coords);

      setLocation(currentLocation.coords);
      setRegion(createRegion(currentCoordinate));
    } catch (error) {
      console.error(error);
      Alert.alert('Could not find you', 'Try again in a moment.');
    } finally {
      setIsLocating(false);
    }
  };

  const handleUseCurrentLocationForCar = async () => {
    if (isSettingCarLocation) {
      return;
    }

    setIsSettingCarLocation(true);

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        Alert.alert('Location needed', 'Turn on location or place the car pin manually on the map.');
        return;
      }

      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const currentCoordinate = toCoordinate(currentLocation.coords);

      setLocation(currentLocation.coords);
      handleDraftSpotChange(currentCoordinate);
      setRegion(createRegion(currentCoordinate));
      setLeaveFlowStep('verifyLocation');
    } catch (error) {
      console.error(error);
      Alert.alert('Could not find you', 'Tap the map to place the car pin manually.');
    } finally {
      setIsSettingCarLocation(false);
    }
  };

  const handleManualCarPlacement = () => {
    setDraftSpotCoordinate(null);
    setVerifiedSpot(null);
    setLeaveFlowStep('placeManual');
    clearDraftSpot().catch((error) => {
      console.error(error);
    });

    if (userCoordinate) {
      setRegion(createRegion(userCoordinate));
      return;
    }

    if (region) {
      setRegion(region);
      return;
    }
  };

  const handleManualMapPress = (coordinate) => {
    if (leaveFlowStep !== 'placeManual') {
      return;
    }

    handleDraftSpotChange(coordinate);
    setLeaveFlowStep('verifyLocation');
  };

  const handleCarPinDragEnd = (coordinate) => {
    handleDraftSpotChange(coordinate);
    setLeaveFlowStep('verifyLocation');
  };

  const handleVerifyCarLocation = async () => {
    if (isVerifyingSpot) {
      return;
    }

    if (!draftSpotCoordinate) {
      Alert.alert(
        'Where is your car?',
        'Use your current location or tap the map to place the pin exactly where the car is parked.',
      );
      return;
    }

    setIsVerifyingSpot(true);

    try {
      const verifiedAt = Date.now();
      const nextVerifiedSpot = {
        verifiedAt,
        verificationDistanceMeters: 0,
      };

      setVerifiedSpot(nextVerifiedSpot);
      setLeaveFlowStep('chooseTime');
    } catch (error) {
      console.error(error);
      Alert.alert('Could not verify', 'Check your location and try again.');
    } finally {
      setIsVerifyingSpot(false);
    }
  };

  const handleSelectDepartureWindow = (departureWindow) => {
    setSelectedDepartureWindow(departureWindow);
    setLeaveFlowStep('confirmPublic');
  };

  const handleBackToLocationChoice = () => {
    setLeaveFlowStep('chooseLocation');
    setVerifiedSpot(null);
  };

  const handleBackToPinVerification = () => {
    if (!draftSpotCoordinate) {
      setLeaveFlowStep('chooseLocation');
      return;
    }

    setVerifiedSpot(null);
    setLeaveFlowStep('verifyLocation');
  };

  const handleBackToDepartureWindow = () => {
    setLeaveFlowStep('chooseTime');
  };

  const handlePublishParkingSpot = async () => {
    if (isSharingSpot) {
      return;
    }

    if (!draftSpotCoordinate || !verifiedSpot) {
      setLeaveFlowStep(draftSpotCoordinate ? 'verifyLocation' : 'chooseLocation');
      Alert.alert('Verify first', 'Confirm the car location before sharing it with other drivers.');
      return;
    }

    setIsSharingSpot(true);

    try {
      const scheduledDepartureTime = Date.now() + selectedDepartureWindow.max * 60 * 1000;
      const clientId = await getClientId();
      const verificationPayload = {
        verified_at: verifiedSpot.verifiedAt,
        verification_distance_meters: verifiedSpot.verificationDistanceMeters,
      };

      const shareResult = await shareSpot({
        latitude: draftSpotCoordinate.latitude,
        longitude: draftSpotCoordinate.longitude,
        scheduled_departure_time: scheduledDepartureTime,
        departure_window_label: selectedDepartureWindow.label,
        departure_window_min_minutes: selectedDepartureWindow.min,
        departure_window_max_minutes: selectedDepartureWindow.max,
        client_id: clientId,
        car_info: DEFAULT_CAR_INFO,
        ...verificationPayload,
      });

      setSharedSpot({
        id: shareResult.spotId,
        coordinate: draftSpotCoordinate,
        scheduledDepartureTime: shareResult.scheduledDepartureTime,
        departureWindowLabel: shareResult.departureWindowLabel || selectedDepartureWindow.label,
        expiresAt: shareResult.expiresAt,
        openConfirmedAt: shareResult.openConfirmedAt,
      });
      setRegion(createRegion(draftSpotCoordinate));
      setLeaveFlowStep('chooseLocation');
      setVerifiedSpot(null);
    } catch (error) {
      console.error(error);
      Alert.alert('Could not share spot', 'Check your connection and try again.');
    } finally {
      setIsSharingSpot(false);
    }
  };

  const handleConfirmDeparture = async () => {
    if (isConfirmingDeparture || !sharedSpot) {
      return;
    }

    setIsConfirmingDeparture(true);

    try {
      const clientId = await getClientId();
      const confirmation = await confirmMySpotLeft({
        client_id: clientId,
        spot_id: sharedSpot.id,
      });

      setSharedSpot((currentSpot) =>
        currentSpot
          ? {
              ...currentSpot,
              openConfirmedAt: confirmation.openConfirmedAt,
              expiresAt: confirmation.expiresAt,
            }
          : currentSpot,
      );
      if (sharedSpot.coordinate) {
        setRegion(createRegion(sharedSpot.coordinate));
      }
    } catch (error) {
      console.error(error);
      Alert.alert('Could not verify open', 'Check your connection and try again.');
    } finally {
      setIsConfirmingDeparture(false);
    }
  };

  const handleNotLeftParking = async () => {
    if (isConfirmingDeparture) {
      return;
    }

    setIsConfirmingDeparture(true);

    try {
      const clientId = await getClientId();
      await cancelMyActiveSpot({ client_id: clientId });
      setSharedSpot(null);
      setLeaveFlowStep('chooseLocation');
      setVerifiedSpot(null);
    } catch (error) {
      console.error(error);
      Alert.alert('Could not update', 'Check your connection and try again.');
    } finally {
      setIsConfirmingDeparture(false);
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
      setLeaveFlowStep('chooseLocation');
      setVerifiedSpot(null);
    } catch (error) {
      console.error(error);
      Alert.alert('Could not cancel', 'Check your connection and try again.');
    } finally {
      setIsCancellingSpot(false);
    }
  };

  const renderLeavePanel = () => {
    if (sharedSpotDisplay) {
      if (sharedSpotDisplay.needsDepartureConfirmation) {
        return (
          <View style={styles.panelBody}>
            <View style={styles.carLocationCard}>
              <View style={styles.carLocationIcon}>
                <Ionicons name="help" size={21} color={colors.black} />
              </View>
              <View style={styles.carLocationText}>
                <Text style={styles.carLocationEyebrow}>Quick check</Text>
                <Text style={styles.carLocationTitle}>Did you leave?</Text>
                <Text style={styles.carLocationCopy}>
                  Your leaving window passed. Confirm only if the parking space is open now.
                </Text>
              </View>
            </View>

            <View style={styles.carChoiceRow}>
              <Pressable
                style={[
                  styles.carChoiceButton,
                  styles.carChoicePrimary,
                  isConfirmingDeparture && styles.buttonDisabled,
                ]}
                onPress={handleConfirmDeparture}
                disabled={isConfirmingDeparture}
              >
                {isConfirmingDeparture ? (
                  <ActivityIndicator size="small" color={colors.black} />
                ) : (
                  <Ionicons name="checkmark" size={18} color={colors.black} />
                )}
                <Text style={styles.carChoicePrimaryText}>Yes, I left</Text>
              </Pressable>
              <Pressable
                style={[styles.carChoiceButton, isConfirmingDeparture && styles.buttonDisabled]}
                onPress={handleNotLeftParking}
                disabled={isConfirmingDeparture}
              >
                <Ionicons name="close" size={18} color={colors.white} />
                <Text style={styles.carChoiceButtonText}>No</Text>
              </Pressable>
            </View>
          </View>
        );
      }

      return (
        <View style={styles.panelBody}>
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
          </View>

          <Pressable
            style={[styles.dangerButton, isCancellingSpot && styles.buttonDisabled]}
            onPress={handleCancelSharedSpot}
            disabled={isCancellingSpot}
          >
            {isCancellingSpot ? (
              <ActivityIndicator size="small" color={colors.red} />
            ) : (
              <Ionicons name="close-circle" size={20} color={colors.red} />
            )}
            <Text style={styles.dangerButtonText}>Cancel this parking</Text>
          </Pressable>
        </View>
      );
    }

    if (leaveFlowStep === 'placeManual') {
      return (
        <View style={styles.panelBody}>
          <View style={styles.carLocationCard}>
            <View style={styles.carLocationIcon}>
              <Ionicons name="map" size={21} color={colors.black} />
            </View>
            <View style={styles.carLocationText}>
              <Text style={styles.carLocationEyebrow}>Step 1 of 4</Text>
              <Text style={styles.carLocationTitle}>Tap the exact space</Text>
              <Text style={styles.carLocationCopy}>
                Tap once on the map. When the pin appears, fine-tune it by dragging the pin,
                not by tapping again.
              </Text>
            </View>
          </View>
          <Pressable
            style={[styles.carChoiceButton, styles.carChoiceFullButton]}
            onPress={handleUseCurrentLocationForCar}
            disabled={isSettingCarLocation}
          >
            {isSettingCarLocation ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Ionicons name="locate" size={18} color={colors.white} />
            )}
            <Text style={styles.carChoiceButtonText}>Use my current location instead</Text>
          </Pressable>
          <Pressable style={styles.softButton} onPress={handleBackToLocationChoice}>
            <Text style={styles.softButtonText}>Back</Text>
          </Pressable>
        </View>
      );
    }

    if (leaveFlowStep === 'verifyLocation') {
      return (
        <View style={styles.panelBody}>
          <View style={styles.carLocationCard}>
            <View style={styles.carLocationIcon}>
              <Ionicons name="shield-checkmark" size={21} color={colors.black} />
            </View>
            <View style={styles.carLocationText}>
              <Text style={styles.carLocationEyebrow}>Step 2 of 4</Text>
              <Text style={styles.carLocationTitle}>Verify your location</Text>
              <Text style={styles.carLocationCopy}>
                Drag the pin if needed. This exact point is what drivers will see.
              </Text>
            </View>
          </View>

          <View style={styles.pinStatusCard}>
            <View style={styles.pinStatusIcon}>
              <Ionicons name="location" size={19} color={colors.black} />
            </View>
            <View style={styles.pinStatusText}>
              <Text style={styles.pinStatusTitle}>Pin placed</Text>
              <Text style={styles.pinStatusCopy}>Corrections now happen by dragging the pin.</Text>
            </View>
          </View>

          <Pressable
            style={[styles.primaryButton, isVerifyingSpot && styles.buttonDisabled]}
            onPress={handleVerifyCarLocation}
            disabled={isVerifyingSpot}
          >
            {isVerifyingSpot ? (
              <ActivityIndicator size="small" color={colors.black} />
            ) : (
              <Ionicons name="checkmark-circle" size={20} color={colors.black} />
            )}
            <Text style={styles.primaryButtonText}>Verify location</Text>
          </Pressable>
          <Pressable style={styles.softButton} onPress={handleBackToLocationChoice}>
            <Text style={styles.softButtonText}>Back</Text>
          </Pressable>
        </View>
      );
    }

    if (leaveFlowStep === 'chooseTime') {
      return (
        <View style={styles.panelBody}>
          <View style={styles.carLocationCard}>
            <View style={styles.carLocationIcon}>
              <Ionicons name="time" size={21} color={colors.black} />
            </View>
            <View style={styles.carLocationText}>
              <Text style={styles.carLocationEyebrow}>Step 3 of 4</Text>
              <Text style={styles.carLocationTitle}>When will you leave?</Text>
              <Text style={styles.carLocationCopy}>
                Pick the closest estimate. The next tap takes you to the final share question.
              </Text>
            </View>
          </View>

          <View style={styles.timeRow}>
            {departureWindows.map((departureWindow) => (
              <Pressable
                key={departureWindow.id}
                style={[
                  styles.timeChip,
                  selectedDepartureWindow.id === departureWindow.id && styles.timeChipActive,
                ]}
                onPress={() => handleSelectDepartureWindow(departureWindow)}
              >
                <Text
                  style={[
                    styles.timeChipText,
                    selectedDepartureWindow.id === departureWindow.id && styles.timeChipTextActive,
                  ]}
                >
                  {departureWindow.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable style={styles.softButton} onPress={handleBackToPinVerification}>
            <Text style={styles.softButtonText}>Back</Text>
          </Pressable>
        </View>
      );
    }

    if (leaveFlowStep === 'confirmPublic') {
      return (
        <View style={styles.panelBody}>
          <View style={styles.carLocationCard}>
            <View style={styles.carLocationIcon}>
              <Ionicons name="people" size={21} color={colors.black} />
            </View>
            <View style={styles.carLocationText}>
              <Text style={styles.carLocationEyebrow}>Step 4 of 4</Text>
              <Text style={styles.carLocationTitle}>Make it public?</Text>
              <Text style={styles.carLocationCopy}>
                Nearby drivers will see this as opening soon. Your personal details stay private.
              </Text>
            </View>
          </View>

          <View style={styles.publicSummaryRow}>
            <View style={styles.publicSummaryItem}>
              <Text style={styles.navigationStatLabel}>Leaving in</Text>
              <Text style={styles.navigationStatValue}>{selectedDepartureWindow.label}</Text>
            </View>
            <View style={styles.publicSummaryItem}>
              <Text style={styles.navigationStatLabel}>Visibility</Text>
              <Text style={styles.navigationStatValue}>Public</Text>
            </View>
          </View>

          <Pressable
            style={[styles.primaryButton, isSharingSpot && styles.buttonDisabled]}
            onPress={handlePublishParkingSpot}
            disabled={isSharingSpot}
          >
            {isSharingSpot ? (
              <ActivityIndicator size="small" color={colors.black} />
            ) : (
              <Ionicons name="radio" size={20} color={colors.black} />
            )}
            <Text style={styles.primaryButtonText}>Share with drivers</Text>
          </Pressable>

          <View style={styles.navigationButtonRow}>
            <Pressable style={styles.softHalfButton} onPress={handleBackToDepartureWindow}>
              <Ionicons name="chevron-back" size={18} color={colors.white} />
              <Text style={styles.softHalfButtonText}>Back</Text>
            </Pressable>
            <Pressable style={styles.softHalfButton} onPress={handleBackToMenu}>
              <Ionicons name="close" size={18} color={colors.white} />
              <Text style={styles.softHalfButtonText}>Not now</Text>
            </Pressable>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.panelBody}>
        <View style={styles.carLocationCard}>
          <View style={styles.carLocationIcon}>
            <Ionicons name="car" size={21} color={colors.black} />
          </View>
          <View style={styles.carLocationText}>
            <Text style={styles.carLocationEyebrow}>Step 1 of 4</Text>
            <Text style={styles.carLocationTitle}>Where is your car?</Text>
            <Text style={styles.carLocationCopy}>
              Choose the fastest option. You can adjust the pin before verification.
            </Text>
          </View>
        </View>

        <View style={styles.carChoiceRow}>
          <Pressable
            style={[
              styles.carChoiceButton,
              styles.carChoicePrimary,
              isSettingCarLocation && styles.buttonDisabled,
            ]}
            onPress={handleUseCurrentLocationForCar}
            disabled={isSettingCarLocation}
          >
            {isSettingCarLocation ? (
              <ActivityIndicator size="small" color={colors.black} />
            ) : (
              <Ionicons name="locate" size={18} color={colors.black} />
            )}
            <Text style={styles.carChoicePrimaryText}>Car is at my location</Text>
          </Pressable>
          <Pressable style={styles.carChoiceButton} onPress={handleManualCarPlacement}>
            <Ionicons name="map" size={18} color={colors.white} />
            <Text style={styles.carChoiceButtonText}>Enter manually</Text>
          </Pressable>
        </View>
        <Pressable style={styles.softButton} onPress={handleBackToMenu}>
          <Text style={styles.softButtonText}>Back</Text>
        </Pressable>
      </View>
    );
  };

  if (screen === 'locating') {
    return (
      <View style={styles.centerScreen}>
        <StatusBar style="light" />
        <View style={styles.loadingOrb}>
          <ActivityIndicator size="large" color={colors.green} />
        </View>
        <Text style={styles.centerTitle}>Finding you</Text>
        <Text style={styles.centerCopy}>
          Opening the live map and scanning for fresh parking near you.
        </Text>
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
        <Text style={styles.centerCopy}>
          {errorMsg || 'Park2Me needs your location to show spots opening around you.'}
        </Text>
        <Pressable
          style={[styles.primaryButton, styles.centerActionButton]}
          onPress={() => prepareMap(intent)}
        >
          <Ionicons name="refresh" size={19} color={colors.black} />
          <Text style={styles.primaryButtonText}>Try again</Text>
        </Pressable>
        <Pressable
          style={[styles.softButton, styles.centerActionButton]}
          onPress={() => Linking.openSettings()}
        >
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
            intent === 'leave' && leaveFlowStep === 'placeManual'
              ? (event) => handleManualMapPress(event.nativeEvent.coordinate)
              : undefined
          }
          onRegionChangeComplete={handleRegionChangeComplete}
          showsUserLocation
          showsMyLocationButton={false}
          userInterfaceStyle="dark"
        >
          {navigationRouteCoordinates.length === 2 && (
            <>
              <Polyline
                coordinates={navigationRouteCoordinates}
                strokeColor={colors.black}
                strokeWidth={9}
                geodesic
                zIndex={8}
              />
              <Polyline
                coordinates={navigationRouteCoordinates}
                strokeColor={colors.green}
                strokeWidth={5}
                geodesic
                zIndex={9}
              />
            </>
          )}
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
          {intent === 'find' && navigationSpot && (
            <Marker
              coordinate={navigationSpot.coordinate}
              title="GPS destination"
              description={navigationSpot.subtitle}
              zIndex={10}
            >
              <View style={styles.destinationMarkerWrap}>
                <View style={styles.destinationMarker}>
                  <Ionicons name="flag" size={21} color={colors.black} />
                </View>
                <View style={styles.destinationMarkerTip} />
              </View>
            </Marker>
          )}
          {carPinIsVisible && (
            <Marker
              coordinate={visibleCarPinCoordinate}
              draggable={carPinIsDraggable}
              title="Car spot"
              description={
                sharedSpotDisplay
                  ? 'Your shared parking spot.'
                  : carPinIsDraggable
                    ? 'Drag this pin onto the exact parking space.'
                    : 'Confirmed parking spot.'
              }
              onDragEnd={(event) => handleCarPinDragEnd(event.nativeEvent.coordinate)}
              zIndex={12}
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
          <Pressable style={styles.roundButton} onPress={handleBackToMenu}>
            <Ionicons name="chevron-back" size={22} color={colors.white} />
          </Pressable>
          <View style={styles.mapTitlePill}>
            <Image source={park2MeSmallLogo} style={styles.mapHeaderLogo} resizeMode="contain" />
            <Text style={styles.mapSubtitle}>{mapSubtitle}</Text>
          </View>
          <Pressable
            style={styles.roundButton}
            onPress={
              navigationSpot
                ? handleRecenterNavigation
                : intent === 'leave'
                  ? handleRecenterToUser
                  : () => prepareMap(intent)
            }
          >
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
              {navigationSpot ? (
                <>
                  <View style={styles.navigationCard}>
                    <View style={styles.navigationCompass}>
                      {isStartingNavigation ? (
                        <ActivityIndicator size="small" color={colors.black} />
                      ) : isSendingArrivalFeedback ? (
                        <ActivityIndicator size="small" color={colors.black} />
                      ) : (
                        <Ionicons
                          name={
                            navigationHasArrived
                              ? arrivalFeedbackIsComplete
                                ? 'checkmark'
                                : 'help'
                              : 'navigate'
                          }
                          size={24}
                          color={colors.black}
                          style={
                            !navigationHasArrived && typeof navigationBearing === 'number'
                              ? { transform: [{ rotate: `${navigationBearing}deg` }] }
                              : undefined
                          }
                        />
                      )}
                    </View>
                    <View style={styles.navigationText}>
                      <Text style={styles.panelTitle}>
                        {navigationHasArrived
                          ? arrivalFeedbackIsComplete
                            ? 'Thanks for helping'
                            : 'Did you get this spot?'
                          : 'GPS to spot'}
                      </Text>
                      <Text style={styles.panelCopy}>
                        {navigationHasArrived
                          ? arrivalFeedbackCopy
                          : typeof navigationDistance === 'number'
                            ? `${formatDistanceMeters(navigationDistance)} away. Head ${navigationDirection}.`
                          : 'Starting live location. Keep Park2Me open.'}
                      </Text>
                    </View>
                  </View>

                  {navigationError ? (
                    <Text style={styles.navigationError}>{navigationError}</Text>
                  ) : null}

                  {navigationHasArrived ? (
                    arrivalFeedbackIsComplete ? (
                      <Pressable style={styles.primaryButton} onPress={stopInAppNavigation}>
                        <Ionicons name="checkmark-circle" size={20} color={colors.black} />
                        <Text style={styles.primaryButtonText}>Done</Text>
                      </Pressable>
                    ) : (
                      <View style={styles.arrivalFeedbackStack}>
                        <Pressable
                          style={[
                            styles.primaryButton,
                            isSendingArrivalFeedback && styles.buttonDisabled,
                          ]}
                          onPress={() => handleArrivalFeedback(arrivalFeedbackOptions[0].id)}
                          disabled={isSendingArrivalFeedback}
                        >
                          <Ionicons
                            name={arrivalFeedbackOptions[0].icon}
                            size={20}
                            color={colors.black}
                          />
                          <Text style={styles.primaryButtonText}>
                            {arrivalFeedbackOptions[0].label}
                          </Text>
                        </Pressable>
                        <View style={styles.navigationButtonRow}>
                          {arrivalFeedbackOptions.slice(1).map((option) => (
                            <Pressable
                              key={option.id}
                              style={[
                                styles.softHalfButton,
                                isSendingArrivalFeedback && styles.buttonDisabled,
                              ]}
                              onPress={() => handleArrivalFeedback(option.id)}
                              disabled={isSendingArrivalFeedback}
                            >
                              <Ionicons name={option.icon} size={18} color={colors.white} />
                              <Text style={styles.softHalfButtonText}>{option.label}</Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    )
                  ) : (
                    <>
                      <View style={styles.navigationStatsRow}>
                        <View style={styles.navigationStat}>
                          <Text style={styles.navigationStatLabel}>Distance</Text>
                          <Text style={styles.navigationStatValue}>
                            {typeof navigationDistance === 'number'
                              ? formatDistanceMeters(navigationDistance)
                              : '--'}
                          </Text>
                        </View>
                        <View style={styles.navigationStat}>
                          <Text style={styles.navigationStatLabel}>ETA</Text>
                          <Text style={styles.navigationStatValue}>
                            {typeof navigationDistance === 'number'
                              ? formatEstimatedEta(navigationDistance)
                              : '--'}
                          </Text>
                        </View>
                        <View style={styles.navigationStat}>
                          <Text style={styles.navigationStatLabel}>Direction</Text>
                          <Text style={styles.navigationStatValue}>{navigationDirection}</Text>
                        </View>
                      </View>

                      <View style={styles.navigationButtonRow}>
                        <Pressable style={styles.softHalfButton} onPress={handleRecenterNavigation}>
                          <Ionicons name="locate" size={18} color={colors.white} />
                          <Text style={styles.softHalfButtonText}>Recenter</Text>
                        </Pressable>
                        <Pressable style={styles.softHalfButton} onPress={stopInAppNavigation}>
                          <Ionicons name="close" size={18} color={colors.white} />
                          <Text style={styles.softHalfButtonText}>Stop GPS</Text>
                        </Pressable>
                      </View>
                    </>
                  )}
                </>
              ) : (
                <>
                  <View style={styles.listHeaderRow}>
                    <View style={styles.listHeaderText}>
                      <Text style={styles.panelTitle}>Fresh spots</Text>
                      <Text style={styles.panelCopy}>
                        {activeSpots === undefined
                          ? 'Scanning the streets around you…'
                          : parkingSignals.length
                            ? 'Tap a spot, then start in-app GPS.'
                            : 'Keep the map open — new spots appear live.'}
                      </Text>
                    </View>
                    {parkingSignals.length > 0 && (
                      <View style={styles.listCountPill}>
                        <Ionicons name="flash" size={13} color={colors.green} />
                        <Text style={styles.listCountText}>{parkingSignals.length}</Text>
                      </View>
                    )}
                  </View>

                  {activeSpots === undefined ? (
                    <View style={{ gap: 10 }}>
                      <View style={styles.skeletonRow} />
                      <View style={styles.skeletonRow} />
                    </View>
                  ) : parkingSignals.length === 0 ? (
                    <View style={styles.emptyState}>
                      <View style={styles.emptyIcon}>
                        <Ionicons name="car-sport" size={30} color={colors.green} />
                      </View>
                      <Text style={styles.emptyTitle}>No fresh spots yet</Text>
                      <Text style={styles.emptyCopy}>
                        Leave Park2Me open. The moment a nearby driver shares a spot it appears
                        here instantly — no refresh needed.
                      </Text>
                      <Pressable style={styles.softHalfButton} onPress={() => prepareMap('find')}>
                        <Ionicons name="locate" size={18} color={colors.white} />
                        <Text style={styles.softHalfButtonText}>Recenter</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <>
                      <ScrollView
                        style={styles.spotList}
                        contentContainerStyle={styles.spotListContent}
                        showsVerticalScrollIndicator={false}
                      >
                        {parkingSignals.map((signal) => {
                          const isSelected = focusedSignal?.id === signal.id;
                          const verified = signal.isVerifiedOpen;

                          return (
                            <Pressable
                              key={signal.id}
                              style={[styles.spotRow, isSelected && styles.spotRowSelected]}
                              onPress={() => setSelectedSignalId(signal.id)}
                            >
                              <View
                                style={[
                                  styles.spotRowIcon,
                                  { backgroundColor: verified ? colors.greenSoft : colors.orangeSoft },
                                ]}
                              >
                                <Ionicons
                                  name={verified ? 'checkmark-circle' : 'time'}
                                  size={22}
                                  color={verified ? colors.green : colors.orange}
                                />
                              </View>
                              <View style={styles.spotRowBody}>
                                <View
                                  style={[
                                    styles.trustBadge,
                                    verified ? styles.trustBadgeVerified : styles.trustBadgeSoon,
                                  ]}
                                >
                                  <View
                                    style={{
                                      width: 6,
                                      height: 6,
                                      borderRadius: 3,
                                      backgroundColor: verified ? colors.green : colors.orange,
                                    }}
                                  />
                                  <Text
                                    style={[
                                      styles.trustBadgeText,
                                      verified
                                        ? styles.trustBadgeTextVerified
                                        : styles.trustBadgeTextSoon,
                                    ]}
                                  >
                                    {verified ? 'Verified open' : 'Opening soon'}
                                  </Text>
                                </View>
                                <Text style={styles.spotRowMeta} numberOfLines={1}>
                                  {signal.freshnessLabel}
                                </Text>
                              </View>
                              <View style={styles.spotRowRight}>
                                <Text style={styles.spotRowDistance}>{signal.distanceLabel}</Text>
                                <Text style={styles.spotRowEta}>{signal.etaLabel}</Text>
                              </View>
                            </Pressable>
                          );
                        })}
                      </ScrollView>

                      <Pressable
                        style={[styles.primaryButton, !focusedSignal && styles.buttonDisabled]}
                        onPress={() => handleStartInAppNavigation(focusedSignal)}
                        disabled={!focusedSignal}
                      >
                        <Ionicons name="navigate" size={20} color={colors.black} />
                        <Text style={styles.primaryButtonText}>
                          {focusedSignal ? `Start GPS · ${focusedSignal.distanceLabel}` : 'Select a spot'}
                        </Text>
                      </Pressable>
                    </>
                  )}
                </>
              )}
            </View>
          ) : (
            renderLeavePanel()
          )}

          {!panelIsCompact && (
            <Text style={styles.tinyNote}>
              {intent === 'leave'
                ? 'Drivers see opening soon until you confirm you left.'
                : navigationSpot
                  ? 'Live GPS runs only while Park2Me is open.'
                  : 'Simple. Fresh. Nearby.'}
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
        <View style={styles.heroGlowSecondary} />
        <View style={styles.heroBadge}>
          <Ionicons name="flash" size={13} color={colors.green} />
          <Text style={styles.heroBadgeText}>Live nearby parking</Text>
        </View>
        <Text style={styles.heroTitle}>Park easier.</Text>
        <Text style={styles.heroCopy}>
          Grab a spot the second another driver pulls out — or pass yours forward when you go.
        </Text>
      </View>

      {sharedSpotDisplay && (
        <Pressable style={styles.resumeCard} onPress={() => prepareMap('leave')}>
          <View
            style={[
              styles.resumeDot,
              { backgroundColor: signalTypes[sharedSpotDisplay.status].color },
            ]}
          />
          <View style={styles.resumeText}>
            <Text style={styles.resumeTitle}>{sharedSpotDisplay.title}</Text>
            <Text style={styles.resumeCopy} numberOfLines={1}>
              Your shared spot is still live. Tap to manage it.
            </Text>
          </View>
          <Ionicons name="arrow-forward" size={20} color={colors.green} />
        </Pressable>
      )}

      <View style={styles.menuActions}>
        <MenuAction
          icon="search"
          title="Find a spot"
          copy="See fresh spots opening near you."
          onPress={() => prepareMap('find')}
        />
        <MenuAction
          icon="car"
          title="Give parking"
          copy="Share your spot as you leave."
          onPress={() => prepareMap('leave')}
        />
      </View>

      <View style={styles.simplePromise}>
        <Ionicons name="leaf" size={20} color={colors.green} />
        <Text style={styles.simplePromiseText}>
          Fresh, verified spots only. Anonymous by design — no plates, no clutter.
        </Text>
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
    minHeight: 276,
    justifyContent: 'flex-end',
    gap: 12,
    overflow: 'hidden',
    padding: 24,
    borderRadius: 32,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    boxShadow: '0 26px 60px rgba(0, 0, 0, 0.5)',
  },
  heroGlow: {
    position: 'absolute',
    top: 24,
    right: -46,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: colors.green,
    opacity: 0.26,
  },
  heroGlowSecondary: {
    position: 'absolute',
    bottom: -70,
    left: -50,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: colors.greenDeep,
    opacity: 0.16,
  },
  heroBadge: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.greenSoft,
    borderWidth: 1,
    borderColor: colors.green,
  },
  heroBadgeText: {
    color: colors.green,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
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
  resumeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    padding: 16,
    borderRadius: 22,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  resumeDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  resumeText: {
    flex: 1,
    gap: 2,
  },
  resumeTitle: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '900',
  },
  resumeCopy: {
    color: colors.muted,
    fontSize: 13,
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
  signalMarkerSelected: {
    borderColor: colors.white,
    transform: [{ scale: 1.08 }],
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
  destinationMarkerWrap: {
    alignItems: 'center',
  },
  destinationMarker: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: colors.green,
    borderWidth: 4,
    borderColor: colors.black,
    boxShadow: '0 8px 18px rgba(0, 0, 0, 0.32)',
  },
  destinationMarkerTip: {
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
    borderTopLeftRadius: 34,
    borderTopRightRadius: 34,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    boxShadow: '0 -24px 60px rgba(0, 0, 0, 0.55)',
  },
  panelHandle: {
    alignSelf: 'center',
    width: 44,
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
  navigationCard: {
    minHeight: 78,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 13,
    borderRadius: 22,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  navigationCompass: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: colors.green,
  },
  navigationText: {
    flex: 1,
    gap: 3,
  },
  navigationError: {
    color: colors.orange,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800',
  },
  navigationStatsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  navigationStat: {
    flex: 1,
    minHeight: 58,
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  navigationStatLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  navigationStatValue: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  navigationButtonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  arrivalFeedbackStack: {
    gap: 10,
  },
  softHalfButton: {
    flex: 1,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
    borderRadius: 17,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  softHalfButtonText: {
    flexShrink: 1,
    color: colors.white,
    fontSize: 14,
    fontWeight: '900',
    textAlign: 'center',
  },
  carLocationCard: {
    flexDirection: 'row',
    gap: 12,
    padding: 14,
    borderRadius: 22,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  carLocationIcon: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.green,
  },
  carLocationText: {
    flex: 1,
    gap: 4,
  },
  carLocationEyebrow: {
    color: colors.green,
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  carLocationTitle: {
    color: colors.white,
    fontSize: 23,
    fontWeight: '900',
    letterSpacing: 0,
  },
  carLocationCopy: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
  },
  carChoiceRow: {
    flexDirection: 'row',
    gap: 10,
  },
  carChoiceButton: {
    flex: 1,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 17,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  carChoicePrimary: {
    backgroundColor: colors.green,
    borderColor: colors.green,
  },
  carChoiceFullButton: {
    flex: 0,
    width: '100%',
  },
  carChoiceButtonText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
  },
  carChoicePrimaryText: {
    color: colors.black,
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
  },
  publicSummaryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  publicSummaryItem: {
    flex: 1,
    minHeight: 58,
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 16,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
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
  dangerButton: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: colors.redSoft,
    borderWidth: 1,
    borderColor: colors.red,
  },
  dangerButtonText: {
    color: colors.red,
    fontSize: 16,
    fontWeight: '900',
  },
  centerActionButton: {
    alignSelf: 'stretch',
    maxWidth: 340,
    width: '100%',
  },
  tinyNote: {
    color: colors.dim,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },

  // Find mode: browsable ranked spot list
  listHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  listHeaderText: {
    flex: 1,
    gap: 2,
  },
  listCountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.greenSoft,
    borderWidth: 1,
    borderColor: colors.green,
  },
  listCountText: {
    color: colors.green,
    fontSize: 13,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  spotList: {
    maxHeight: 232,
    marginHorizontal: -4,
  },
  spotListContent: {
    gap: 10,
    paddingHorizontal: 4,
    paddingBottom: 2,
  },
  spotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    padding: 13,
    borderRadius: 20,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  spotRowSelected: {
    borderColor: colors.green,
    backgroundColor: colors.greenSoft,
  },
  spotRowIcon: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  spotRowBody: {
    flex: 1,
    gap: 5,
  },
  spotRowMeta: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  spotRowRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  spotRowDistance: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  spotRowEta: {
    color: colors.dim,
    fontSize: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  trustBadge: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  trustBadgeVerified: {
    backgroundColor: colors.greenSoft,
    borderColor: colors.green,
  },
  trustBadgeSoon: {
    backgroundColor: colors.orangeSoft,
    borderColor: colors.orange,
  },
  trustBadgeText: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.2,
    textTransform: 'uppercase',
  },
  trustBadgeTextVerified: {
    color: colors.green,
  },
  trustBadgeTextSoon: {
    color: colors.orange,
  },

  // Empty / loading states inside the find panel
  emptyState: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 22,
    paddingHorizontal: 12,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 26,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: {
    color: colors.white,
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  emptyCopy: {
    maxWidth: 290,
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  skeletonRow: {
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.panelSoft,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
});
