const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Base schema for bus data
const baseBusSchema = {
  busId: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  speed: { type: Number, default: 0 },
  heading: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
  accuracy: { type: Number, default: 0 }
};

// Separate schemas for each bus
const bus1LocationSchema = new mongoose.Schema(baseBusSchema);
const bus2LocationSchema = new mongoose.Schema(baseBusSchema);

// Status schema for tracking active trips
const busStatusSchema = new mongoose.Schema({
  busId: { type: String, required: true, unique: true },
  status: { 
    type: String, 
    enum: ['active', 'inactive', 'offline'], 
    default: 'offline' 
  },
  tripStarted: { type: Date },
  tripEnded: { type: Date },
  lastLocationUpdate: { type: Date },
  driverSocketId: { type: String }
});

// Create separate models for each bus
const Bus1Location = mongoose.model('Bus1Location', bus1LocationSchema, 'bus1_locations');
const Bus2Location = mongoose.model('Bus2Location', bus2LocationSchema, 'bus2_locations');

// Status models for each bus
const Bus1Status = mongoose.model('Bus1Status', busStatusSchema, 'bus1_status');
const Bus2Status = mongoose.model('Bus2Status', busStatusSchema, 'bus2_status');

// Helper function to get the correct models based on busId
function getBusModels(busId) {
  switch (busId) {
    case 'IITJ_BUS_01':
      return { LocationModel: Bus1Location, StatusModel: Bus1Status };
    case 'IITJ_BUS_02':
      return { LocationModel: Bus2Location, StatusModel: Bus2Status };
    default:
      throw new Error(`Unknown bus ID: ${busId}`);
  }
}

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/iitj-bus')
  .then(() => {
    console.log('Connected to MongoDB successfully');
    initializeBusStatuses();
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
  });

// Initialize bus statuses on server start
async function initializeBusStatuses() {
  try {
    // Initialize Bus 1 status if not exists
    await Bus1Status.findOneAndUpdate(
      { busId: 'IITJ_BUS_01' },
      { busId: 'IITJ_BUS_01', status: 'offline' },
      { upsert: true, setDefaultsOnInsert: true }
    );
    
    // Initialize Bus 2 status if not exists
    await Bus2Status.findOneAndUpdate(
      { busId: 'IITJ_BUS_02' },
      { busId: 'IITJ_BUS_02', status: 'offline' },
      { upsert: true, setDefaultsOnInsert: true }
    );
    
    console.log('Bus statuses initialized');
  } catch (error) {
    console.error('Error initializing bus statuses:', error);
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Driver connected:', socket.id);

  socket.on('busLocationUpdate', async (data) => {
    console.log('Location update received:', data);
    
    try {
      const { LocationModel, StatusModel } = getBusModels(data.busId);
      
      // Save location to appropriate collection
      const location = new LocationModel(data);
      await location.save();
      
      // Update bus status with last location update time
      await StatusModel.findOneAndUpdate(
        { busId: data.busId },
        { 
          lastLocationUpdate: new Date(),
          driverSocketId: socket.id,
          status: 'active'
        },
        { upsert: true }
      );
      
      // Broadcast to all connected clients (student apps)
      socket.broadcast.emit('busLocationUpdate', data);
      
      // Send confirmation back to driver
      socket.emit('locationSaved', { 
        success: true, 
        busId: data.busId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Error saving location for', data.busId, ':', error);
      socket.emit('locationSaved', { 
        success: false, 
        error: error.message,
        busId: data.busId
      });
    }
  });

  socket.on('tripStarted', async (data) => {
    console.log('Trip started:', data);
    
    try {
      const { StatusModel } = getBusModels(data.busId);
      
      await StatusModel.findOneAndUpdate(
        { busId: data.busId },
        { 
          status: 'active',
          tripStarted: new Date(),
          tripEnded: null,
          driverSocketId: socket.id
        },
        { upsert: true }
      );
      
      socket.broadcast.emit('tripStarted', data);
      console.log(`Trip started for ${data.busId}`);
      
    } catch (error) {
      console.error('Error starting trip for', data.busId, ':', error);
    }
  });

  socket.on('tripEnded', async (data) => {
    console.log('Trip ended:', data);
    
    try {
      const { StatusModel } = getBusModels(data.busId);
      
      await StatusModel.findOneAndUpdate(
        { busId: data.busId },
        { 
          status: 'inactive',
          tripEnded: new Date()
        }
      );
      
      socket.broadcast.emit('tripEnded', data);
      console.log(`Trip ended for ${data.busId}`);
      
    } catch (error) {
      console.error('Error ending trip for', data.busId, ':', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Driver disconnected:', socket.id);
    
    // Mark buses as offline for this socket
    updateBusStatusOnDisconnect(socket.id);
  });
});

// Update bus status when driver disconnects
async function updateBusStatusOnDisconnect(socketId) {
  try {
    // Check both bus status collections for this socket
    await Bus1Status.updateOne(
      { driverSocketId: socketId },
      { status: 'offline', driverSocketId: null }
    );
    
    await Bus2Status.updateOne(
      { driverSocketId: socketId },
      { status: 'offline', driverSocketId: null }
    );
    
  } catch (error) {
    console.error('Error updating bus status on disconnect:', error);
  }
}

// REST API endpoints
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'IITJ Bus Tracking Server with Separate Collections'
  });
});

// Get all buses status
app.get('/api/buses/status', async (req, res) => {
  try {
    const bus1Status = await Bus1Status.findOne({ busId: 'IITJ_BUS_01' });
    const bus2Status = await Bus2Status.findOne({ busId: 'IITJ_BUS_02' });
    
    res.json({
      success: true,
      buses: {
        'IITJ_BUS_01': bus1Status || { busId: 'IITJ_BUS_01', status: 'offline' },
        'IITJ_BUS_02': bus2Status || { busId: 'IITJ_BUS_02', status: 'offline' }
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get locations for a specific bus
app.get('/api/bus/:busId/locations', async (req, res) => {
  try {
    const { busId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const { LocationModel } = getBusModels(busId);
    
    const locations = await LocationModel.find({ busId })
      .sort({ timestamp: -1 })
      .limit(limit);
    
    res.json({
      success: true,
      busId,
      count: locations.length,
      locations
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get latest location for a specific bus
app.get('/api/bus/:busId/latest', async (req, res) => {
  try {
    const { busId } = req.params;
    
    const { LocationModel, StatusModel } = getBusModels(busId);
    
    const [latestLocation, busStatus] = await Promise.all([
      LocationModel.findOne({ busId }).sort({ timestamp: -1 }),
      StatusModel.findOne({ busId })
    ]);
    
    res.json({
      success: true,
      busId,
      location: latestLocation,
      status: busStatus || { busId, status: 'offline' }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'IITJ Bus Tracking Server - Separate Collections',
    version: '2.0.0',
    features: ['Separate bus collections', 'Independent status tracking'],
    endpoints: {
      health: '/api/health',
      busesStatus: '/api/buses/status',
      busLocations: '/api/bus/:busId/locations',
      busLatest: '/api/bus/:busId/latest'
    },
    collections: {
      bus1: ['bus1_locations', 'bus1_status'],
      bus2: ['bus2_locations', 'bus2_status']
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`IITJ Bus Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Bus statuses: http://localhost:${PORT}/api/buses/status`);
  console.log('Socket.io ready for connections');
  console.log('Separate collections: bus1_locations, bus1_status, bus2_locations, bus2_status');
});