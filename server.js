const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
 require('dotenv').config();
 
 

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch((err) => console.error('MongoDB connection error:', err));

// Define a schema for the location
const locationSchema = new mongoose.Schema({
  busNumber: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  speed: { type: Number, default: 0 },
  heading: { type: Number, default: 0 },
  timestamp: { type: String, required: true }
});

const Location = mongoose.model('Location', locationSchema);
module.exports = Location;

// API endpoint to update location
app.post('/api/location', async (req, res) => {
  const { busNumber, latitude, longitude,speed, heading,timestamp } = req.body;

  try {
    const updatedLocation = await Location.findOneAndUpdate(
      { busNumber }, // Match by busNumber
      { latitude, longitude, speed, heading, timestamp }, // Update with new latitude and longitude
      { new: true, upsert: true } // Create new entry if it doesn't exist
    );
    res.status(200).json({ message: 'Location updated successfully', location: updatedLocation });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ message: 'Failed to update location' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
