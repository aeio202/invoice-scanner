require('dotenv').config();
const express = require('express');
const cors = require('cors');
const requireAuth = require('./src/middleware/auth');
const meRouter = require('./src/routes/me');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Backend is running' });
});

app.use('/api/me', requireAuth, meRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));