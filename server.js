const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log('Connected to MongoDB');
    // Seed the bus numbers after connection
    seedBusNumbers();
  })
  .catch((err) => console.error('MongoDB connection error:', err));

// --- Define Schemas and Models ---

// Bus schema: holds the bus number and (once registered) the assigned username and deviceId.
const busSchema = new mongoose.Schema({
  busNumber: { type: String, required: true, unique: true },
  assigned: { type: Boolean, default: false },
  deviceId: { type: Number, default: null },
  username: { type: String, default: null },
});

const Bus = mongoose.model('Bus', busSchema);

// Location schema
const locationSchema = new mongoose.Schema({
  busNumber: { type: String, required: true },
  deviceId: { type: Number, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  altitude: { type: Number, default: 0 },
  accuracy: { type: Number, default: 5 },
  speed: { type: Number, default: 0 },
  heading: { type: Number, default: 0 },
  status: { type: String, enum: ['moving', 'stopped'], default: 'stopped' },
  timestamp: { type: String, required: true },
  trip_id: { type: String, default: '' },
  route_id: { type: String, default: '' },
  direction_id: { type: Number, enum: [0, 1], default: 0 },
  occupancy_status: { 
    type: String, 
    enum: [
      'EMPTY',
      'MANY_SEATS_AVAILABLE',
      'FEW_SEATS_AVAILABLE',
      'STANDING_ROOM_ONLY',
      'CRUSHED_STANDING_ROOM_ONLY',
      'FULL',
      'NOT_ACCEPTING_PASSENGERS',
      'NO_DATA_AVAILABLE'
    ],
    default: 'NO_DATA_AVAILABLE' 
  },
  occupancy_percentage: { type: Number, default: 0 }
});

const Location = mongoose.model('Location', locationSchema);

// --- Seed Bus Numbers if Collection is Empty ---
const initialBusNumbers = [
  "MH08AA1234", "MH08BB5678", "MH08CC9012", "MH08DD3456", "MH08EE7890",
  "MH08FF1122", "MH08GG3344", "MH08HH5566", "MH08II7788", "MH08JJ9900"
];

async function seedBusNumbers() {
  try {
    const count = await Bus.countDocuments({});
    if (count === 0) {
      await Bus.insertMany(initialBusNumbers.map(num => ({ busNumber: num })));
      console.log("Bus collection seeded with 10 buses");
    }
  } catch (err) {
    console.error("Error seeding bus collection", err);
  }
}

// --- API Endpoints ---

// GET endpoint to retrieve only available (unassigned) bus numbers
app.get('/api/busNumbers', async (req, res) => {
  try {
    const availableBuses = await Bus.find({ assigned: false });
    const busNumbers = availableBuses.map(bus => bus.busNumber);
    res.status(200).json(busNumbers);
  } catch (err) {
    console.error('Error fetching bus numbers:', err);
    res.status(500).json({ message: 'Error fetching bus numbers' });
  }
});

// Registration endpoint: expects { username, busNumber }
app.post('/api/register', async (req, res) => {
  const { username, busNumber } = req.body;
  if (!username || !busNumber) {
    return res.status(400).json({ message: 'Username and busNumber are required' });
  }

  try {
    // Find the bus document by busNumber
    const bus = await Bus.findOne({ busNumber });
    if (!bus) {
      return res.status(400).json({ message: 'Bus number not found' });
    }
    if (bus.assigned) {
      return res.status(400).json({ message: 'Bus number already configured' });
    }

    // Get all assigned device IDs
    const assignedDevices = await Bus.find({ assigned: true }).distinct('deviceId');
    const availableDeviceIds = Array.from({ length: 100 }, (_, i) => i + 1)
      .filter(id => !assignedDevices.some(a => Number(a) === id));

    if (availableDeviceIds.length === 0) {
      return res.status(400).json({ message: 'No available device IDs' });
    }

    const assignedDeviceId = availableDeviceIds[Math.floor(Math.random() * availableDeviceIds.length)];
    bus.assigned = true;
    bus.deviceId = assignedDeviceId;
    bus.username = username;
    await bus.save();

    res.status(200).json({ username, busNumber, deviceId: assignedDeviceId });
  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({ message: 'Registration failed.' });
  }
});

// Login endpoint: expects { username } and returns configuration (username, busNumber, deviceId)
app.post('/api/login', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ message: 'Username is required' });
  }
  try {
    const bus = await Bus.findOne({ username });
    if (!bus || !bus.assigned) {
      return res.status(400).json({ message: 'No configuration found for this username' });
    }
    res.status(200).json({ username, busNumber: bus.busNumber, deviceId: bus.deviceId });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ message: 'Login failed.' });
  }
});

// API endpoint to update location
app.post('/api/location', async (req, res) => {
  const { busNumber, deviceId, latitude, longitude, altitude, accuracy, speed, heading, timestamp } = req.body;
  if (!busNumber || !deviceId || latitude === undefined || longitude === undefined || !timestamp) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  const status = speed && speed > 0 ? 'moving' : 'stopped';
  try {
    const updatedLocation = await Location.findOneAndUpdate(
      { busNumber },
      { busNumber, deviceId, latitude, longitude, altitude, accuracy, speed, heading, status, timestamp },
      { new: true, upsert: true }
    );
    res.status(200).json({ message: 'Location updated successfully', location: updatedLocation });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ message: 'Failed to update location' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
