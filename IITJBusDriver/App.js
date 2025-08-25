import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  StatusBar,
  SafeAreaView,
  ActivityIndicator,
  Platform
} from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import io from 'socket.io-client';

const BACKEND_URL = 'http://localhost:3001';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState('home');
  const [selectedBus, setSelectedBus] = useState(null);
  const [tracking, setTracking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [updateCount, setUpdateCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [appInitialized, setAppInitialized] = useState(false);
  
  const socketRef = useRef(null);
  const locationSubscription = useRef(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;

  // Initialize app and recover previous state
  useEffect(() => {
    initializeApp();
    return () => cleanup();
  }, []);

  // Handle socket connection when bus is selected
  useEffect(() => {
    if (appInitialized && selectedBus && !socketRef.current) {
      connectSocket();
    }
  }, [selectedBus, appInitialized]);

  const initializeApp = async () => {
    try {
      // Request location permissions
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location permission is required for GPS tracking.');
        return;
      }

      if (Platform.OS !== 'web') {
        await Location.requestBackgroundPermissionsAsync();
      }

      // Recover previous session state
      await recoverAppState();
      setAppInitialized(true);

    } catch (error) {
      console.error('Error initializing app:', error);
      setAppInitialized(true);
    }
  };

  const recoverAppState = async () => {
    try {
      const [savedBus, savedTracking, savedScreen] = await Promise.all([
        AsyncStorage.getItem('selectedBus'),
        AsyncStorage.getItem('tracking'),
        AsyncStorage.getItem('currentScreen')
      ]);

      console.log('Recovering state:', { savedBus, savedTracking, savedScreen });

      if (savedBus) {
        const busNumber = parseInt(savedBus);
        setSelectedBus(busNumber);
        
        if (savedScreen === 'trip') {
          setCurrentScreen('trip');
        }
        
        // If was tracking, prompt user to continue or restart
        if (savedTracking === 'true') {
          setTimeout(() => {
            Alert.alert(
              'Previous Session',
              `Bus ${busNumber} was tracking when the app closed. Do you want to continue?`,
              [
                {
                  text: 'Start Fresh',
                  onPress: () => {
                    setTracking(false);
                    AsyncStorage.setItem('tracking', 'false');
                  }
                },
                {
                  text: 'Continue Tracking',
                  onPress: () => {
                    setTracking(true);
                    // Will start tracking after socket connection
                  }
                }
              ]
            );
          }, 1000);
        }
      }
    } catch (error) {
      console.error('Error recovering app state:', error);
    }
  };

  const connectSocket = useCallback(() => {
    // Prevent multiple connections
    if (socketRef.current?.connected) {
      console.log('Socket already connected');
      return;
    }

    // Disconnect existing socket if any
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    try {
      console.log(`Connecting to backend for Bus ${selectedBus}...`);
      setReconnecting(false);
      
      socketRef.current = io(BACKEND_URL, {
        transports: ['websocket', 'polling'],
        timeout: 20000,
        forceNew: true,
        reconnection: true,
        reconnectionAttempts: maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
      });

      socketRef.current.on('connect', () => {
        console.log(`Connected to backend for Bus ${selectedBus}`);
        setConnected(true);
        setReconnecting(false);
        reconnectAttempts.current = 0;
      });

      socketRef.current.on('disconnect', (reason) => {
        console.log('Disconnected from backend:', reason);
        setConnected(false);
        
        if (reason === 'io server disconnect') {
          // Server initiated disconnect, don't reconnect automatically
          return;
        }
        
        handleReconnection();
      });

      socketRef.current.on('connect_error', (error) => {
        console.log('Connection error:', error);
        setConnected(false);
        handleReconnection();
      });

      socketRef.current.on('locationSaved', (response) => {
        if (response.success) {
          console.log(`Location saved for ${response.busId}`);
        } else {
          console.error(`Error saving location for ${response.busId}:`, response.error);
        }
      });

      socketRef.current.on('reconnect', (attemptNumber) => {
        console.log(`Reconnected after ${attemptNumber} attempts`);
        setConnected(true);
        setReconnecting(false);
      });

      socketRef.current.on('reconnect_attempt', (attemptNumber) => {
        console.log(`Reconnection attempt ${attemptNumber}`);
        setReconnecting(true);
      });

      socketRef.current.on('reconnect_failed', () => {
        console.log('Failed to reconnect after maximum attempts');
        setReconnecting(false);
        Alert.alert(
          'Connection Failed', 
          'Unable to connect to server. Please check your internet connection and try again.',
          [{ text: 'Retry', onPress: () => connectSocket() }]
        );
      });

    } catch (error) {
      console.error('Socket connection error:', error);
      setConnected(false);
      handleReconnection();
    }
  }, [selectedBus]);

  const handleReconnection = () => {
    if (reconnectAttempts.current < maxReconnectAttempts) {
      reconnectAttempts.current++;
      setReconnecting(true);
      
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current - 1), 5000);
      setTimeout(() => {
        if (selectedBus && !socketRef.current?.connected) {
          connectSocket();
        }
      }, delay);
    }
  };

  const selectBus = async (busNumber) => {
    console.log(`Selecting Bus ${busNumber}`);
    
    // Stop any existing tracking
    if (tracking) {
      await stopTracking();
    }
    
    // Disconnect existing socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    
    // Reset states
    setSelectedBus(busNumber);
    setCurrentScreen('trip');
    setConnected(false);
    setTracking(false);
    setCurrentLocation(null);
    setLastUpdate(null);
    setUpdateCount(0);
    setReconnecting(false);
    reconnectAttempts.current = 0;
    
    // Save state
    await Promise.all([
      AsyncStorage.setItem('selectedBus', busNumber.toString()),
      AsyncStorage.setItem('currentScreen', 'trip'),
      AsyncStorage.setItem('tracking', 'false')
    ]);
    
    // Connect will be handled by useEffect
  };

  const goHome = async () => {
    console.log('Navigating to home screen');
    
    if (tracking) {
      await stopTracking();
    }
    
    // Disconnect socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    
    // Reset all states
    setCurrentScreen('home');
    setSelectedBus(null);
    setConnected(false);
    setTracking(false);
    setCurrentLocation(null);
    setLastUpdate(null);
    setUpdateCount(0);
    setReconnecting(false);
    
    // Clear saved state
    await Promise.all([
      AsyncStorage.removeItem('selectedBus'),
      AsyncStorage.setItem('currentScreen', 'home'),
      AsyncStorage.setItem('tracking', 'false')
    ]);
  };

  const startTracking = async () => {
    if (!connected || !selectedBus) {
      Alert.alert('Error', 'No connection to server or bus not selected.');
      return;
    }

    if (tracking) {
      console.log('Already tracking');
      return;
    }

    console.log(`Starting tracking for Bus ${selectedBus}`);
    setLoading(true);
    
    try {
      const busId = `IITJ_BUS_0${selectedBus}`;
      
      // Send trip started event
      if (socketRef.current?.connected) {
        socketRef.current.emit('tripStarted', {
          busId: busId,
          timestamp: new Date().toISOString()
        });
        console.log(`Trip started event sent for ${busId}`);
      }

      // Start location tracking
      locationSubscription.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 10000,
          distanceInterval: 20,
        },
        (position) => {
          const { latitude, longitude, speed, heading } = position.coords;
          
          const locationData = {
            busId: busId,
            latitude: parseFloat(latitude.toFixed(6)),
            longitude: parseFloat(longitude.toFixed(6)),
            speed: speed ? Math.round(speed * 3.6) : 0,
            heading: heading || 0,
            timestamp: new Date().toISOString(),
            accuracy: position.coords.accuracy
          };

          setCurrentLocation(locationData);
          setLastUpdate(new Date());
          setUpdateCount(prev => prev + 1);

          // Send location update only if connected
          if (socketRef.current?.connected) {
            socketRef.current.emit('busLocationUpdate', locationData);
            console.log(`Location sent for ${busId}:`, locationData.latitude, locationData.longitude);
          }
        }
      );

      setTracking(true);
      await AsyncStorage.setItem('tracking', 'true');

    } catch (error) {
      console.error('Error starting location tracking:', error);
      Alert.alert('Error', 'Could not start GPS tracking. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const stopTracking = async () => {
    if (!tracking) {
      console.log('Not currently tracking');
      return;
    }

    console.log(`Stopping tracking for Bus ${selectedBus}`);
    setLoading(true);

    try {
      // Stop location updates
      if (locationSubscription.current) {
        locationSubscription.current.remove();
        locationSubscription.current = null;
      }

      // Send trip ended event
      if (socketRef.current?.connected && selectedBus) {
        const busId = `IITJ_BUS_0${selectedBus}`;
        socketRef.current.emit('tripEnded', {
          busId: busId,
          timestamp: new Date().toISOString()
        });
        console.log(`Trip ended event sent for ${busId}`);
      }

      setTracking(false);
      setCurrentLocation(null);
      setLastUpdate(null);
      setUpdateCount(0);
      
      await AsyncStorage.setItem('tracking', 'false');

    } catch (error) {
      console.error('Error stopping tracking:', error);
    } finally {
      setLoading(false);
    }
  };

  const cleanup = () => {
    console.log('Cleaning up app resources');
    
    if (locationSubscription.current) {
      locationSubscription.current.remove();
    }
    
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
  };

  const formatTime = (date) => {
    return date ? date.toLocaleTimeString() : '--:--:--';
  };

  const getConnectionStatusText = () => {
    if (reconnecting) return 'Reconnecting...';
    if (connected) return 'Connected';
    return 'Offline';
  };

  const getConnectionStatusColor = () => {
    if (reconnecting) return '#f59e0b';
    if (connected) return '#10b981';
    return '#ef4444';
  };

  // Show loading screen during initialization
  if (!appInitialized) {
    return (
      <SafeAreaView style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#1e40af" />
        <Text style={{ marginTop: 20, fontSize: 16 }}>Initializing IITJ Bus Driver App...</Text>
      </SafeAreaView>
    );
  }

  // Home Screen
  if (currentScreen === 'home') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#1e40af" />
        
        <View style={styles.header}>
          <Text style={styles.headerTitle}>🚌 IITJ Bus Driver</Text>
          <Text style={styles.headerSubtitle}>Select Your Bus</Text>
        </View>

        <View style={styles.content}>
          <View style={styles.busSelectionContainer}>
            <Text style={styles.selectTitle}>Select Bus</Text>
            <Text style={styles.selectSubtitle}>Choose which bus you're driving today</Text>
            
            <TouchableOpacity
              style={styles.busButton}
              onPress={() => selectBus(1)}
            >
              <Text style={styles.busButtonText}>🚌 Bus 1</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.busButton}
              onPress={() => selectBus(2)}
            >
              <Text style={styles.busButtonText}>🚌 Bus 2</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Trip Screen
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#1e40af" />
      
      <View style={styles.header}>
        <TouchableOpacity onPress={goHome} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>🚌 Bus {selectedBus}</Text>
        <Text style={styles.headerSubtitle}>ID: IITJ_BUS_0{selectedBus}</Text>
        <View style={styles.connectionStatus}>
          <View style={[styles.connectionDot, { backgroundColor: getConnectionStatusColor() }]} />
          <Text style={styles.connectionText}>{getConnectionStatusText()}</Text>
        </View>
      </View>

      <View style={styles.content}>
        {/* Status Card */}
        <View style={styles.statusCard}>
          <View style={styles.statusHeader}>
            <Text style={styles.statusTitle}>Trip Status</Text>
            <View style={[styles.statusBadge, tracking ? styles.activeBadge : styles.inactiveBadge]}>
              <Text style={styles.statusBadgeText}>
                {tracking ? 'ACTIVE TRIP' : 'NO ACTIVE TRIP'}
              </Text>
            </View>
          </View>

          {tracking && currentLocation && (
            <View style={styles.locationInfo}>
              <Text style={styles.infoTitle}>📍 Current Location</Text>
              <Text style={styles.coordinates}>
                {currentLocation.latitude}, {currentLocation.longitude}
              </Text>
              <Text style={styles.infoText}>🕒 Last Update: {formatTime(lastUpdate)}</Text>
              <Text style={styles.infoText}>🚗 Speed: {currentLocation.speed} km/h</Text>
              <Text style={styles.infoText}>📡 Updates Sent: {updateCount}</Text>
            </View>
          )}
        </View>

        {/* Control Buttons */}
        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[
              styles.controlButton,
              styles.startButton,
              (tracking || !connected || loading) && styles.disabledButton
            ]}
            onPress={startTracking}
            disabled={tracking || !connected || loading}
          >
            {loading && !tracking ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.controlButtonText}>🚀 Start Trip</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.controlButton,
              styles.stopButton,
              (!tracking || loading) && styles.disabledButton
            ]}
            onPress={stopTracking}
            disabled={!tracking || loading}
          >
            {loading && tracking ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.controlButtonText}>🛑 Stop Trip</Text>
            )}
          </TouchableOpacity>
        </View>

        {!connected && !reconnecting && (
          <View style={styles.warningBox}>
            <Text style={styles.warningText}>
              ⚠️ No connection to server. Please check your internet connection.
            </Text>
            <TouchableOpacity 
              style={styles.retryButton}
              onPress={connectSocket}
            >
              <Text style={styles.retryButtonText}>Retry Connection</Text>
            </TouchableOpacity>
          </View>
        )}

        {reconnecting && (
          <View style={styles.warningBox}>
            <ActivityIndicator size="small" color="#f59e0b" />
            <Text style={styles.warningText}>
              🔄 Reconnecting to server...
            </Text>
          </View>
        )}

        {/* Instructions */}
        <View style={styles.instructionsCard}>
          <Text style={styles.instructionsTitle}>📱 Driver Instructions</Text>
          <Text style={styles.instructionText}>• Tap "Start Trip" when beginning your route</Text>
          <Text style={styles.instructionText}>• Location updates sent every 10 seconds during active trips</Text>
          <Text style={styles.instructionText}>• Always tap "Stop Trip" when ending your route</Text>
          <Text style={styles.instructionText}>• App will remember your session if it restarts</Text>
          <Text style={styles.instructionText}>• Keep the app open for continuous tracking</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

// Add these new styles to your existing StyleSheet
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    backgroundColor: '#1e40af',
    paddingTop: 20,
    paddingBottom: 20,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 10,
    padding: 5,
  },
  backButtonText: {
    color: 'white',
    fontSize: 16,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: 'white',
    textAlign: 'center',
  },
  headerSubtitle: {
    fontSize: 16,
    color: '#bfdbfe',
    textAlign: 'center',
    marginTop: 5,
  },
  connectionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  connectionText: {
    color: 'white',
    fontSize: 14,
  },
  content: {
    flex: 1,
    padding: 20,
  },
  busSelectionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#1f2937',
    marginBottom: 10,
  },
  selectSubtitle: {
    fontSize: 16,
    color: '#6b7280',
    marginBottom: 40,
    textAlign: 'center',
  },
  busButton: {
    backgroundColor: '#3b82f6',
    width: '100%',
    maxWidth: 300,
    paddingVertical: 20,
    paddingHorizontal: 30,
    borderRadius: 15,
    marginBottom: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  busButtonText: {
    color: 'white',
    fontSize: 20,
    fontWeight: '600',
  },
  statusCard: {
    backgroundColor: 'white',
    borderRadius: 15,
    padding: 20,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  statusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
  },
  statusTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1f2937',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  activeBadge: {
    backgroundColor: '#dcfce7',
  },
  inactiveBadge: {
    backgroundColor: '#fee2e2',
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1f2937',
  },
  locationInfo: {
    paddingTop: 15,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  coordinates: {
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    color: '#6b7280',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 4,
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  controlButton: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
    marginHorizontal: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  startButton: {
    backgroundColor: '#10b981',
  },
  stopButton: {
    backgroundColor: '#ef4444',
  },
  disabledButton: {
    backgroundColor: '#d1d5db',
    opacity: 0.6,
  },
  controlButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  warningBox: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderWidth: 1,
    borderRadius: 8,
    padding: 15,
    marginBottom: 20,
    alignItems: 'center',
  },
  warningText: {
    color: '#dc2626',
    textAlign: 'center',
    fontSize: 14,
    marginBottom: 10,
  },
  retryButton: {
    backgroundColor: '#dc2626',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 6,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  instructionsCard: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
  },
  instructionsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e40af',
    marginBottom: 10,
  },
  instructionText: {
    fontSize: 14,
    color: '#1e40af',
    marginBottom: 6,
    lineHeight: 20,
  },
});