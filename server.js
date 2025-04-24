// server.js
const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app   = express();
app.set('trust proxy', 1);
const PORT  = process.env.PORT || 5000;
const SPEED_THRESHOLD = 1;   // m/s

app.use(cors());
app.use(express.json());

// === Rate limiter for /api/location ===
const locationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max:     1200,            // max requests per IP per window
});

// === Mongoose setup ===
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB error:', err));

// --- Schemas ---
// Bus schema unchanged
const busSchema = new mongoose.Schema({
  busNumber: { type: String, required: true, unique: true },
  assigned:  { type: Boolean, default: false },
  deviceId:  { type: Number, default: null },
  username:  { type: String, default: null },
});
const Bus = mongoose.model('Bus', busSchema);

// Location schema: history now strictly last 3 fixes
const locationSchema = new mongoose.Schema({
  busNumber:   { type: String, required: true },
  deviceId:    { type: Number, required: true },
  latitude:    { type: Number, required: true },
  longitude:   { type: Number, required: true },
  altitude:    { type: Number, default: 0 },
  accuracy:    { type: Number, default: 5 },
  speed:       { type: Number, default: 0 },
  heading:     { type: Number, default: null },
  status:      { type: String, enum: ['moving','stopped'], default: 'stopped' },
  timestamp:   { type: String, required: true },

  // history: last 3 fixes
  history: [
    {
      latitude:  Number,
      longitude: Number,
      altitude:  Number,
      accuracy:  Number,
      speed:     Number,
      heading:   Number,
      status:    String,
      timestamp: String
    }
  ],

  trip_id:      { type: String, default: '' },
  route_id:     { type: String, default: '' },
  direction_id: { type: String, default: '' }
});
locationSchema.index({ busNumber: 1 });
locationSchema.index({ timestamp: -1 });
const Location = mongoose.model('Location', locationSchema);

// === Helper: Haversine distance (m) between two {latitude,longitude} points
function haversine(c1, c2) {
  const R = 6378137;
  const toRad = d => d * Math.PI/180;
  const dLat = toRad(c2.latitude - c1.latitude);
  const dLon = toRad(c2.longitude - c1.longitude);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(c1.latitude))*Math.cos(toRad(c2.latitude))*
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// === Seed bus numbers if empty ===
const initialBusNumbers = [
  "MH08AA1234","MH08BB5678","MH08CC9012","MH08DD3456","MH08EE7890",
  "MH08FF1122","MH08GG3344","MH08HH5566","MH08II7788","MH08JJ9900"
];
async function seedBusNumbers() {
  const count = await Bus.countDocuments();
  if (count === 0) {
    await Bus.insertMany(initialBusNumbers.map(n=>({busNumber:n})));
    console.log("Seeded bus numbers");
  }
}
seedBusNumbers();

// --- API Routes ---
// ... (busNumbers, register, login as before) ...

// Receive one live fix, maintain 3-window & recompute speed
app.post(
  '/api/location',
  locationLimiter,
  async (req, res) => {
    const {
      busNumber, deviceId,
      latitude, longitude, altitude,
      accuracy, heading, status, timestamp
    } = req.body;

    try {
      // Upsert + push new fix into history, keep only last 3 entries
      let loc = await Location.findOneAndUpdate(
        { busNumber },
        {
          $set: {
            deviceId, latitude, longitude, altitude,
            accuracy, heading, status, timestamp
              // ensure direction_id stays empty
         , direction_id: ''
          },
          $push: {
            history: {
              $each: [{
                latitude, longitude, timestamp
              }],
              $slice: -3
            }
          }
        },
        { upsert: true, new: true }
      );

      // Recalculate speed using oldest → latest in history
      if (loc.history.length >= 2) {
        const first = loc.history[0];
        const last  = loc.history[loc.history.length - 1];
        const dist  = haversine(first, last);
        const dt    = (new Date(last.timestamp) - new Date(first.timestamp)) / 1000;
        const sp    = dt > 0 ? dist / dt : 0;

        loc.speed  = sp;
        loc.status = sp > SPEED_THRESHOLD ? 'moving' : 'stopped';
        await loc.save();
      }

 res.json({ message: 'Location updated', location: loc });

    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Failed to update location' });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
