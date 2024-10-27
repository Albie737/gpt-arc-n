const express = require('express');
const session = require('express-session');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Set up SQLite database
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) return console.error(err.message);
    console.log('Connected to the SQLite database.');

    // Create Users table
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            email TEXT PRIMARY KEY,
            isArcPlus INTEGER DEFAULT 0,
            stripeCustomerId TEXT,
            stripeSubscriptionId TEXT
        )
    `);
});

// Express session setup
app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: true,
}));

// Helper function to get user from DB
const getUserByEmail = (email) => new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
        if (err) return reject(err);
        resolve(row);
    });
});

// Helper function to save/update user in DB
const saveUser = (user) => new Promise((resolve, reject) => {
    db.run(`
        INSERT INTO users (email, isArcPlus, stripeCustomerId, stripeSubscriptionId)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
            isArcPlus = excluded.isArcPlus,
            stripeCustomerId = excluded.stripeCustomerId,
            stripeSubscriptionId = excluded.stripeSubscriptionId
    `, [user.email, user.isArcPlus, user.stripeCustomerId, user.stripeSubscriptionId], (err) => {
        if (err) return reject(err);
        resolve();
    });
});

// Login or register user
app.post('/login', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send('Email is required');

    let user = await getUserByEmail(email);
    if (!user) {
        user = { email, isArcPlus: 0 };
        await saveUser(user);
    }
    req.session.user = user;
    res.json({ message: 'Logged in', user });
});

// Create a subscription session for arc-plus
app.post('/create-payment', async (req, res) => {
    if (!req.session.user) return res.status(403).send('User not logged in');

    const user = await getUserByEmail(req.session.user.email);
    if (user.isArcPlus) return res.status(400).send('Already subscribed');

    // Create Stripe customer if not exists
    if (!user.stripeCustomerId) {
        const customer = await stripe.customers.create({ email: user.email });
        user.stripeCustomerId = customer.id;
    }

    // Create subscription session for Stripe checkout
    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer: user.stripeCustomerId,
        line_items: [{
            price_data: {
                currency: 'gbp',
                product_data: { name: 'arc-plus Access' },
                unit_amount: 50,
                recurring: { interval: 'week' },
            },
            quantity: 1
        }],
        success_url: `${req.headers.origin}/?success=true`,
        cancel_url: `${req.headers.origin}/?canceled=true`,
    });

    // Save session details to user
    await saveUser(user);
    res.json({ id: session.id });
});

// Route for Arc-Core (GPT-4-turbo-mini)
app.post('/api/arc-core', async (req, res) => {
    if (!req.session.user) return res.status(403).send('Unauthorized');

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/engines/gpt-4-turbo-mini/completions',
            { prompt: req.body.prompt, max_tokens: 50 },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).send('Arc-Core API error');
    }
});

// Route for Arc-Plus (GPT-4-turbo)
app.post('/api/arc-plus', async (req, res) => {
    const user = await getUserByEmail(req.session.user.email);
    if (!user || !user.isArcPlus) return res.status(403).send('Arc-Plus access required');

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/engines/gpt-4-turbo/completions',
            { prompt: req.body.prompt, max_tokens: 50 },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).send('Arc-Plus API error');
    }
});

// Serve the HTML file
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
