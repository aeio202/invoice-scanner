const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
});

module.exports = router;
