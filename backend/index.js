require('dotenv').config();
const express = require('express');
const cors = require('cors');
const requireAuth = require('./src/middleware/auth');
const meRouter = require('./src/routes/me');
const gmailRouter = require('./src/routes/gmail');
const invoicesRouter = require('./src/routes/invoices');
const { startScheduledScans } = require('./src/jobs/scheduler');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Backend is running' });
});

app.use('/api/me', requireAuth, meRouter);
// mounted without a blanket requireAuth (unlike /api/me) — /callback must stay
// public since Google's redirect carries no Authorization header
app.use('/api/gmail', gmailRouter);
app.use('/api/invoices', requireAuth, invoicesRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

startScheduledScans();