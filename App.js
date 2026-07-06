import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, SafeAreaView, ActivityIndicator } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';

export default function App() {
  const [location, setLocation] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [region, setRegion] = useState(null); // Null until we get GPS

  useEffect(() => {
    (async () => {
      // 1. Auto-Location: Instantly request GPS permissions
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permission to access location was denied');
        return;
      }

      // 2. Fetch current location and center map
      let userLocation = await Location.getCurrentPositionAsync({});
      setLocation(userLocation.coords);
      setRegion({
        latitude: userLocation.coords.latitude,
        longitude: userLocation.coords.longitude,
        latitudeDelta: 0.01, // Zoomed in tight for street level
        longitudeDelta: 0.01,
      });
    })();
  }, []);

  // --- Handlers ---
  const handleLeaveParking = () => {
    Alert.alert('Leave Parking', 'How many minutes until you leave?', [
      { text: '2 mins', onPress: () => dropPin(2) },
      { text: '5 mins', onPress: () => dropPin(5) },
      { text: '8 mins', onPress: () => dropPin(8) },
      { text: 'Cancel', style: 'cancel' }
    ]);
  };

  const handleFindParking = () => {
    Alert.alert('Scanning...', 'Searching for Green, Orange, and Red pins nearby.');
  };

  const dropPin = (minutes) => {
    Alert.alert('Pin Dropped!', `You are leaving in ${minutes} minutes.`);
    // TODO: Push to Supabase here
  };

  // --- UI Loading State ---
  if (!region) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#10b981" />
        <Text style={styles.loadingText}>Locating you...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* MAP VIEW */}
      <MapView
        style={styles.map}
        provider={PROVIDER_DEFAULT} // Free native maps (Apple/Google)
        region={region}
        showsUserLocation={true}
        showsMyLocationButton={false} // We will use custom UI for this later
        userInterfaceStyle="dark" // Forces dark mode map tiles if supported
      >
        {/* Mock Green Pin (Guaranteed Spot) */}
        <Marker
          coordinate={{ latitude: region.latitude + 0.001, longitude: region.longitude + 0.001 }}
          title="Leaves in 5 mins"
          description="Toyota, Blue, ...123 (Guaranteed spot)"
          pinColor="green"
        />
        
        {/* Mock Red Pin (High Risk) */}
        <Marker
          coordinate={{ latitude: region.latitude - 0.002, longitude: region.longitude - 0.001 }}
          title="Vacated 5 mins ago"
          description="High risk"
          pinColor="red"
        />
      </MapView>

      {/* FLOATING ACTION BUTTONS */}
      <View style={styles.actionContainer}>
        <TouchableOpacity style={[styles.button, styles.findButton]} onPress={handleFindParking} activeOpacity={0.8}>
          <Ionicons name="search" size={24} color="white" />
          <Text style={styles.buttonText}>Find Parking</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.button, styles.leaveButton]} onPress={handleLeaveParking} activeOpacity={0.8}>
          <Ionicons name="car" size={24} color="white" />
          <Text style={styles.buttonText}>Leave Parking</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212', // Dark mode background
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#121212',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#a1a1aa',
    marginTop: 12,
    fontSize: 16,
  },
  map: {
    flex: 1,
    width: '100%',
  },
  actionContainer: {
    position: 'absolute',
    bottom: 50,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    width: '100%',
    paddingHorizontal: 15,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 15,
    borderRadius: 30,
    elevation: 8, // Android shadow
    shadowColor: '#000', // iOS shadow
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 5,
    width: '46%',
  },
  findButton: {
    backgroundColor: '#3b82f6', // Modern bright blue
  },
  leaveButton: {
    backgroundColor: '#10b981', // Emerald green
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
    marginLeft: 6,
  }
});
