
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

// MongoDB Schema
const busLocationSchema = new mongoose.Schema({
  busId: String,
  latitude: Number,
  longitude: Number,
  speed: Number,
  heading: Number,
  timestamp: Date,
  accuracy: Number
});

const BusLocation = mongoose.model('BusLocation', busLocationSchema);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/iitj-bus');

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Driver connected:', socket.id);

  socket.on('busLocationUpdate', async (data) => {
    console.log('Location update received:', data);
    
    try {
      // Save to database
      const location = new BusLocation(data);
      await location.save();
      
      // Broadcast to all connected clients (student apps)
      socket.broadcast.emit('busLocationUpdate', data);
      
      // Send confirmation back to driver
      socket.emit('locationSaved', { success: true });
    } catch (error) {
      console.error('Error saving location:', error);
      socket.emit('locationSaved', { success: false, error: error.message });
    }
  });

  socket.on('tripStarted', (data) => {
    console.log('Trip started:', data);
    socket.broadcast.emit('tripStarted', data);
  });

  socket.on('tripEnded', (data) => {
    console.log('Trip ended:', data);
    socket.broadcast.emit('tripEnded', data);
  });

  socket.on('disconnect', () => {
    console.log('Driver disconnected:', socket.id);
  });
});

// REST API endpoints
app.get('/api/buses', async (req, res) => {
  try {
    const locations = await BusLocation.find()
      .sort({ timestamp: -1 })
      .limit(100);
    res.json(locations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bus/:busId/latest', async (req, res) => {
  try {
    const location = await BusLocation.findOne({ busId: req.params.busId })
      .sort({ timestamp: -1 });
    res.json(location);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
