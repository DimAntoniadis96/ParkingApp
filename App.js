import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

const signalTypes = {
  strong: {
    label: 'Strong lead',
    color: '#16a34a',
    softColor: '#dcfce7',
    icon: 'checkmark-circle',
  },
  watch: {
    label: 'Watch closely',
    color: '#f59e0b',
    softColor: '#fef3c7',
    icon: 'time',
  },
  stale: {
    label: 'Likely gone',
    color: '#ef4444',
    softColor: '#fee2e2',
    icon: 'alert-circle',
  },
};

const menuSignals = [
  { label: 'Fresh exits', value: '3', tone: 'strong' },
  { label: 'Open leads', value: '12', tone: 'watch' },
  { label: 'Avg. confidence', value: '82%', tone: 'strong' },
];

const departureTimes = [2, 5, 8];

function createRegion(coords) {
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    latitudeDelta: 0.012,
    longitudeDelta: 0.012,
  };
}

function createParkingSignals(region) {
  if (!region) {
    return [];
  }

  return [
    {
      id: 'fresh-exit',
      type: 'strong',
      title: 'Driver leaving in 5 min',
      subtitle: 'Blue Toyota, plate ending 123',
      confidence: '92%',
      distance: '90 m',
      coordinate: {
        latitude: region.latitude + 0.0011,
        longitude: region.longitude + 0.001,
      },
    },
    {
      id: 'soft-lead',
      type: 'watch',
      title: 'Meter just expired',
      subtitle: 'Good turnover street, verify on arrival',
      confidence: '68%',
      distance: '180 m',
      coordinate: {
        latitude: region.latitude - 0.0014,
        longitude: region.longitude + 0.0018,
      },
    },
    {
      id: 'old-lead',
      type: 'stale',
      title: 'Vacated 6 min ago',
      subtitle: 'High risk, likely taken',
      confidence: '31%',
      distance: '260 m',
      coordinate: {
        latitude: region.latitude - 0.002,
        longitude: region.longitude - 0.0012,
      },
    },
  ];
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ParkingApp />
    </SafeAreaProvider>
  );
}

function ParkingApp() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [screen, setScreen] = useState('menu');
  const [intent, setIntent] = useState('find');
  const [location, setLocation] = useState(null);
  const [region, setRegion] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [selectedTime, setSelectedTime] = useState(5);
  const [isRefreshingLocation, setIsRefreshingLocation] = useState(false);

  const isCompact = height < 720;
  const parkingSignals = useMemo(() => createParkingSignals(region), [region]);
  const highlightedSignal = parkingSignals[0];
  const locationAccuracy = location?.accuracy ? `${Math.round(location.accuracy)} m GPS` : 'Fresh source';

  const prepareMap = async (nextIntent = intent) => {
    setIntent(nextIntent);
    setErrorMsg('');

    if (!region) {
      setScreen('locating');
    } else {
      setIsRefreshingLocation(true);
    }

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        setErrorMsg('Location access is required to show nearby parking signals.');
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

      setLocation(currentLocation.coords);
      setRegion(createRegion(currentLocation.coords));
      setScreen('map');
    } catch (error) {
      setErrorMsg('We could not read your current location. Check GPS and try again.');
      setScreen(region ? 'map' : 'error');
    } finally {
      setIsRefreshingLocation(false);
    }
  };

  const handleFindParking = () => {
    Alert.alert(
      'Scanning nearby blocks',
      'ParkPilot is prioritizing fresh exits, meter activity, and stale signals around your current position.',
    );
  };

  const handleDropPin = (minutes = selectedTime) => {
    Alert.alert(
      'Departure signal shared',
      `Your spot is marked as opening in ${minutes} minutes. Supabase sync can be connected next.`,
    );
  };

  if (screen === 'locating') {
    return (
      <View style={styles.loadingScreen}>
        <StatusBar style="light" />
        <View style={styles.loadingOrb}>
          <ActivityIndicator size="large" color="#22c55e" />
        </View>
        <Text style={styles.loadingTitle}>Getting a clean fix</Text>
        <Text style={styles.loadingCopy}>
          We are centering the map around you before showing nearby parking signals.
        </Text>
      </View>
    );
  }

  if (screen === 'error') {
    return (
      <View
        style={[
          styles.errorScreen,
          {
            paddingTop: insets.top + 32,
            paddingBottom: insets.bottom + 28,
          },
        ]}
      >
        <StatusBar style="light" />
        <View style={styles.errorIcon}>
          <Ionicons name="location" size={30} color="#f97316" />
        </View>
        <Text style={styles.errorTitle}>Location is off</Text>
        <Text style={styles.errorCopy}>{errorMsg}</Text>
        <Pressable style={styles.primaryButton} onPress={() => prepareMap(intent)}>
          <Ionicons name="navigate" size={20} color="#ffffff" />
          <Text style={styles.primaryButtonText}>Try Again</Text>
        </Pressable>
        <Pressable style={styles.secondaryDarkButton} onPress={() => Linking.openSettings()}>
          <Text style={styles.secondaryDarkButtonText}>Open Settings</Text>
        </Pressable>
        <Pressable style={styles.textButton} onPress={() => setScreen('menu')}>
          <Text style={styles.textButtonLabel}>Back to menu</Text>
        </Pressable>
      </View>
    );
  }

  if (screen === 'map' && region) {
    return (
      <View style={styles.mapScreen}>
        <StatusBar style="dark" />
        <MapView
          style={styles.map}
          provider={PROVIDER_DEFAULT}
          region={region}
          showsUserLocation
          showsMyLocationButton={false}
          userInterfaceStyle="light"
        >
          {parkingSignals.map((signal) => (
            <Marker
              key={signal.id}
              coordinate={signal.coordinate}
              title={signal.title}
              description={signal.subtitle}
            >
              <View
                style={[
                  styles.signalMarker,
                  {
                    backgroundColor: signalTypes[signal.type].color,
                    borderColor: signalTypes[signal.type].softColor,
                  },
                ]}
              >
                <Text style={styles.signalMarkerText}>{signal.confidence}</Text>
              </View>
            </Marker>
          ))}
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
          <Pressable style={styles.menuButton} onPress={() => setScreen('menu')}>
            <Ionicons name="chevron-back" size={20} color="#111827" />
          </Pressable>
          <View style={styles.mapTitlePill}>
            <Text style={styles.mapEyebrow}>Live Parking Map</Text>
            <Text style={styles.mapTitle}>ParkPilot</Text>
          </View>
          <Pressable style={styles.menuButton} onPress={() => prepareMap(intent)}>
            {isRefreshingLocation ? (
              <ActivityIndicator size="small" color="#111827" />
            ) : (
              <Ionicons name="locate" size={20} color="#111827" />
            )}
          </Pressable>
        </View>

        <View style={[styles.legendPill, { top: insets.top + 84, right: Math.max(16, width * 0.04) }]}>
          {Object.entries(signalTypes).map(([key, signal]) => (
            <View key={key} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: signal.color }]} />
              <Text style={styles.legendText}>{signal.label}</Text>
            </View>
          ))}
        </View>

        <View
          style={[
            styles.commandPanel,
            {
              paddingBottom: insets.bottom + 18,
              left: Math.max(14, width * 0.035),
              right: Math.max(14, width * 0.035),
            },
          ]}
        >
          <View style={styles.panelHandle} />
          <View style={styles.modeSwitch}>
            <ModeButton
              active={intent === 'find'}
              icon="search"
              label="Find"
              onPress={() => setIntent('find')}
            />
            <ModeButton
              active={intent === 'leave'}
              icon="car"
              label="Leaving"
              onPress={() => setIntent('leave')}
            />
          </View>

          {intent === 'find' ? (
            <View style={styles.panelBody}>
              <View style={styles.panelHeader}>
                <View>
                  <Text style={styles.panelLabel}>Best nearby lead</Text>
                  <Text style={styles.panelTitle}>{highlightedSignal?.title || 'No signals yet'}</Text>
                </View>
                <View style={styles.confidenceBadge}>
                  <Text style={styles.confidenceText}>{highlightedSignal?.confidence || '--'}</Text>
                </View>
              </View>
              <View style={styles.signalDetailRow}>
                <SignalDetail icon="walk" label={highlightedSignal?.distance || 'Nearby'} />
                <SignalDetail icon="shield-checkmark" label={locationAccuracy} />
                <SignalDetail icon="flash" label="Fast scan" />
              </View>
              <Pressable style={styles.primaryButton} onPress={handleFindParking}>
                <Ionicons name="navigate" size={20} color="#ffffff" />
                <Text style={styles.primaryButtonText}>Scan This Area</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.panelBody}>
              <View style={styles.panelHeader}>
                <View>
                  <Text style={styles.panelLabel}>Share your spot</Text>
                  <Text style={styles.panelTitle}>When are you leaving?</Text>
                </View>
                <View style={styles.privacyBadge}>
                  <Ionicons name="lock-closed" size={14} color="#0f172a" />
                  <Text style={styles.privacyText}>Plate hidden</Text>
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
              <Pressable style={styles.primaryButton} onPress={() => handleDropPin(selectedTime)}>
                <Ionicons name="radio" size={20} color="#ffffff" />
                <Text style={styles.primaryButtonText}>Drop Departure Signal</Text>
              </Pressable>
            </View>
          )}

          {!isCompact && (
            <View style={styles.bottomHint}>
              <Ionicons name="information-circle" size={16} color="#64748b" />
              <Text style={styles.bottomHintText}>
                Green signals are current exits. Amber needs a quick visual check. Red is low confidence.
              </Text>
            </View>
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
        <View style={styles.brandMark}>
          <Ionicons name="car-sport" size={26} color="#0f172a" />
        </View>
        <View>
          <Text style={styles.brandName}>ParkPilot</Text>
          <Text style={styles.brandTagline}>Parking signals, not guesswork</Text>
        </View>
      </View>

      <View style={styles.heroCard}>
        <View style={styles.heroBadge}>
          <Ionicons name="sparkles" size={16} color="#bbf7d0" />
          <Text style={styles.heroBadgeText}>Smart start menu</Text>
        </View>
        <Text style={styles.heroTitle}>Where should we help first?</Text>
        <Text style={styles.heroCopy}>
          Find a fresh spot nearby or help the next driver by sharing when your space opens.
        </Text>
        <View style={styles.heroMapPreview}>
          <View style={[styles.previewStreet, styles.previewStreetOne]} />
          <View style={[styles.previewStreet, styles.previewStreetTwo]} />
          <View style={[styles.previewStreet, styles.previewStreetThree]} />
          <View style={[styles.previewPin, styles.previewPinStrong]}>
            <Text style={styles.previewPinText}>92</Text>
          </View>
          <View style={[styles.previewPin, styles.previewPinWatch]}>
            <Text style={styles.previewPinText}>68</Text>
          </View>
          <View style={[styles.previewPin, styles.previewPinStale]}>
            <Text style={styles.previewPinText}>31</Text>
          </View>
        </View>
      </View>

      <View style={styles.primaryActionGrid}>
        <MenuAction
          icon="search"
          title="Find parking"
          copy="Open the live map and rank the strongest nearby leads."
          accent="#22c55e"
          onPress={() => prepareMap('find')}
        />
        <MenuAction
          icon="car"
          title="I am leaving"
          copy="Share a private departure signal for drivers nearby."
          accent="#2563eb"
          onPress={() => prepareMap('leave')}
        />
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Current pulse</Text>
        <Text style={styles.sectionMeta}>Demo signals</Text>
      </View>
      <View style={styles.metricsRow}>
        {menuSignals.map((item) => (
          <View key={item.label} style={styles.metricCard}>
            <View style={[styles.metricDot, { backgroundColor: signalTypes[item.tone].color }]} />
            <Text style={styles.metricValue}>{item.value}</Text>
            <Text style={styles.metricLabel}>{item.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.intelligenceCard}>
        <View style={styles.intelligenceHeader}>
          <Ionicons name="analytics" size={20} color="#22c55e" />
          <Text style={styles.intelligenceTitle}>Signal intelligence</Text>
        </View>
        <SignalRow tone="strong" label="Green" copy="Confirmed departures and high-confidence openings." />
        <SignalRow tone="watch" label="Amber" copy="Useful hints that need a quick visual check." />
        <SignalRow tone="stale" label="Red" copy="Older reports kept visible so you do not waste time." />
      </View>
    </ScrollView>
  );
}

function MenuAction({ accent, copy, icon, onPress, title }) {
  return (
    <Pressable style={styles.menuAction} onPress={onPress}>
      <View style={[styles.menuActionIcon, { backgroundColor: accent }]}>
        <Ionicons name={icon} size={22} color="#ffffff" />
      </View>
      <Text style={styles.menuActionTitle}>{title}</Text>
      <Text style={styles.menuActionCopy}>{copy}</Text>
      <View style={styles.menuActionFooter}>
        <Text style={styles.menuActionFooterText}>Start</Text>
        <Ionicons name="arrow-forward" size={16} color="#0f172a" />
      </View>
    </Pressable>
  );
}

function ModeButton({ active, icon, label, onPress }) {
  return (
    <Pressable style={[styles.modeButton, active && styles.modeButtonActive]} onPress={onPress}>
      <Ionicons name={icon} size={18} color={active ? '#ffffff' : '#475569'} />
      <Text style={[styles.modeButtonText, active && styles.modeButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

function SignalDetail({ icon, label }) {
  return (
    <View style={styles.signalDetail}>
      <Ionicons name={icon} size={15} color="#16a34a" />
      <Text style={styles.signalDetailText}>{label}</Text>
    </View>
  );
}

function SignalRow({ copy, label, tone }) {
  const signal = signalTypes[tone];

  return (
    <View style={styles.signalRow}>
      <View style={[styles.signalRowIcon, { backgroundColor: signal.softColor }]}>
        <Ionicons name={signal.icon} size={18} color={signal.color} />
      </View>
      <View style={styles.signalRowText}>
        <Text style={styles.signalRowLabel}>{label}</Text>
        <Text style={styles.signalRowCopy}>{copy}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 28,
    backgroundColor: '#101514',
  },
  loadingOrb: {
    width: 88,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 44,
    backgroundColor: '#17211f',
    borderWidth: 1,
    borderColor: '#23443a',
  },
  loadingTitle: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 0,
  },
  loadingCopy: {
    maxWidth: 300,
    color: '#a7b2ad',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  errorScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 26,
    backgroundColor: '#101514',
  },
  errorIcon: {
    width: 74,
    height: 74,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    backgroundColor: '#1f1710',
    borderWidth: 1,
    borderColor: '#7c2d12',
  },
  errorTitle: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
  },
  errorCopy: {
    maxWidth: 320,
    color: '#b8c2bd',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  menuScreen: {
    flex: 1,
    backgroundColor: '#101514',
  },
  menuContent: {
    gap: 18,
    paddingHorizontal: 18,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  brandMark: {
    width: 50,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: '#bbf7d0',
  },
  brandName: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 0,
  },
  brandTagline: {
    color: '#9ca9a4',
    fontSize: 13,
    fontWeight: '600',
  },
  heroCard: {
    gap: 16,
    overflow: 'hidden',
    padding: 20,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: '#253430',
    backgroundColor: '#17211f',
    boxShadow: '0 18px 42px rgba(0, 0, 0, 0.25)',
  },
  heroBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#20322d',
  },
  heroBadgeText: {
    color: '#bbf7d0',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  heroTitle: {
    color: '#ffffff',
    fontSize: 38,
    fontWeight: '900',
    lineHeight: 42,
    letterSpacing: 0,
  },
  heroCopy: {
    color: '#c7d2cc',
    fontSize: 16,
    lineHeight: 24,
  },
  heroMapPreview: {
    height: 170,
    overflow: 'hidden',
    borderRadius: 22,
    backgroundColor: '#e9efe9',
    borderWidth: 1,
    borderColor: '#d6ded7',
  },
  previewStreet: {
    position: 'absolute',
    height: 18,
    borderRadius: 999,
    backgroundColor: '#ffffff',
  },
  previewStreetOne: {
    top: 38,
    left: -28,
    right: 24,
    transform: [{ rotate: '-10deg' }],
  },
  previewStreetTwo: {
    top: 86,
    left: 34,
    right: -24,
    transform: [{ rotate: '18deg' }],
  },
  previewStreetThree: {
    top: 126,
    left: -10,
    right: 56,
    transform: [{ rotate: '-4deg' }],
  },
  previewPin: {
    position: 'absolute',
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    borderWidth: 4,
    borderColor: '#ffffff',
  },
  previewPinStrong: {
    top: 42,
    right: 54,
    backgroundColor: '#16a34a',
  },
  previewPinWatch: {
    bottom: 34,
    left: 46,
    backgroundColor: '#f59e0b',
  },
  previewPinStale: {
    top: 24,
    left: 70,
    backgroundColor: '#ef4444',
  },
  previewPinText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  primaryActionGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  menuAction: {
    flex: 1,
    minHeight: 178,
    gap: 11,
    padding: 16,
    borderRadius: 24,
    backgroundColor: '#f8fafc',
    boxShadow: '0 14px 30px rgba(0, 0, 0, 0.22)',
  },
  menuActionIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  menuActionTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 0,
  },
  menuActionCopy: {
    flex: 1,
    color: '#64748b',
    fontSize: 13,
    lineHeight: 19,
  },
  menuActionFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  menuActionFooterText: {
    color: '#0f172a',
    fontSize: 13,
    fontWeight: '900',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '900',
  },
  sectionMeta: {
    color: '#9ca9a4',
    fontSize: 13,
    fontWeight: '700',
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  metricCard: {
    flex: 1,
    gap: 8,
    padding: 14,
    borderRadius: 20,
    backgroundColor: '#17211f',
    borderWidth: 1,
    borderColor: '#253430',
  },
  metricDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  metricValue: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  metricLabel: {
    color: '#9ca9a4',
    fontSize: 12,
    fontWeight: '700',
  },
  intelligenceCard: {
    gap: 14,
    padding: 18,
    borderRadius: 24,
    backgroundColor: '#f8fafc',
  },
  intelligenceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  intelligenceTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '900',
  },
  signalRow: {
    flexDirection: 'row',
    gap: 12,
  },
  signalRowIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  signalRowText: {
    flex: 1,
    gap: 2,
  },
  signalRowLabel: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '900',
  },
  signalRowCopy: {
    color: '#64748b',
    fontSize: 13,
    lineHeight: 18,
  },
  mapScreen: {
    flex: 1,
    backgroundColor: '#e8eee9',
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
  menuButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: '#ffffff',
    boxShadow: '0 10px 24px rgba(15, 23, 42, 0.18)',
  },
  mapTitlePill: {
    flex: 1,
    gap: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    boxShadow: '0 10px 24px rgba(15, 23, 42, 0.18)',
  },
  mapEyebrow: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  mapTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '900',
  },
  legendPill: {
    position: 'absolute',
    gap: 8,
    padding: 12,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    boxShadow: '0 10px 24px rgba(15, 23, 42, 0.16)',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    color: '#334155',
    fontSize: 11,
    fontWeight: '800',
  },
  signalMarker: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 27,
    borderWidth: 4,
    boxShadow: '0 8px 18px rgba(15, 23, 42, 0.24)',
  },
  signalMarkerText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  commandPanel: {
    position: 'absolute',
    bottom: 0,
    gap: 14,
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    backgroundColor: '#ffffff',
    boxShadow: '0 -18px 42px rgba(15, 23, 42, 0.2)',
  },
  panelHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#d1d5db',
  },
  modeSwitch: {
    flexDirection: 'row',
    gap: 8,
    padding: 5,
    borderRadius: 20,
    backgroundColor: '#eef2f0',
  },
  modeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    borderRadius: 16,
  },
  modeButtonActive: {
    backgroundColor: '#101514',
  },
  modeButtonText: {
    color: '#475569',
    fontSize: 14,
    fontWeight: '900',
  },
  modeButtonTextActive: {
    color: '#ffffff',
  },
  panelBody: {
    gap: 14,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  panelLabel: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  panelTitle: {
    color: '#0f172a',
    fontSize: 21,
    fontWeight: '900',
    letterSpacing: 0,
  },
  confidenceBadge: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#dcfce7',
  },
  confidenceText: {
    color: '#166534',
    fontSize: 16,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  signalDetailRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  signalDetail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#f1f5f3',
  },
  signalDetailText: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '800',
  },
  primaryButton: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    paddingHorizontal: 18,
    borderRadius: 18,
    backgroundColor: '#16a34a',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '900',
  },
  secondaryDarkButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderRadius: 18,
    backgroundColor: '#1f2a27',
    borderWidth: 1,
    borderColor: '#33443f',
  },
  secondaryDarkButtonText: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '900',
  },
  textButton: {
    padding: 10,
  },
  textButtonLabel: {
    color: '#bbf7d0',
    fontSize: 14,
    fontWeight: '900',
  },
  privacyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#e2e8f0',
  },
  privacyText: {
    color: '#0f172a',
    fontSize: 12,
    fontWeight: '900',
  },
  timeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  timeChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: '#eef2f0',
    borderWidth: 1,
    borderColor: '#dbe4df',
  },
  timeChipActive: {
    backgroundColor: '#dcfce7',
    borderColor: '#22c55e',
  },
  timeChipText: {
    color: '#475569',
    fontSize: 14,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  timeChipTextActive: {
    color: '#166534',
  },
  bottomHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    paddingTop: 2,
  },
  bottomHintText: {
    flex: 1,
    color: '#64748b',
    fontSize: 12,
    lineHeight: 17,
  },
});
