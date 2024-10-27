// server.js
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const mongoose = require('mongoose');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB connected'))
    .catch((err) => console.log('MongoDB connection error:', err));

// Define User schema
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    isArcPlus: { type: Boolean, default: false },
    stripeCustomerId: String,
    stripeSubscriptionId: String
});
const User = mongoose.model('User', userSchema);

// Express session setup
app.use(session({
    secret: 'your_secret_key', // Replace with a strong secret key
    resave: false,
    saveUninitialized: true,
}));

// Login or register user
app.post('/login', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).send('Email is required');

    let user = await User.findOne({ email });
    if (!user) {
        user = await User.create({ email });
    }
    req.session.user = user;
    res.json({ message: 'Logged in', user });
});

// Create a subscription session for arc-plus
app.post('/create-payment', async (req, res) => {
    if (!req.session.user) return res.status(403).send('User not logged in');

    let user = await User.findById(req.session.user._id);
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
                unit_amount: 50, // 50 pence
                recurring: { interval: 'week' },
            },
            quantity: 1
        }],
        success_url: `${req.headers.origin}/?success=true`,
        cancel_url: `${req.headers.origin}/?canceled=true`,
    });

    await user.save();
    res.json({ id: session.id });
});

// Route for Arc-Core (GPT-4-turbo-mini)
app.post('/api/arc-core', async (req, res) => {
    if (!req.session.user) return res.status(403).send('Unauthorized');

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            { 
                model: "gpt-4-turbo-mini", 
                messages: [{ role: "user", content: req.body.prompt }],
                max_tokens: 50 
            },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).send('Arc-Core API error');
    }
});

// Route for Arc-Plus (GPT-4-turbo)
app.post('/api/arc-plus', async (req, res) => {
    const user = await User.findById(req.session.user._id);
    if (!user || !user.isArcPlus) return res.status(403).send('Arc-Plus access required');

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            { 
                model: "gpt-4-turbo", 
                messages: [{ role: "user", content: req.body.prompt }],
                max_tokens: 50 
            },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).send('Arc-Plus API error');
    }
});

// Stripe Webhook to update subscription status
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];

    try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const user = await User.findOne({ stripeCustomerId: session.customer });
            if (user) {
                user.isArcPlus = true;
                user.stripeSubscriptionId = session.subscription;
                await user.save();
            }
        } else if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            const user = await User.findOne({ stripeSubscriptionId: subscription.id });
            if (user) {
                user.isArcPlus = false;
                user.stripeSubscriptionId = null;
                await user.save();
            }
        }

        res.send({ received: true });
    } catch (err) {
        res.status(400).send(`Webhook error: ${err.message}`);
    }
});

// Serve the HTML file
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
