const Anthropic = require('@anthropic-ai/sdk');

// Zero-arg constructor reads ANTHROPIC_API_KEY from backend/.env automatically
// (already present — no code-level key handling needed).
const anthropic = new Anthropic();

module.exports = anthropic;
