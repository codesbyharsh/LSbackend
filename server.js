const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// === Geo helpers ===
const calculateDistance = (c1, c2) => {
  const R = 6378137;
  const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(c2.latitude - c1.latitude);
    const dLon = toRad(c2.longitude - c1.longitude);
    const lat1 = toRad(c1.latitude);
    const lat2 = toRad(c2.latitude);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

const calculateBearing = (c1, c2) => {
  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;
  const lat1 = toRad(c1.latitude);
  const lat2 = toRad(c2.latitude);
  const dLon = toRad(c2.longitude - c1.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  let brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
};

const lowPassFilter = (curr, prev, alpha = 0.3) => {
  if (prev == null) return curr;
  return alpha * curr + (1 - alpha) * prev;
};

// Rate limiter for /location
const locationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
});

// === Mongoose setup ===
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log('Connected to MongoDB');
    seedBusNumbers();
  })
  .catch(err => console.error('MongoDB connection error:', err));

// Bus schema/model
const busSchema = new mongoose.Schema({
  busNumber: { type: String, required: true, unique: true },
  assigned: { type: Boolean, default: false },
  deviceId: { type: Number, default: null },
  username: { type: String, default: null },
});
const Bus = mongoose.model('Bus', busSchema);

// Location schema/model
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
      'EMPTY', 'MANY_SEATS_AVAILABLE', 'FEW_SEATS_AVAILABLE',
      'STANDING_ROOM_ONLY', 'CRUSHED_STANDING_ROOM_ONLY',
      'FULL', 'NOT_ACCEPTING_PASSENGERS', 'NO_DATA_AVAILABLE'
    ],
    default: 'NO_DATA_AVAILABLE'
  },
  occupancy_percentage: { type: Number, default: 0 }
});
locationSchema.index({ busNumber: 1 });
locationSchema.index({ timestamp: -1 });
const Location = mongoose.model('Location', locationSchema);

// Seed function
const initialBusNumbers = [
  "MH08AA1234", "MH08BB5678", "MH08CC9012", "MH08DD3456", "MH08EE7890",
  "MH08FF1122", "MH08GG3344", "MH08HH5566", "MH08II7788", "MH08JJ9900"
];
async function seedBusNumbers() {
  try {
    const count = await Bus.countDocuments();
    if (count === 0) {
      await Bus.insertMany(initialBusNumbers.map(n => ({ busNumber: n })));
      console.log("Seeded bus numbers");
    }
  } catch (e) {
    console.error("Seeding error:", e);
  }
}

// Middleware to process incoming location data
const processLocationData = async (req, res, next) => {
  try {
    const { busNumber, latitude, longitude, altitude = 0, timestamp } = req.body;
    const prev = await Location.findOne({ busNumber }).sort({ timestamp: -1 }).limit(1);
    if (prev) {
      // time diff in seconds
      const dt = (new Date(timestamp) - new Date(prev.timestamp)) / 1000;
      if (dt > 0) {
        // 2D ground distance (m)
        const dist2d = calculateDistance(
          { latitude: prev.latitude, longitude: prev.longitude },
          { latitude, longitude }
        );
        // 3D distance including altitude change
        const altDiff = altitude - prev.altitude;
        const dist3d = Math.sqrt(dist2d * dist2d + altDiff * altDiff);

        // compute raw speed (m/s) and bearing
        const rawSpeed   = dist3d / dt;
        const rawBearing = calculateBearing(
          { latitude: prev.latitude, longitude: prev.longitude },
          { latitude, longitude }
        );

        // low-pass filter both
        req.body.speed   = lowPassFilter(rawSpeed,   prev.speed);
        req.body.heading = lowPassFilter(rawBearing, prev.heading);
      }
    }
    next();
  } catch (e) {
    console.error('Data processing error:', e);
    next();
  }
};

// --- API Routes ---

// Get unassigned buses
app.get('/api/busNumbers', async (req, res) => {
  try {
    const buses = await Bus.find({ assigned: false });
    res.json(buses.map(b => b.busNumber));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Error fetching bus numbers' });
  }
});

// Register user to bus
app.post('/api/register', async (req, res) => {
  const { username, busNumber } = req.body;
  if (!username || !busNumber) return res.status(400).json({ message: 'Username and busNumber are required' });
  try {
    const bus = await Bus.findOne({ busNumber });
    if (!bus) return res.status(400).json({ message: 'Bus not found' });
    if (bus.assigned) return res.status(400).json({ message: 'Bus already assigned' });

    const assigned = await Bus.find({ assigned: true }).distinct('deviceId');
    const freeIds = Array.from({ length: 100 }, (_, i) => i+1).filter(i => !assigned.includes(i));
    if (!freeIds.length) return res.status(400).json({ message: 'No device IDs left' });

    bus.assigned = true;
    bus.deviceId = freeIds[Math.floor(Math.random() * freeIds.length)];
    bus.username = username;
    await bus.save();
    res.json({ username, busNumber, deviceId: bus.deviceId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Registration failed.' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ message: 'Username is required' });
  try {
    const bus = await Bus.findOne({ username });
    if (!bus?.assigned) return res.status(400).json({ message: 'No configuration found' });
    res.json({ username, busNumber: bus.busNumber, deviceId: bus.deviceId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Login failed.' });
  }
});

// Receive location updates
app.post('/api/location', locationLimiter, processLocationData, async (req, res) => {
  const { busNumber, deviceId, latitude, longitude, altitude, accuracy, speed, heading, status, timestamp } = req.body;
  try {
    const loc = await Location.findOneAndUpdate(
      { busNumber },
      { busNumber, deviceId, latitude, longitude, altitude, accuracy, speed, heading, status, timestamp },
      { upsert: true, new: true }
    );
    res.json({ message: 'Location updated', location: loc });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to update location' });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
